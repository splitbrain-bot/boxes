import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  setGitRunnerForTests,
  type GitRunner,
} from '../../orchestrator/src/review/git.ts';

/**
 * A box's workspace on disk, which is what the review reads.
 *
 * The orchestrator reviews the files of a workspace directly and asks git
 * about them inside the box's container. There is no container here, so
 * git runs on this machine over the same directory — which is the seam
 * `setGitRunnerForTests` exists for — and the fixtures below build the
 * repositories it answers about.
 */

/** A workspace as a test wants it: files, history and repositories. */
export interface WorkspaceSpec {
  /** The working tree, by workspace-relative path. */
  files: Record<string, string>;
  /**
   * What the repositories hold at HEAD, by the same paths. Defaults to
   * `files`, which is a checkout nobody has touched yet; a path that differs
   * is a modified file and one that is missing is an untracked one.
   */
  committed?: Record<string, string>;
  /** Committed paths the working tree no longer has: the deleted files. */
  deleted?: string[];
  /** Which directories are git repositories, by workspace-relative path. */
  repos?: string[];
  /** Extra branches to create, by the repository that gets them. */
  branches?: Record<string, string[]>;
}

/**
 * The workspace the review tests browse: two projects side by side and a
 * loose directory beside them.
 *
 * That is the shape the review is designed around — the review is over the
 * workspace rather than over one repository — so it is the one the browser
 * walks. `app` holds a modified file, `lib` an untracked one, and `notes`
 * belongs to no repository at all.
 */
export function reviewWorkspace(over: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  const files: Record<string, string> = {
    'app/src/app.ts': 'import { boot } from "./boot";\n\nboot();\n',
    'app/src/boot.ts':
      'export function boot(): void {\n  // TODO: wire the router\n  console.log("up");\n}\n',
    'app/README.md': '# demo\n\nA project the agent cloned.\n',
    'lib/README.md': '# lib\n\nThe other project.\n',
    'lib/index.ts': 'export const version = "1.0.0";\n',
    // Outside every repository: no .gitignore has said what is noise here,
    // so it shows, and it has no status and no diff.
    'notes/todo.txt': 'plain text, no grammar\n',
  };
  return {
    files,
    committed: {
      'app/src/app.ts': files['app/src/app.ts']!,
      // Two shapes in one file, which is what the gutter draws: a line
      // replaced by two, and a block at the end removed and put nowhere. The
      // second is the only thing a deletion marker comes from, because an
      // added line after a removed one makes the pair a change instead.
      'app/src/boot.ts':
        'export function boot(): void {\n  console.log("boot");\n}\n' +
        '// the old entry point, kept while the router is wired\nconst legacyBoot = boot;\n',
      'app/README.md': files['app/README.md']!,
      'lib/README.md': files['lib/README.md']!,
    },
    deleted: [],
    repos: ['app', 'lib'],
    branches: { app: ['only-app'] },
    ...over,
  };
}

/** Runs git in a directory with the ambient binary. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/** Writes a file, creating the directories above it. */
function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * Builds a workspace from a spec, replacing whatever was there.
 *
 * The history is made by committing `committed` and then moving the working
 * tree to `files`, so every status the review reports is one real git worked
 * out rather than one the fixture declared.
 */
export function buildWorkspace(root: string, spec: WorkspaceSpec): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const repos = spec.repos ?? [];
  const committed = spec.committed ?? spec.files;
  const deleted = spec.deleted ?? [];

  for (const repo of repos) {
    const dir = join(root, repo);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
  }

  for (const [path, content] of Object.entries(committed)) write(root, path, content);
  // A deleted file has to exist before it can be removed, and its content is
  // never read back.
  for (const path of deleted) write(root, path, 'gone\n');
  for (const repo of repos) {
    const dir = join(root, repo);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    for (const branch of spec.branches?.[repo] ?? []) git(dir, 'branch', branch);
  }

  for (const path of [...Object.keys(committed), ...deleted]) {
    if (!(path in spec.files)) rmSync(join(root, path), { force: true });
  }
  for (const [path, content] of Object.entries(spec.files)) write(root, path, content);
}

/**
 * The box a container id belongs to, which is how a git invocation finds
 * the workspace it is addressed at.
 *
 * Every box container is named after its box, so the name carries the
 * mapping and nothing has to be looked up.
 */
function boxOfContainer(containerId: string): string {
  return containerId.startsWith('box-') ? containerId.slice('box-'.length) : '';
}

/**
 * Runs review's git here, in the host directory a container path names.
 *
 * A workspace is at `/workspace` inside a box, and the container id names the
 * box, so the two together say which directory on this machine an
 * invocation means. One addressed anywhere else fails rather than running.
 */
export function installLocalGit(workspaceOf: (boxId: string) => string): void {
  const runner: GitRunner = async (target, argv, env) => {
    const root = workspaceOf(boxOfContainer(target.containerId));
    const inside = target.dir === '/workspace' || target.dir.startsWith('/workspace/');
    const cwd = join(root, target.dir.slice('/workspace'.length));
    if (!inside || !existsSync(cwd)) {
      return { ok: false, stdout: '', stderr: 'misaddressed', code: null };
    }
    try {
      const stdout = execFileSync(argv[0]!, argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { ok: true, stdout, stderr: '', code: 0 };
    } catch (err) {
      const failed = err as { status?: number | null; stdout?: string; stderr?: string };
      return {
        ok: false,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
        code: failed.status ?? null,
      };
    }
  };
  setGitRunnerForTests(runner);
}

/** Puts the shipped git runner back. */
export function removeLocalGit(): void {
  setGitRunnerForTests(null);
}
