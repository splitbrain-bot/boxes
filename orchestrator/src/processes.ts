import { log } from './log.ts';
import { runtime } from './runtime/runtime.ts';

/** The processes in a box, read and signalled with the tools of the box image. */

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
 * Every process running inside a box, with the box's own pids.
 *
 * It runs the box image's `ps`, which appears in its own output. A box that
 * cannot be reached, or one without `ps`, throws, so the caller cannot
 * mistake it for one with nothing running.
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
 * that has already gone, is only logged at debug level.
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
