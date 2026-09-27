import {
  fchownSync,
  lchownSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { join, posix } from 'node:path';
import { log } from './log.ts';

/**
 * The box directories under DATA_DIR: workspace, home and Nix store. They are
 * bind-mounted into the box container, so the orchestrator can use them as
 * ordinary files with no container running.
 */

/**
 * Default uid the box container runs as, and the default of BOX_UID.
 *
 * The box image builds its `agent` user on the same number, through the
 * AGENT_UID build arg, and the two must match.
 */
export const DEFAULT_BOX_UID = 1020;

/** Default gid the box container runs as, and the default of BOX_GID. */
export const DEFAULT_BOX_GID = 1020;

/**
 * The uid and gid box containers run as. buildApp sets them once from the
 * parsed configuration.
 */
let owner: { uid: number; gid: number } = {
  uid: DEFAULT_BOX_UID,
  gid: DEFAULT_BOX_GID,
};

/** Sets the uid and gid box containers run as. */
export function setBoxOwner(uid: number, gid: number): void {
  owner = { uid, gid };
}

/** The uid and gid box containers run as. */
export function boxOwner(): { readonly uid: number; readonly gid: number } {
  return owner;
}

/** Directory under DATA_DIR holding one directory per box workspace. */
const WORKSPACES_SUBDIR = 'workspaces';

/** Directory under DATA_DIR holding one directory per box home. */
const HOMES_SUBDIR = 'homes';

/** Directory under DATA_DIR holding one directory per box Nix store. */
const NIX_SUBDIR = 'nix';

/** The parent of every workspace directory. */
export function workspacesRoot(dataDir: string): string {
  return join(dataDir, WORKSPACES_SUBDIR);
}

/** Where a box's workspace lives, as this process sees it. */
export function workspacePath(dataDir: string, boxId: string): string {
  return join(workspacesRoot(dataDir), boxId);
}

/**
 * Where a box's workspace lives as the Docker daemon sees it, which is what a
 * bind source must name. POSIX joining is right on every supported host, as
 * the daemon always runs on Linux, in a VM under Docker Desktop.
 */
export function hostWorkspacePath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, WORKSPACES_SUBDIR, boxId);
}

/** The parent of every home directory. */
export function homesRoot(dataDir: string): string {
  return join(dataDir, HOMES_SUBDIR);
}

/** Where a box's home lives, as this process sees it. */
export function homePath(dataDir: string, boxId: string): string {
  return join(homesRoot(dataDir), boxId);
}

/** A box's home as the Docker daemon sees it, for the bind source. */
export function hostHomePath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, HOMES_SUBDIR, boxId);
}

/** The parent of every Nix store directory. */
export function nixRoot(dataDir: string): string {
  return join(dataDir, NIX_SUBDIR);
}

/** Where a box's Nix store lives, as this process sees it. */
export function nixPath(dataDir: string, boxId: string): string {
  return join(nixRoot(dataDir), boxId);
}

/** A box's Nix store as the Docker daemon sees it, for the bind source. */
export function hostNixPath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, NIX_SUBDIR, boxId);
}

/**
 * Creates the workspaces, homes and nix parents, mode 0700, so that on the
 * data volume only this process can read across boxes.
 */
export function ensureWorkspacesRoot(dataDir: string): void {
  mkdirSync(workspacesRoot(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(homesRoot(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(nixRoot(dataDir), { recursive: true, mode: 0o700 });
}

/**
 * Creates a box's workspace directory and hands it to the agent user.
 * Returns the path as this process sees it.
 */
export function createWorkspace(dataDir: string, boxId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = workspacePath(dataDir, boxId);
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownToAgent(path);
  return path;
}

/**
 * Creates a box's home directory, empty. Returns the path as this process
 * sees it. The home is not usable until seedHomeFromImage fills it.
 */
export function createHome(dataDir: string, boxId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = homePath(dataDir, boxId);
  // 0700, as a home holds the credentials a login inside the box wrote.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chownToAgent(path);
  return path;
}

/**
 * Creates a box's Nix store directory and hands it to the agent user, or
 * leaves one that is already there as it is. Returns the path as this
 * process sees it.
 *
 * An empty store is usable, as nix lays it out on first use. Box starts call
 * it too, so an older box without a store gets one owned by the agent, not
 * one Docker creates for root.
 */
export function createNix(dataDir: string, boxId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = nixPath(dataDir, boxId);
  // 0755 like the workspace: a package store holds nothing secret.
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownToAgent(path);
  return path;
}

/**
 * Whether a path exists and is a directory.
 *
 * A box start checks its workspace and home with it. Docker would create a
 * missing bind source empty and owned by root, and the box would look healthy
 * while the agent cannot write.
 */
export function directoryExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * The box ids that have a workspace, a home or a Nix store directory on disk,
 * read from the three roots rather than the database. A missing root adds
 * nothing.
 */
export function boxDirectoryIds(dataDir: string): string[] {
  const ids = new Set<string>();
  for (const root of [workspacesRoot(dataDir), homesRoot(dataDir), nixRoot(dataDir)]) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  }
  return [...ids];
}

/** Removes a box's workspace directory and everything in it. */
export function removeWorkspace(dataDir: string, boxId: string): void {
  // Recursive removal unlinks symlinks, so a planted link cannot reach out.
  rmSync(workspacePath(dataDir, boxId), { recursive: true, force: true });
}

/** Removes a box's home directory and everything in it. */
export function removeHome(dataDir: string, boxId: string): void {
  rmSync(homePath(dataDir, boxId), { recursive: true, force: true });
}

/** Removes a box's Nix store directory and everything in it. */
export function removeNix(dataDir: string, boxId: string): void {
  rmSync(nixPath(dataDir, boxId), { recursive: true, force: true });
}

/**
 * Gives a path to the box's agent user, so the agent can edit and delete
 * what the orchestrator wrote. A bind mount keeps the owner the orchestrator
 * created a file with.
 *
 * Returns at once when this process already runs as the box uid. Otherwise
 * only root can do it, and a failure is logged, not thrown.
 */
export function chownToAgent(path: string): void {
  if (process.getuid?.() === owner.uid) return;
  try {
    // lchown, so a link the agent planted does not give its target away.
    lchownSync(path, owner.uid, owner.gid);
  } catch (err) {
    log.warn('could not give a workspace path to the agent user', {
      path,
      uid: owner.uid,
      error: (err as Error).message,
    });
  }
}

/**
 * Gives an open file to the box's agent user, by descriptor.
 *
 * The descriptor names the opened file even if its path now points
 * elsewhere, which a write into a directory the agent owns needs. It returns
 * at once or logs a failure as chownToAgent does.
 */
export function chownFdToAgent(fd: number): void {
  if (process.getuid?.() === owner.uid) return;
  try {
    fchownSync(fd, owner.uid, owner.gid);
  } catch (err) {
    log.warn('could not give a workspace file to the agent user', {
      uid: owner.uid,
      error: (err as Error).message,
    });
  }
}
