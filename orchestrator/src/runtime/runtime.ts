/**
 * The interface to the system that runs the box containers, keeps their storage and isolates them.
 *
 * The rest of the orchestrator reaches a box only through this interface. It
 * keys everything by the box id.
 */

import type { Readable, Writable } from 'node:stream';
import type { DeploymentImages, RuntimeState } from '../../../shared/types.ts';

/** The box's writable workspace, and the working directory of everything in it. */
export const WORKSPACE_DIR = '/workspace';

/** The home directory of the agent user inside a box. */
export const HOME_DIR = '/home/agent';

/**
 * The mount path of the writable Nix store of a box.
 *
 * The path is fixed, because store paths are hashed against /nix/store. The
 * binary cache has nothing for a store at a different path.
 */
export const NIX_DIR = '/nix';

/** The time limit of a {@link Runtime.run} when the caller gives no limit, in milliseconds. */
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
  /** The working directory of the command, as a path inside the box. */
  workingDir?: string;
  /** Variables for the command, added to the environment of the box. */
  env?: Record<string, string>;
  /** The time the command may run before it gets SIGTERM, in milliseconds. */
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
  /** The exit code, or null when it could not be read. */
  code: number | null;
}

/** The options of a long-lived process. */
export interface SpawnOptions {
  /** The working directory of the process, as a path inside the box. {@link WORKSPACE_DIR} when absent. */
  workingDir?: string;
  /** Variables for the process, added to the environment of the box. */
  env?: Record<string, string>;
  /** The size of a terminal for the process. Without it, the process gets plain pipes. */
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
  /**
   * Sets a new size of the terminal. Does nothing without a terminal.
   *
   * @param cols The number of columns.
   * @param rows The number of rows.
   */
  resize(cols: number, rows: number): Promise<void>;
  /** Closes the connection to the process. */
  kill(): void;
}

/**
 * A short-lived login container: from the box image, with internet access
 * and no storage.
 */
export interface Login {
  /**
   * Starts one process in the login container, with the same contract as {@link Runtime.spawn}.
   *
   * @param cmd The argument vector of the process.
   * @param opts The options of the process. The working directory is always {@link HOME_DIR}.
   * @returns The stdio and the end of the process.
   */
  spawn(cmd: readonly string[], opts?: Omit<SpawnOptions, 'workingDir'>): Promise<ProcessStream>;
  /** Removes the login container, whatever state it is in. Never throws. */
  remove(): Promise<void>;
}

/**
 * One object that the runtime holds for this deployment, for the boot reconcile
 * and the orphan sweep. {@link Runtime.removeObject} finds the object by `ref`.
 */
