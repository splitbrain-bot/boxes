import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { promisify } from 'node:util';

/**
 * Git repositories that agent sets take skills from: fetching one into a
 * checkout under DATA_DIR, and finding the skills in that checkout.
 *
 * Git runs in the orchestrator here. A fetched repository cannot make it run
 * a program, because no configuration of the repository reaches git.
 */

const run = promisify(execFile);

/** Where the checkouts are kept, under DATA_DIR. */
const REPOS_SUBDIR = 'skill-repos';

/** How long one git invocation may take before it is killed. */
const GIT_TIMEOUT_MS = 5 * 60_000;

/** How deep the skill search descends below the checkout's root. */
const MAX_DEPTH = 8;

/** Directories the skill search does not enter. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** One skill found in a checkout. */
export interface RepoSkill {
  /** The name the skill is installed under. */
  name: string;
  /** The skill's directory, relative to the checkout, '' for its root. */
  path: string;
}

/**
 * Fetches a repository into its checkout and returns the commit. The
 * credential is chosen already.
 */
export type RepoFetcher = (
  dir: string,
  url: string,
  ref: string,
  keep: () => boolean,
) => Promise<string>;

/** The directory of one repository, as this process sees it. */
export function repoDir(dataDir: string, repoId: string): string {
  return join(dataDir, REPOS_SUBDIR, repoId);
}

/** The current checkout of one repository. Absent before the first good pull. */
export function repoTree(dataDir: string, repoId: string): string {
  return join(repoDir(dataDir, repoId), 'tree');
}

/** The ids of every repository that has a directory. */
export function repoDirIds(dataDir: string): string[] {
  const root = join(dataDir, REPOS_SUBDIR);
  if (!existsSync(root)) return [];
  return readdirSync(root);
}

/**
 * Fetches one commit of a repository and makes it the current checkout.
 *
 * The fetch is shallow and goes into a new git directory each time, so no
 * history accumulates. The files are checked out next to the current
 * checkout and replace it in one synchronous step, so a box start that copies
 * from it never sees half of a pull.
 *
 * @param dir The repository's directory.
 * @param url The HTTPS URL to fetch.
 * @param ref The branch, tag or full commit hash, or '' for the default branch.
 * @param token A GitHub token sent to github.com only, or null.
 * @param keep Asked after the fetch. When it returns false, the repository
 *   was removed meanwhile and its directory is deleted instead.
 * @returns The commit hash that was checked out.
 */
export async function fetchRepo(
  dir: string,
  url: string,
  ref: string,
  token: string | null,
  keep: () => boolean,
): Promise<string> {
  const gitDir = join(dir, 'git.new');
  const next = join(dir, 'tree.new');
  rmSync(gitDir, { recursive: true, force: true });
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });

  const env = gitEnv(url, token);
  const git = (...args: string[]) =>
    run('git', ['--git-dir', gitDir, '-c', 'core.hooksPath=/dev/null', ...args], {
      env,
      timeout: GIT_TIMEOUT_MS,
    });
  try {
    // No template and no hooks path, so no hook can run.
    await git('init', '--quiet', '--bare', '--template=');
    await git('fetch', '--quiet', '--depth', '1', '--no-tags', '--', url, ref || 'HEAD');
    const { stdout } = await git('rev-parse', 'FETCH_HEAD^{commit}');
    await git('--work-tree', next, 'checkout', '--quiet', '--force', 'FETCH_HEAD', '--', '.');
    if (!keep()) {
      rmSync(dir, { recursive: true, force: true });
      return stdout.trim();
    }
    const tree = join(dir, 'tree');
    rmSync(tree, { recursive: true, force: true });
    renameSync(next, tree);
    return stdout.trim();
  } catch (err) {
    throw new Error(gitError(err));
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(next, { recursive: true, force: true });
  }
}

/**
 * The environment of one git invocation.
 *
 * Git must never wait at a prompt, and neither the system's nor a user's git
 * configuration applies. The token goes in as configuration through the
 * environment, so it is not on a command line, and is scoped to github.com.
 */
function gitEnv(url: string, token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
  };
  if (token && new URL(url).hostname === 'github.com') {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = 'http.https://github.com/.extraheader';
    env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`;
  }
  return env;
}

/** The last line git wrote to stderr, which names the cause, or the error's own message. */
function gitError(err: unknown): string {
  const e = err as { stderr?: string; killed?: boolean; message?: string };
  if (e.killed) return 'git took too long and was stopped';
  const lines = (e.stderr ?? '').trim().split('\n').filter((l) => l.trim() !== '');
  return lines.at(-1) ?? e.message ?? String(err);
}

/**
 * Finds the skills in a checkout: every directory that holds a SKILL.md.
 *
 * The search goes breadth first and in name order, and does not descend into
 * a skill or follow a link. When two skills have the same name, the shallower
 * one wins.
 *
 * @param tree The checkout.
 * @param rootName The name for a SKILL.md at the checkout's root.
 * @param valid Accepts the names that may be installed. Others are skipped.
 * @param max The most skills to return.
 */
export function findSkills(
  tree: string,
  rootName: string,
  valid: (name: string) => boolean,
  max: number,
): RepoSkill[] {
  const found = new Map<string, RepoSkill>();
  let level = [''];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const below: string[] = [];
    for (const rel of level) {
      const entries = readdirSync(join(tree, rel), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
        const name = (rel === '' ? rootName : basename(rel)).toLowerCase();
        if (valid(name) && !found.has(name)) found.set(name, { name, path: rel });
        if (found.size >= max) return [...found.values()];
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
          below.push(rel === '' ? entry.name : posix.join(rel, entry.name));
        }
      }
    }
    level = below;
  }
  return [...found.values()];
}

/** The last path segment of a repository URL without `.git`, the name of a skill at its root. */
export function repoName(url: string): string {
  const last = new URL(url).pathname.split('/').filter((p) => p !== '').at(-1) ?? '';
  return last.replace(/\.git$/, '');
}
