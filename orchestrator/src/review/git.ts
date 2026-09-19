import * as dk from '../docker.ts';
import { log } from '../log.ts';

/**
 * The one place review starts a git process.
 *
 * Git runs inside the session's own container, as the agent user, over the
 * agent's own files — never in this process. A repository's configuration can
 * make git run a command on exactly the operations review runs: a clean filter
 * on `diff`, an fsmonitor hook on `status`. Inside the box that command is one
 * the agent could have run anyway, and there is nothing to defend. Outside it
 * would be code execution in the process holding the Docker socket.
 *
 * So the only address a git invocation has is a {@link GitTarget}: a container
 * and a directory inside it. Everything else — the argv, the environment, the
 * runner that reaches the daemon — is built here and cannot be passed in.
 *
 * Everything run through here reads. Nothing fetches, pushes or resolves a
 * remote.
 */

/** A session's container and the workspace inside it: where review runs git. */
export interface GitBox {
  /** The running container git is executed in. */
  containerId: string;
  /** The workspace root, as the container names it. */
  workspaceDir: string;
}

/** The container and the directory one git invocation runs in. */
export interface GitTarget {
  /** The running container git is executed in. */
  containerId: string;
  /** The directory git runs in, as the container names it. */
  dir: string;
}

/**
 * The flags every git invocation carries, ahead of the subcommand.
 *
 * `core.quotepath=false` keeps a non-ASCII path unquoted, which is what the
 * parsers here expect and what makes git's paths the paths the file tree
 * reports. It is a requirement of reading the output, not a defence: the
 * repository's own configuration is the agent's to write either way.
 */
function gitFlags(): string[] {
  return ['-c', 'core.quotepath=false'];
}

/**
 * The variables every git invocation adds to the container's own environment.
 *
 * - `GIT_OPTIONAL_LOCKS=0` — every invocation here only reads, and refreshing
 *   the index would take a lock the agent's own git then waits behind.
 * - `GIT_LITERAL_PATHSPECS=1` — a pathspec is a path, not a glob: a filename
 *   holding `*`, `?` or `[` would otherwise make `-- path` match files nobody
 *   asked about.
 * - `GIT_TERMINAL_PROMPT=0` — nothing here talks to a remote, and one that
 *   somehow did would fail rather than sit at a prompt until the timeout.
 * - `LC_ALL=C` — one language for what git writes, whatever the box is set to.
 */
export function gitEnv(): Record<string, string> {
  return {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * Diff flags the parser needs.
 *
 * What it reads is git's own unified diff over the file's own bytes: an
 * external diff driver or a textconv filter would hand it something else
 * entirely, and colour would only corrupt the parse.
 */
export const DIFF_PARSE_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;

/**
 * The whole command line one invocation runs: git, the flags every invocation
 * carries, and the subcommand with its own arguments.
 *
 * The diff parse flags are added to every `diff` here rather than at the call
 * sites, so a diff written later cannot be the one that leaves them out.
 */
export function gitArgv(args: string[]): string[] {
  const sub = args[0] === 'diff' ? ['diff', ...DIFF_PARSE_FLAGS, ...args.slice(1)] : args;
  return ['git', ...gitFlags(), ...sub];
}

/** How long a single git invocation may take before it is killed. */
const TIMEOUT_MS = 20_000;

/** How much output a single git invocation may produce. */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** What a git invocation produced. */
export interface GitResult {
  /** True when git exited 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Null when git was killed before reporting one. */
  code: number | null;
}

/**
 * Starts one git command and reports what it produced.
 *
 * The seam a test replaces: the default reaches into a session container, and
 * a suite that has no Docker substitutes a runner of its own.
 */
export type GitRunner = (
  target: GitTarget,
  argv: string[],
  env: Record<string, string>,
) => Promise<GitResult>;

/** The runner review ships with: one exec in the session container. */
const inSessionContainer: GitRunner = async (target, argv, env) => {
  const result = await dk.execInContainer(target.containerId, argv, {
    workingDir: target.dir,
    env,
    timeoutMs: TIMEOUT_MS,
    maxOutput: MAX_OUTPUT,
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
};

/** Where git is started. Replaced only by a test. */
let runner: GitRunner = inSessionContainer;

/** Replaces the runner that starts git. Null puts the shipped one back. */
export function setGitRunnerForTests(next: GitRunner | null): void {
  runner = next ?? inSessionContainer;
}

/**
 * Runs one git subcommand in a repository and returns its output.
 *
 * `args` is the subcommand and its own arguments. A non-zero exit is a result
 * rather than a throw, because most callers have a meaningful answer for it:
 * "this is not a repository", "this revision is unknown", "there is no diff".
 * A container that cannot be reached is the same kind of answer, so a box that
 * went away leaves a review without git rather than without a response.
 */
export async function git(target: GitTarget, args: string[]): Promise<GitResult> {
  try {
    return await runner(target, gitArgv(args), gitEnv());
  } catch (err) {
    log.warn('git invocation failed', { args: args[0], error: (err as Error).message });
    return { ok: false, stdout: '', stderr: '', code: null };
  }
}

/** The output of a git invocation, or '' when it failed. */
export async function gitOut(target: GitTarget, args: string[]): Promise<string> {
  const result = await git(target, args);
  return result.ok ? result.stdout : '';
}

/**
 * Whether the target directory is the very top of a git work tree.
 *
 * `--show-prefix` is where the directory sits inside the work tree, and it is
 * empty exactly at the top. Asking this way needs no path comparison, so a
 * symlink anywhere on the way in cannot make a repository look like none.
 */
export async function isTopLevel(target: GitTarget): Promise<boolean> {
  const result = await git(target, ['rev-parse', '--show-prefix']);
  return result.ok && result.stdout.trim() === '';
}

/** The commit HEAD names, or '' outside a repository or before the first commit. */
export async function headCommit(target: GitTarget): Promise<string> {
  const result = await git(target, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}
