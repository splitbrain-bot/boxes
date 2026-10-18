/**
 * The box directories of the Docker runtime, and the uid and gid of the box containers.
 *
 * The Docker runtime keeps the workspace, the home and the Nix store of each box under DATA_DIR,
 * and bind-mounts them into the box container. It creates and removes them as ordinary
 * directories, with no container running.
 */

import { type Dirent, lchownSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { log } from './log.ts';

/** Default uid the box container runs as, and the default of BOX_UID. */
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

/**
 * Sets the uid and gid box containers run as.
 *
 * @param uid The uid.
 * @param gid The gid.
 */
export function setBoxOwner(uid: number, gid: number): void {
  owner = { uid, gid };
}

/**
 * Returns the uid and gid box containers run as.
 *
 * @returns The uid and the gid.
 */
export function boxOwner(): { readonly uid: number; readonly gid: number } {
  return owner;
}

/** Directory under DATA_DIR holding one directory per box workspace. */
const WORKSPACES_SUBDIR = 'workspaces';

/** Directory under DATA_DIR holding one directory per box home. */
const HOMES_SUBDIR = 'homes';

/** Directory under DATA_DIR holding one directory per box Nix store. */
const NIX_SUBDIR = 'nix';

/**
 * Returns the parent of every workspace directory.
 *
 * @param dataDir The data directory, as this process sees it.
 * @returns The path.
 */
export function workspacesRoot(dataDir: string): string {
  return join(dataDir, WORKSPACES_SUBDIR);
}

/**
 * Returns the workspace path of a box, as this process sees it.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 * @returns The path.
 */
export function workspacePath(dataDir: string, boxId: string): string {
  return join(workspacesRoot(dataDir), boxId);
}

/**
 * Returns the workspace path of a box as the Docker daemon sees it, which is what a
 * bind source must name. POSIX joining is right on every supported host, as
 * the daemon always runs on Linux, in a VM under Docker Desktop.
 *
 * @param hostDataDir The data directory, as the Docker daemon sees it.
 * @param boxId The box id.
 * @returns The path.
 */
export function hostWorkspacePath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, WORKSPACES_SUBDIR, boxId);
}

/**
 * Returns the parent of every home directory.
 *
 * @param dataDir The data directory, as this process sees it.
 * @returns The path.
 */
export function homesRoot(dataDir: string): string {
  return join(dataDir, HOMES_SUBDIR);
}

/**
 * Returns the home path of a box, as this process sees it.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 * @returns The path.
 */
export function homePath(dataDir: string, boxId: string): string {
  return join(homesRoot(dataDir), boxId);
}

/**
 * Returns the home path of a box as the Docker daemon sees it, for the bind source.
 *
 * @param hostDataDir The data directory, as the Docker daemon sees it.
 * @param boxId The box id.
 * @returns The path.
 */
export function hostHomePath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, HOMES_SUBDIR, boxId);
}

/**
 * Returns the parent of every Nix store directory.
 *
 * @param dataDir The data directory, as this process sees it.
 * @returns The path.
 */
export function nixRoot(dataDir: string): string {
  return join(dataDir, NIX_SUBDIR);
}

/**
 * Returns the Nix store path of a box, as this process sees it.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 * @returns The path.
 */
export function nixPath(dataDir: string, boxId: string): string {
  return join(nixRoot(dataDir), boxId);
}

/**
 * Returns the Nix store path of a box as the Docker daemon sees it, for the bind source.
 *
 * @param hostDataDir The data directory, as the Docker daemon sees it.
 * @param boxId The box id.
 * @returns The path.
 */
export function hostNixPath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, NIX_SUBDIR, boxId);
}

/**
 * Creates the workspaces, homes and nix parents, mode 0700, so that on the
 * data volume only this process can read across boxes.
 *
 * @param dataDir The data directory, as this process sees it.
 */
export function ensureWorkspacesRoot(dataDir: string): void {
  mkdirSync(workspacesRoot(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(homesRoot(dataDir), { recursive: true, mode: 0o700 });
  mkdirSync(nixRoot(dataDir), { recursive: true, mode: 0o700 });
}

/**
 * Creates a box's workspace directory and hands it to the agent user.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 * @returns The path, as this process sees it.
 */
export function createWorkspace(dataDir: string, boxId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = workspacePath(dataDir, boxId);
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownToAgent(path);
  return path;
}

/**
 * Creates a box's home directory, empty. boxes-setup fills it at the first start of the box.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 * @returns The path, as this process sees it.
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
 * leaves one that is already there as it is.
 *
 * An empty store is usable, as nix lays it out on first use. The Docker runtime
 * also calls it before each start of a box, so a box whose store is gone gets one
 * owned by the agent, not one that Docker creates for root.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 * @returns The path, as this process sees it.
 */
export function createNix(dataDir: string, boxId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = nixPath(dataDir, boxId);
  // 0755 like the workspace, because a package store holds nothing secret.
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownToAgent(path);
  return path;
}

/**
 * Returns true when a path exists and is a directory.
 *
 * The Docker runtime checks the workspace and the home of a box with it before a start.
 * Docker creates a missing bind source empty and owned by root, and the box would
 * look healthy while the agent cannot write.
 *
 * @param path The path.
 * @returns True for a directory.
 */
export function directoryExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Returns the box ids that have a workspace, a home or a Nix store directory on disk,
 * read from the three roots rather than the database. A missing root adds
 * nothing.
 *
 * @param dataDir The data directory, as this process sees it.
 * @returns The box ids.
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

/**
 * Removes a box's workspace directory and everything in it.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 */
export function removeWorkspace(dataDir: string, boxId: string): void {
  // Recursive removal unlinks symlinks, so a planted link cannot reach out.
  rmSync(workspacePath(dataDir, boxId), { recursive: true, force: true });
}

/**
 * Removes a box's home directory and everything in it.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 */
export function removeHome(dataDir: string, boxId: string): void {
  rmSync(homePath(dataDir, boxId), { recursive: true, force: true });
}

/**
 * Removes a box's Nix store directory and everything in it.
 *
 * @param dataDir The data directory, as this process sees it.
 * @param boxId The box id.
 */
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
 *
 * @param path The path to give away.
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
