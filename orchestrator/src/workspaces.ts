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
 * What a box is made of on disk: its workspace, its home, and its Nix store.
 *
 * All three are directories under DATA_DIR, bind-mounted into the box
 * container, so the orchestrator reads and writes them as ordinary files,
 * runs git over a workspace with no container running, and measures what a
 * box costs by walking three directories.
 *
 * A home holds thread transcripts, the tool caches an agent installs at
 * runtime, and whatever credential a login inside the box wrote, so `homes/`
 * is 0700, the same as `workspaces/`. A Nix store holds what the agent
 * installed with nix, and is mounted at /nix because that is the one path
 * Nix's binary cache is built against.
 */

/**
 * Default uid and gid the box container runs as.
 *
 * This is the one number the box image and the orchestrator have to agree
 * on, so it is defined once here: `BOX_UID`/`BOX_GID` default to it in
 * config.ts, and `box-image/Dockerfile` builds its `agent` user on it
 * through build args of the same name. Outside the range a login user is
 * normally given.
 *
 * A bind mount — unlike a named volume — is not ownership-initialised by
 * Docker, so every directory and file the orchestrator creates in a workspace
 * has to be given away explicitly, or the agent cannot write to its own
 * workspace. Unless the orchestrator is already running as this uid, in which
 * case there is nothing to give away; see chownToAgent.
 */
export const DEFAULT_BOX_UID = 1020;
export const DEFAULT_BOX_GID = 1020;

/**
 * The uid and gid in force, installed once at boot from the parsed config and
 * fixed for the life of the process.
 */
let owner: { uid: number; gid: number } = {
  uid: DEFAULT_BOX_UID,
  gid: DEFAULT_BOX_GID,
};

/** Installs the uid and gid box containers run as. Called from buildApp. */
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

/** Where a box's files live, as this process sees them. */
export function workspacePath(dataDir: string, boxId: string): string {
  return join(workspacesRoot(dataDir), boxId);
}

/**
 * Where a box's files live as the Docker daemon sees them, which is what
 * a bind source has to name.
 *
 * Bind sources are resolved by the daemon, not by the process asking for the
 * mount, so a bind of a path under the orchestrator's own /data cannot use
 * the orchestrator's path for it. POSIX joining is correct on every supported
 * host: on Linux the daemon is the host, and under Docker Desktop it runs in
 * a Linux VM.
 */
export function hostWorkspacePath(hostDataDir: string, boxId: string): string {
  return posix.join(hostDataDir, WORKSPACES_SUBDIR, boxId);
}

/** The parent of every home directory. */
export function homesRoot(dataDir: string): string {
  return join(dataDir, HOMES_SUBDIR);
}

/** Where a box's home lives, as this process sees them. */
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
 * Creates the workspaces, homes and nix parents, mode 0700.
 *
 * One box's files must not be readable from another box, and the only
 * thing that reads across all of them is this process. 0700 on the parents
 * says so on the data volume itself, where a stray `docker run -v boxes-data`
 * would otherwise see everything.
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
 * Creates a box's home directory, empty.
 *
 * Empty is not usable on its own: a bind mount covers whatever the image put
 * in `/home/agent`, and Docker does not seed a bind the way it seeds a named
 * volume. `seedHomeFromImage` copies the image's own home in, and the mode
 * and owner set here stand until it does.
 */
export function createHome(dataDir: string, boxId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = homePath(dataDir, boxId);
  // 0700 rather than the workspace's 0755: a home holds the credentials a
  // login inside the box wrote, and nothing but the agent reads it.
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chownToAgent(path);
  return path;
}

/**
 * Creates a box's Nix store directory and hands it to the agent user, or
 * leaves one that is already there as it is. Returns the path as this
 * process sees it.
 *
 * Empty is usable, unlike a home: nix lays the store out underneath on first
 * use. Called at every start rather than only at create, because a box from
 * before the store existed has none, and Docker would otherwise create the
 * bind source itself, empty and owned by root.
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
 * Whether a path is there and is a directory.
 *
 * Asked before a box's workspace or home is bind-mounted. Docker creates
 * a bind source it cannot find, empty and owned by root, so a box whose
 * directory has gone starts and looks healthy while the agent cannot write to
 * it. Nothing is created here: the answer is what turns that into a refusal
 * naming what is missing.
 */
export function directoryExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * The box ids that have a workspace, a home or a Nix store directory on disk.
 *
 * Read from the three roots rather than from the database, which is what
 * makes it an answer about what is there: a teardown that removed a box's
 * Docker objects and then failed leaves these behind with nothing naming
 * them. A root that does not exist yet contributes nothing.
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
  // recursive removal unlinks symlinks rather than following them, so a link
  // planted in the tree cannot reach out of it.
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
 * what the orchestrator wrote, REVIEW.md above all.
 *
 * Only root can give a file away. A deployment running the orchestrator as
 * the box uid itself needs none of this and returns at once, which is
 * what lets it drop root. One running as some other non-root user keeps the
 * files it wrote, which works until a container mounts them, so the failure
 * is logged rather than thrown.
 */
export function chownToAgent(path: string): void {
  if (process.getuid?.() === owner.uid) return;
  try {
    // On the named entry rather than through it: a link planted in a tree the
    // agent writes must not hand its target away.
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
 * The descriptor names the file that was opened, whatever the name it was
 * opened under points at by now, which is what a write into a directory the
 * agent owns needs. The uid rule and the logged failure are those of
 * chownToAgent.
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
