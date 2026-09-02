import type { ExecRecord } from '../../shared/types.ts';
import { appendExecLog, listExecLog, type Db, type ExecRow } from './db.ts';
import * as dk from './docker.ts';
import { log } from './log.ts';

/**
 * Local commands: the `!bang` escape hatch, run inside the session container.
 *
 * The command runs in the container's existing isolation — internal network,
 * read-only rootfs, capabilities dropped, non-root user — so this introduces
 * no privilege the agent does not already have. Nothing here shell-executes
 * on the host: the command travels as an argument to `bash -lc` inside the
 * container and never reaches a host command line.
 */

/** Longest a command may run before it is killed, in milliseconds. */
export const WALL_CLOCK_MS = 120_000;

/** Most output a command may produce before the rest is dropped, in bytes. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** How a finished run ended. */
export interface ExecOutcome {
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/** What runCommand needs to know about the session it is running in. */
export interface ExecTarget {
  containerId: string;
  /** Where the command runs; the workspace root, as the adapter does. */
  workingDir: string;
}

/** The limits one run is held to. Both default to the constants above. */
export interface ExecLimits {
  wallClockMs?: number;
  maxOutputBytes?: number;
}

/**
 * Runs one command, streaming its combined output to `onChunk`.
 *
 * Both limits are enforced here rather than left to the container: output
 * past the cap is dropped and the exec killed, so a `yes` cannot fill the
 * response, and the wall clock kills a command that never ends.
 */
export async function runCommand(
  target: ExecTarget,
  command: string,
  onChunk: (chunk: string) => void,
  limits: ExecLimits = {},
): Promise<ExecOutcome & { output: string }> {
  const wallClockMs = limits.wallClockMs ?? WALL_CLOCK_MS;
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const exec = await dk.runCommandExec(target.containerId, command, target.workingDir);

  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  const captured: string[] = [];

  const timer = setTimeout(() => {
    timedOut = true;
    exec.kill();
  }, wallClockMs);

  await new Promise<void>((resolve) => {
    exec.output.setEncoding('utf8');
    exec.output.on('data', (chunk: string) => {
      if (truncated) return;
      const room = maxOutputBytes - bytes;
      const piece = Buffer.byteLength(chunk, 'utf8') <= room ? chunk : chunk.slice(0, room);
      bytes += Buffer.byteLength(piece, 'utf8');
      if (piece) {
        captured.push(piece);
        onChunk(piece);
      }
      if (bytes >= maxOutputBytes) {
        truncated = true;
        exec.kill();
      }
    });
    exec.output.on('end', resolve);
    exec.output.on('close', resolve);
    exec.output.on('error', () => resolve());
  });

  clearTimeout(timer);
  const exitCode = truncated || timedOut ? null : await exec.exited;

  return { output: captured.join(''), exitCode, truncated, timedOut };
}

/** The trailer line every exec response ends with, carrying the exit code. */
export function trailer(outcome: ExecOutcome): string {
  const notes = [outcome.truncated ? 'truncated' : '', outcome.timedOut ? 'timed out' : '']
    .filter(Boolean)
    .join(', ');
  return `\n[exit ${outcome.exitCode ?? 'null'}${notes ? ` ${notes}` : ''}]\n`;
}

/** Records one finished run, and never lets a failed write break the response. */
export function record(
  db: Db,
  sessionId: string,
  command: string,
  output: string,
  outcome: ExecOutcome,
  startedAt: number,
): void {
  try {
    appendExecLog(db, sessionId, {
      command,
      output: output.slice(0, MAX_OUTPUT_BYTES),
      exit_code: outcome.exitCode,
      truncated: outcome.truncated ? 1 : 0,
      timed_out: outcome.timedOut ? 1 : 0,
      started_at: startedAt,
      finished_at: Date.now(),
    });
  } catch (err) {
    log.session(sessionId).warn('exec_log write failed', { error: (err as Error).message });
  }
}

/** One stored row in the shape the API returns. */
function toRecord(row: ExecRow): ExecRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    output: row.output,
    exitCode: row.exit_code,
    truncated: row.truncated === 1,
    timedOut: row.timed_out === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Every command already run in one session, oldest first. */
export function history(db: Db, sessionId: string): ExecRecord[] {
  return listExecLog(db, sessionId).map(toRecord);
}
