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
 * uid and gid the session container runs as.
 *
 * session-image/Dockerfile renames the base image's uid 1000 to `agent`, and
 * everything in the container runs as that user. A bind mount — unlike a named
 * volume — is not ownership-initialised by Docker, so every directory and file
 * the orchestrator creates in a workspace has to be given away explicitly or
 * the agent cannot write to its own workspace.
 */
export const AGENT_UID = 1000;
export const AGENT_GID = 1000;

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
 * Only root can give a file away, and the orchestrator container runs as root.
 * A development process that does not is left with files it owns itself, which
 * works for everything but a container actually mounting them, so the failure
 * is logged rather than thrown.
 */
export function chownToAgent(path: string): void {
  if (process.getuid?.() === AGENT_UID) return;
  try {
    chownSync(path, AGENT_UID, AGENT_GID);
  } catch (err) {
    log.warn('could not give a workspace path to the agent user', {
      path,
      uid: AGENT_UID,
      error: (err as Error).message,
    });
  }
}
