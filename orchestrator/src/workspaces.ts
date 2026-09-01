import { chownSync, mkdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { log } from './log.ts';

/**
 * Session workspaces as directories on the orchestrator's own data volume.
 *
 * A workspace used to be the named volume `ws-<id>`, mounted only into its
 * session container: the orchestrator had no filesystem path to it, and
 * reaching the files meant a `docker exec`. Here each workspace is a directory
 * under DATA_DIR that is bind-mounted into the session container instead, so
 * the orchestrator reads and writes the agent's files as ordinary files and
 * runs git over them itself — with no container running, which is the natural
 * moment to review one.
 *
 * The home volume is deliberately not moved: it holds transcripts and whatever
 * credentials a login inside the session created, and nothing outside the
 * container has business there.
 */

/**
 * Default uid and gid the session container runs as.
 *
 * This is the one number the session image and the orchestrator have to agree
 * on, so it is defined once here: `SESSION_UID`/`SESSION_GID` default to it in
 * config.ts, and `session-image/Dockerfile` builds its `agent` user on it
 * through build args of the same name. Outside the range a login user is
 * normally given, because a service sharing a uid with a person is exactly
 * what a per-service uid is for.
 *
 * A bind mount — unlike a named volume — is not ownership-initialised by
 * Docker, so every directory and file the orchestrator creates in a workspace
 * has to be given away explicitly, or the agent cannot write to its own
 * workspace. Unless the orchestrator is already running as this uid, in which
 * case there is nothing to give away; see chownToAgent.
 */
export const DEFAULT_SESSION_UID = 1020;
export const DEFAULT_SESSION_GID = 1020;

/**
 * The uid and gid in force, installed once at boot from the parsed config.
 *
 * Module state with an explicit installer, like docker.ts's client and
 * config.ts's own cache: the alternative is threading two numbers through
 * ReviewService and every atomic write under it, for a value that is fixed for
 * the life of the process.
 */
let owner: { uid: number; gid: number } = {
  uid: DEFAULT_SESSION_UID,
  gid: DEFAULT_SESSION_GID,
};

/** Installs the uid and gid session containers run as. Called from buildApp. */
export function setSessionOwner(uid: number, gid: number): void {
  owner = { uid, gid };
}

/** The uid and gid session containers run as. */
export function sessionOwner(): { readonly uid: number; readonly gid: number } {
  return owner;
}

/** Directory under DATA_DIR holding one directory per session workspace. */
export const WORKSPACES_SUBDIR = 'workspaces';

/** The parent of every workspace directory. */
export function workspacesRoot(dataDir: string): string {
  return join(dataDir, WORKSPACES_SUBDIR);
}

/** Where a session's files live, as this process sees them. */
export function workspacePath(dataDir: string, sessionId: string): string {
  return join(workspacesRoot(dataDir), sessionId);
}

/**
 * Where a session's files live as the Docker daemon sees them, which is what
 * a bind source has to name.
 *
 * Bind sources are resolved by the daemon, not by the process asking for the
 * mount, so a bind of a path under the orchestrator's own /data cannot use
 * the orchestrator's path for it. POSIX joining is correct on every host the
 * README supports: on Linux the daemon is the host, and under Docker Desktop
 * it lives in a Linux VM.
 */
export function hostWorkspacePath(hostDataDir: string, sessionId: string): string {
  return posix.join(hostDataDir, WORKSPACES_SUBDIR, sessionId);
}

/**
 * Creates the workspaces parent, mode 0700.
 *
 * One session's workspace must not be readable from another session, and the
 * only thing that reads across all of them is this process. 0700 on the parent
 * says so on the data volume itself, where a stray `docker run -v boxes-data`
 * would otherwise see everything.
 */
export function ensureWorkspacesRoot(dataDir: string): void {
  mkdirSync(workspacesRoot(dataDir), { recursive: true, mode: 0o700 });
}

/**
 * Creates a session's workspace directory and hands it to the agent user.
 * Returns the path as this process sees it.
 */
export function createWorkspace(dataDir: string, sessionId: string): string {
  ensureWorkspacesRoot(dataDir);
  const path = workspacePath(dataDir, sessionId);
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownToAgent(path);
  return path;
}

/** Removes a session's workspace directory and everything in it. */
export function removeWorkspace(dataDir: string, sessionId: string): void {
  // recursive removal unlinks symlinks rather than following them, so a link
  // planted in the tree cannot reach out of it.
  rmSync(workspacePath(dataDir, sessionId), { recursive: true, force: true });
}

/**
 * Gives a path to the session's agent user, so the agent can edit and delete
 * what the orchestrator wrote — REVIEW.md above all, which is the point of
 * putting it in the workspace.
 *
 * Only root can give a file away. A deployment that runs the orchestrator as
 * the session uid itself needs none of this and returns immediately, which is
 * the arrangement that lets the orchestrator drop root; one that runs it as
 * some other non-root user is left with files it owns itself, which works for
 * everything but a container actually mounting them, so the failure is logged
 * rather than thrown.
 */
export function chownToAgent(path: string): void {
  if (process.getuid?.() === owner.uid) return;
  try {
    chownSync(path, owner.uid, owner.gid);
  } catch (err) {
    log.warn('could not give a workspace path to the agent user', {
      path,
      uid: owner.uid,
      error: (err as Error).message,
    });
  }
}