export type RuntimeObject =
  | {
      /** The container of a box. */
      kind: 'box';
      /** The box it belongs to. */
      boxId: string;
      /** The runtime's own handle. */
      ref: string;
      /** True when the container runs. */
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
      /** The creation time of the container, in epoch milliseconds. */
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
  /**
   * Checks and resolves what the runtime needs, once, at boot.
   *
   * @throws Error when the runtime cannot work.
   */
  prepare(): Promise<void>;

  /**
   * Creates the storage of a new box: the workspace, the home and the Nix store.
   *
   * @param boxId The id of the box.
   */
  createStorage(boxId: string): Promise<void>;
  /**
   * Finds the parts of the storage of a box that are gone. A missing Nix store
   * does not count, because {@link Runtime.ensure} creates it again.
   *
   * @param boxId The id of the box.
   * @returns One description per missing part, for an error message. Empty when the storage is complete.
   */
  missingStorage(boxId: string): Promise<string[]>;
  /**
   * Removes the storage of a box and everything in it.
   *
   * @param boxId The id of the box.
   */
  removeStorage(boxId: string): Promise<void>;

  /**
   * Creates or repairs the container and the isolation of a box. Idempotent.
   * On a running box, it repairs only the isolation and never changes the
   * container.
   *
   * @param box The id and the environment of the box.
   */
  ensure(box: BoxSpec): Promise<void>;
  /**
   * Starts a box, after {@link Runtime.ensure}. Resolves when the container
   * runs. A runtime that makes the container at each start makes it from
   * this spec.
   *
   * @param box The id and the environment of the box.
   */
  start(box: BoxSpec): Promise<void>;
  /**
   * Stops a box. Resolves when it is stopped.
   *
   * @param boxId The id of the box.
   */
  stop(boxId: string): Promise<void>;
  /**
   * Removes the container and the isolation of a box. The storage stays.
   *
   * @param boxId The id of the box.
   */
  remove(boxId: string): Promise<void>;
  /**
   * Reads the live state of a box. A caller must not treat `unknown` as stopped.
   *
   * @param boxId The id of the box.
   * @returns The state, or `unknown` when the runtime gives no usable answer.
   */
  state(boxId: string): Promise<RuntimeState>;
  /**
   * Checks the isolation of a box.
   *
   * @param boxId The id of the box.
   * @returns True when the isolation is complete. False when it cannot be read.
   */
  isolated(boxId: string): Promise<boolean>;

  /**
   * Reads the image that a box runs.
   *
   * @param boxId The id of the box.
   * @returns The image id or digest, or null when the box has none.
   */
  imageOf(boxId: string): Promise<string | null>;
  /**
   * Makes the image that BOX_IMAGE names available.
   *
   * @param onProgress Called with each progress event of a pull.
   * @throws Error when the image cannot be made available.
   */
  ensureImage(onProgress?: (event: PullEvent) => void): Promise<void>;
  /**
   * Gets a new image behind BOX_IMAGE when there is one, and removes old images where the runtime must.
   *
   * @param onProgress Called with each progress event of a pull.
   */
  refreshImage(onProgress?: (event: PullEvent) => void): Promise<void>;

  /**
   * Lists all objects of this deployment, logins and storage included.
   *
   * @returns The objects. The objects of each box are in the order they must be removed in.
   */
  inventory(): Promise<RuntimeObject[]>;
  /**
   * Removes one object of the inventory.
   *
   * @param obj The object from {@link Runtime.inventory}.
   */
  removeObject(obj: RuntimeObject): Promise<void>;

  /**
   * Runs a short command in a box as the agent user, and collects its output.
   * The command is an argument vector, never a shell line. Without a timeout
   * in `opts`, {@link RUN_TIMEOUT_MS} applies.
   *
   * @param boxId The id of the box.
   * @param cmd The argument vector of the command.
   * @param opts The options of the command.
   * @returns The output and the exit code.
   */
  run(boxId: string, cmd: readonly string[], opts?: RunOptions): Promise<RunOutput>;
  /**
   * Starts a long-lived process in a box as the agent user.
   *
   * @param boxId The id of the box.
   * @param cmd The argument vector of the process.
   * @param opts The options of the process.
   * @returns The stdio and the end of the process.
   */
  spawn(boxId: string, cmd: readonly string[], opts?: SpawnOptions): Promise<ProcessStream>;

  /**
   * Creates and starts a login container for a credential.
   *
   * @param credentialId The id of the credential that the login is for.
   * @returns The handle of the login container.
   */
  startLogin(credentialId: string): Promise<Login>;

  /**
   * Gives the proxy URL of a box. The box id is the user and the token of the
   * box is the password, so the proxy can identify the box.
   *
   * @param boxId The id of the box.
   * @param token The token of the box at the proxy.
   * @returns The URL of the front door of the proxy, as a box sees it.
   */
  proxyUrl(boxId: string, token: string): string;
  /**
   * Reads facts about a box for the details page.
   *
   * @param boxId The id of the box.
   * @returns The facts, each as label and value.
   */
  details(boxId: string): Promise<Array<[string, string]>>;
  /**
   * Checks that the runtime can be reached.
   *
   * @throws Error when the runtime cannot be reached.
   */
  health(): Promise<void>;
  /**
   * Reads the images of the orchestrator, the proxy and a new box, for the image footer.
   *
   * @returns The three images. An image that cannot be read is null.
   */
  deploymentImages(): Promise<DeploymentImages>;
}

/** The runtime in use, or null before it is set. */
let current: Runtime | null = null;

/**
 * Gives the runtime in use.
 *
 * @returns The runtime.
 * @throws Error when no runtime is set, so a test cannot use one by accident.
 */
export function runtime(): Runtime {
  if (!current) throw new Error('No runtime is set');
  return current;
}

/**
 * Sets the runtime in use.
 *
 * @param next The runtime, or null to remove it.
 */
export function setRuntime(next: Runtime | null): void {
  current = next;
}
