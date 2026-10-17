import type { Readable, Writable } from 'node:stream';
import type { DeploymentImages, RuntimeState } from '../../../shared/types.ts';

/**
 * The runtime layer: what runs boxes, keeps their storage and isolates them.
 *
 * The rest of the orchestrator reaches a box only through this interface. It
 * keys everything by the box id.
 */

/** The box's writable workspace, and the working directory of everything in it. */
export const WORKSPACE_DIR = '/workspace';

/** The agent user's home inside a box, where its own files and caches live. */
export const HOME_DIR = '/home/agent';

/**
 * Where the box's Nix store is mounted, writable.
 *
 * The path is fixed: store paths are hashed against /nix/store, so the binary
 * cache has nothing for a store elsewhere.
 */
export const NIX_DIR = '/nix';

/** How long a {@link Runtime.run} may take when the caller gives no limit. */
export const RUN_TIMEOUT_MS = 60_000;

/** The input the runtime needs to create or repair the container of one box. */
export interface BoxSpec {
  /** The server-generated box id. */
  boxId: string;
  /** The full environment of the box, as built by boxEnv(). */
  env: Record<string, string>;
}

/** The options of a short command, and how much of its output is kept. */
export interface RunOptions {
  /** The directory it runs in, as the box names it. */
  workingDir?: string;
  /** Variables set for it, on top of the box's own environment. */
  env?: Record<string, string>;
  /** How long it may run before it is signalled. */
  timeoutMs?: number;
  /** How many bytes of each stream are kept. The rest is read and dropped. */
  maxOutput?: number;
}

/** The output and the exit code of a short command. */
export interface RunOutput {
  /** What the command wrote to stdout, up to maxOutput bytes. */
  stdout: string;
  /** What the command wrote to stderr, up to maxOutput bytes. */
  stderr: string;
  /** Null when the exit code could not be read. */
  code: number | null;
}

/** The options of a long-lived process. */
export interface SpawnOptions {
  /** The directory it runs in, as the box names it. {@link WORKSPACE_DIR} when absent. */
  workingDir?: string;
  /** Variables set for it, on top of the box's own environment. */
  env?: Record<string, string>;
  /** A terminal of this size. Without it, the process gets plain pipes. */
  tty?: { cols: number; rows: number };
}

/**
 * A long-lived process with its stdio. It can end at any time, and the caller
 * must cope with that.
 *
 * With a terminal, stdout carries everything the terminal shows, and stderr
 * stays empty.
 */
export interface ProcessStream {
  /** The stdout of the process. */
  stdout: Readable;
  /** The stderr of the process. */
  stderr: Readable;
  /** The stdin of the process. */
  stdin: Writable;
  /** Resolves when the stream ends, with the exit code if known. */
  exited: Promise<number | null>;
  /** Tells the terminal how large the window onto it is. Does nothing without a terminal. */
  resize(cols: number, rows: number): Promise<void>;
  /** Drops the stream. */
  kill(): void;
}

/**
 * A short-lived login container: from the box image, with internet access
 * and no storage.
 */
export interface Login {
  /** Starts one process in the login container, with the same contract as {@link Runtime.spawn}. */
  spawn(cmd: readonly string[], opts?: Omit<SpawnOptions, 'workingDir'>): Promise<ProcessStream>;
  /** Removes the login container, whatever state it is in. Never throws. */
  remove(): Promise<void>;
}

/**
 * One object the runtime holds for this deployment, for the boot reconcile
 * and the orphan sweep. `ref` is the runtime's own handle, which only
 * {@link Runtime.removeObject} reads.
 */
export type RuntimeObject =
  | {
      /** The container of a box. */
      kind: 'box';
      /** The box it belongs to. */
      boxId: string;
      /** The runtime's own handle. */
      ref: string;
      /** True when it runs. */
      running: boolean;
    }
  | {
      /** The isolation or the storage of a box. */
      kind: 'isolation' | 'storage';
      /** The box it belongs to. */
      boxId: string;
      /** The runtime's own handle. */
      ref: string;
    }
  | {
      /** A login container. */
      kind: 'login';
      /** The credential the login is for. */
      credentialId: string;
      /** The runtime's own handle. */
      ref: string;
      /** When it was created, in epoch milliseconds. */
      createdAt: number;
    };

