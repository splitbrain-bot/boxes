import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { boxProcesses, killInBox } from './processes.ts';
import { setRuntime, type Runtime } from './runtime/runtime.ts';

/**
 * How the box's process table is read, which is what says whether a
 * conversation has anything still running in it, and which pids a stop
 * signals.
 */
describe('reading and signalling what is running in a box', () => {
  /** A runtime whose commands answer with `output` and record what ran. */
  function fakeRun(output: string, code = 0): { ran: Array<readonly string[]> } {
    const ran: Array<readonly string[]> = [];
    setRuntime({
      run: async (_boxId: string, cmd: readonly string[]) => {
        ran.push(cmd);
        return { stdout: output, stderr: '', code };
      },
    } as unknown as Runtime);
    return { ran };
  }

  it('parses what the box\'s own ps prints, spaces and all', async () => {
    const { ran } = fakeRun(
      [
        '    PID    PPID ELAPSED COMMAND',
        '      1       0     900 /sbin/docker-init',
        '  23490   23019     154 /bin/bash -c eval \'sleep 300; echo done\'',
      ].join('\n'),
    );
    const processes = await boxProcesses('b1');
    assert.deepEqual(ran, [['ps', '-eo', 'pid,ppid,etimes,args']]);
    assert.deepEqual(processes, [
      { pid: 1, ppid: 0, command: '/sbin/docker-init', elapsedSeconds: 900 },
      {
        pid: 23490,
        ppid: 23019,
        command: "/bin/bash -c eval 'sleep 300; echo done'",
        elapsedSeconds: 154,
      },
    ]);
  });

  it('says so when the box has no ps to ask', async () => {
    // "Nothing is running" would make a stop look like its target was
    // already gone.
    fakeRun('ps: command not found', 127);
    await expect(boxProcesses('b1')).rejects.toThrow(/exited 127/);
  });

  it('signals pids as arguments, never as a line for a shell to take apart', async () => {
    const { ran } = fakeRun('');
    await killInBox('b1', 'TERM', [15, 14]);
    assert.deepEqual(ran, [['kill', '-TERM', '15', '14']]);
  });

  it('has nothing to signal for an empty list', async () => {
    const { ran } = fakeRun('');
    await killInBox('b1', 'KILL', []);
    assert.deepEqual(ran, []);
  });
});
