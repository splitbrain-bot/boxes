import { log } from '../log.ts';
import { runtime } from '../runtime/runtime.ts';

/** A box and the workspace in it, where the review runs git. */
export interface GitBox {
  /** The id of the running box that git runs in. */
  boxId: string;
  /** The workspace root, as a path inside the box. */
  workspaceDir: string;
}

/** The box and the directory one git invocation runs in. */
export interface GitTarget {
  /** The id of the running box that git runs in. */
  boxId: string;
  /** The directory that git runs in, as a path inside the box. */
  dir: string;
}

/**
 * Returns the flags that every git invocation has before the subcommand.
 *
 * `core.quotepath=false` makes git write non-ASCII paths unquoted, as the
 * parsers and the file tree expect.
 *
 * @returns The flags.
 */
function gitFlags(): string[] {
  return ['-c', 'core.quotepath=false'];
}

/** The options of one git invocation. */
export interface GitOptions {
  /**
   * True to let git save the refreshed index. Git then takes the index lock
   * while it refreshes, and a write command of the agent fails while git holds it.
   */
  saveIndex?: boolean;
}

/**
 * Returns the variables that every git invocation adds to the environment of the container.
 *
 * `GIT_OPTIONAL_LOCKS=0` stops git from saving the refreshed index, unless
 * `saveIndex` is set. `GIT_LITERAL_PATHSPECS=1` makes a pathspec a literal path, so a name holding
 * `*`, `?` or `[` matches only itself. `GIT_TERMINAL_PROMPT=0` makes git fail
 * at a credential prompt. `LC_ALL=C` sets one language for the
 * output of git.
 *
 * @param options The options of the invocation.
 * @returns The variables by name.
 */
export function gitEnv(options: GitOptions = {}): Record<string, string> {
  return {
    ...(options.saveIndex ? {} : { GIT_OPTIONAL_LOCKS: '0' }),
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * The diff flags that the diff parser needs. They keep external diff drivers, textconv
 * filters and colour out of the output, so the parser reads the plain
 * unified diff of the bytes of the file.
 */
export const DIFF_PARSE_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;

/**
 * Builds the whole command line of one invocation. It holds git, the flags of
 * every invocation, and the subcommand with its own arguments.
 *
 * Every `diff` gets {@link DIFF_PARSE_FLAGS} directly after the subcommand.
 *
 * @param args The subcommand and its own arguments.
 * @returns The argument vector.
 */
export function gitArgv(args: string[]): string[] {
  const sub = args[0] === 'diff' ? ['diff', ...DIFF_PARSE_FLAGS, ...args.slice(1)] : args;
  return ['git', ...gitFlags(), ...sub];
}

/** The time in milliseconds that one git invocation can run before the runtime stops it. */
const TIMEOUT_MS = 20_000;

/** The most bytes kept of each output stream of one git invocation. */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** The result of one git invocation. */
export interface GitResult {
  /** True when git exited 0. */
  ok: boolean;
  /** The standard output of git. */
  stdout: string;
  /** The standard error of git. */
  stderr: string;
  /** The exit code, or null when there is none, for example when git was killed. */
  code: number | null;
}

/**
 * A function that runs one git command line and returns its result. Tests
 * replace the default runner with one that needs no runtime.
 *
 * @param target The box and the directory to run git in.
 * @param argv The command line.
 * @param env The variables to add to the environment.
 * @returns The result of git.
 */
export type GitRunner = (
  target: GitTarget,
  argv: string[],
  env: Record<string, string>,
) => Promise<GitResult>;

/**
 * The default runner. The runtime runs the command in the box as the agent user.
 *
 * The configuration of a repository can make git run commands, for example a clean
 * filter on `diff` or an fsmonitor hook on `status`. In the box, such a command
 * can do only what the agent can do. In the orchestrator process, it would run
 * next to the credentials of the runtime.
 *
 * @param target The box and the directory to run git in.
 * @param argv The command line.
 * @param env The variables to add to the environment.
 * @returns The result of git.
 */
const inBoxContainer: GitRunner = async (target, argv, env) => {
  const result = await runtime().run(target.boxId, argv, {
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

/** The runner {@link git} uses. Only tests replace it. */
let runner: GitRunner = inBoxContainer;

/**
 * Replaces the runner that starts git.
 *
 * @param next The runner to use, or null to restore the default runner.
 */
export function setGitRunnerForTests(next: GitRunner | null): void {
  runner = next ?? inBoxContainer;
}

/**
 * Runs one git subcommand in a target directory and returns its output.
 *
 * A non-zero exit comes back as a result, because callers read it as an answer,
 * for example "not a repository". When the runner throws, for example because the
 * box cannot be reached, the function also returns a failed result, so the review
 * loses git but still responds.
 *
 * @param target The box and the directory to run git in.
 * @param args The subcommand and its own arguments.
 * @param options The options of the invocation.
 * @returns The result of git.
 */
export async function git(
  target: GitTarget,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  try {
    return await runner(target, gitArgv(args), gitEnv(options));
  } catch (err) {
    log.warn('git invocation failed', { args: args[0], error: (err as Error).message });
    return { ok: false, stdout: '', stderr: '', code: null };
  }
}

/**
 * Runs one git subcommand and returns its standard output.
 *
 * @param target The box and the directory to run git in.
 * @param args The subcommand and its own arguments.
 * @returns The standard output, or '' when git failed.
 */
export async function gitOut(target: GitTarget, args: string[]): Promise<string> {
  const result = await git(target, args);
  return result.ok ? result.stdout : '';
}

/**
 * Checks if the target directory is the top of a git work tree.
 *
 * `--show-prefix` prints the position of the directory in the work tree, which
 * is empty only at the top. The check compares no paths, so a symlink in the
 * path cannot hide a repository.
 *
 * @param target The box and the directory to check.
 * @returns True when the directory is the top of a work tree.
 */
export async function isTopLevel(target: GitTarget): Promise<boolean> {
  const result = await git(target, ['rev-parse', '--show-prefix']);
  return result.ok && result.stdout.trim() === '';
}

/**
 * Reads the commit that HEAD names.
 *
 * @param target The box and the directory of the repository.
 * @returns The commit id, or '' outside a repository or before the first commit.
 */
export async function headCommit(target: GitTarget): Promise<string> {
  const result = await git(target, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : '';
}