/** One progress event of an image pull. */
export interface PullEvent {
  /** The step of the pull, such as `Downloading` or `Pull complete`. */
  status?: string;
  /** The layer the event is about. Some events name the tag instead, or nothing. */
  id?: string;
  /**
   * The progress done and the progress in all, for the events that move. The
   * unit is bytes, unless `units` names another one.
   */
  progressDetail?: { current?: number; total?: number; units?: string };
}

/** Everything the orchestrator needs from what runs its boxes. */
export interface Runtime {
  /** Checks and resolves what the runtime needs, once, at boot. Throws when it cannot work. */
  prepare(): Promise<void>;

  /** Creates the storage of a new box: the workspace, the home and the Nix store. */
  createStorage(boxId: string): Promise<void>;
  /**
   * The parts of a box's storage that are gone, each as a description for
   * an error message. Empty when the storage is complete. A missing Nix store
   * does not count, because {@link ensure} creates it again.
   */
  missingStorage(boxId: string): Promise<string[]>;
  /** Removes the storage of a box and everything in it. */
  removeStorage(boxId: string): Promise<void>;

  /**
   * Creates or repairs the container and the isolation of a box. Idempotent.
   * On a running box, it repairs only the isolation and never changes the
   * container.
   */
  ensure(box: BoxSpec): Promise<void>;
  /**
   * Starts a box, after {@link ensure}. Resolves when an exec in the box
   * works. A runtime that makes the container at each start makes it from
   * this spec.
   */
  start(box: BoxSpec): Promise<void>;
  /** Stops a box. Resolves when it is stopped. */
  stop(boxId: string): Promise<void>;
  /** Removes the container and the isolation of a box. The storage stays. */
  remove(boxId: string): Promise<void>;
  /**
   * The live state of a box. `unknown` when the runtime does not answer. It
   * counts as live, so a failed read stops nothing.
   */
  state(boxId: string): Promise<RuntimeState>;
  /** True when the isolation of a box is complete. False when it cannot be read. */
  isolated(boxId: string): Promise<boolean>;

  /** The image a box runs, as an image id or digest, or null when it has none. */
  imageOf(boxId: string): Promise<string | null>;
  /** Makes the image that BOX_IMAGE names available. Throws when it cannot. */
  ensureImage(onProgress?: (event: PullEvent) => void): Promise<void>;
  /** Gets a new image behind BOX_IMAGE when there is one, and removes old images where the runtime must. */
  refreshImage(onProgress?: (event: PullEvent) => void): Promise<void>;

  /**
   * All objects of this deployment, logins and storage included. Each box's
   * objects are in the order they must be removed in.
   */
  inventory(): Promise<RuntimeObject[]>;
  /** Removes one object of the inventory. */
  removeObject(obj: RuntimeObject): Promise<void>;

  /**
   * Runs a short command in a box as the agent user, and collects its output.
   * The command is an argument vector, never a shell line. Without a timeout
   * in `opts`, {@link RUN_TIMEOUT_MS} applies.
   */
  run(boxId: string, cmd: readonly string[], opts?: RunOptions): Promise<RunOutput>;
  /** Starts a long-lived process in a box as the agent user. */
  spawn(boxId: string, cmd: readonly string[], opts?: SpawnOptions): Promise<ProcessStream>;

  /** Creates and starts a login container for a credential. */
  startLogin(credentialId: string): Promise<Login>;

  /** The URL of the front door of the egress proxy, as a box sees it. */
  proxyUrl(): string;
  /** Facts about a box for the details page, as label and value. */
  details(boxId: string): Promise<Array<[string, string]>>;
  /** Throws when the runtime cannot be reached. */
  health(): Promise<void>;
  /** The images of the orchestrator, the proxy and a new box, for the image footer. */
  deploymentImages(): Promise<DeploymentImages>;
}

/** The runtime in use, or null before it is set. */
let current: Runtime | null = null;

/** The runtime in use. Throws when none is set, so a test cannot use one by accident. */
export function runtime(): Runtime {
  if (!current) throw new Error('No runtime is set');
  return current;
}

/** Sets the runtime in use. Null removes it. */
export function setRuntime(next: Runtime | null): void {
  current = next;
}
