/** The processes in a box, read and signalled with the tools of the box image. */

import { log } from './log.ts';
import { runtime } from './runtime/runtime.ts';

/** One process inside a box, as the box's own `ps` reports it. */
export interface ContainerProcess {
  /** The pid, in the box's own numbering, as a `kill` inside the box needs it. */
  pid: number;
  /** The parent pid, in the same numbering. */
  ppid: number;
  /** The whole command line, which is how a process is recognised. */
  command: string;
  /** How long it has been running, in whole seconds. */
  elapsedSeconds: number;
}

/**
 * Returns every process running inside a box, with the box's own pids.
 *
 * It runs the `ps` of the box image, which appears in its own output. It
 * throws when the box cannot be reached or has no `ps`, so the caller cannot
 * mistake the box for one with nothing running.
 *
 * @param boxId The id of the box.
 * @returns The processes.
 * @throws Error when `ps` exits with an error or the runtime cannot reach the box.
 */
export async function boxProcesses(boxId: string): Promise<ContainerProcess[]> {
  const ps = ['ps', '-eo', 'pid,ppid,etimes,args'];
  const { stdout, stderr, code } = await runtime().run(boxId, ps);
  if (code !== 0) {
    throw new Error(`ps in the box exited ${code ?? 'unknown'}: ${`${stdout}${stderr}`.trim()}`);
  }

  const processes: ContainerProcess[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    // Three left-padded numbers, then the command with its spaces.
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!row) continue;
    processes.push({
      pid: Number(row[1]),
      ppid: Number(row[2]),
      command: row[4] ?? '',
      elapsedSeconds: Number(row[3]),
    });
  }
  return processes;
}

/**
 * Signals processes inside a box, as the agent user.
 *
 * The pids must be the box's own. They are passed to `kill` as separate
 * arguments, never through a shell. A non-zero exit, for example for a pid
 * that has already gone, goes to the log at debug level.
 *
 * @param boxId The id of the box.
 * @param signal The signal.
 * @param pids The pids, in the numbering of the box.
 */
export async function killInBox(
  boxId: string,
  signal: 'TERM' | 'KILL',
  pids: readonly number[],
): Promise<void> {
  if (pids.length === 0) return;
  const { stdout, stderr, code } = await runtime().run(boxId, [
    'kill',
    `-${signal}`,
    ...pids.map((pid) => String(pid)),
  ]);
  if (code !== 0) {
    const error = `${stdout}${stderr}`.trim();
    log.debug('kill in the box reported trouble', { signal, pids, code, error });
  }
}
