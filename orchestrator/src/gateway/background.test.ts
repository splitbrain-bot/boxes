import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  BackgroundProbe,
  TaskBoard,
  readBox,
  startsBackgroundWork,
  workPids,
} from './background.ts';
import type { ContainerProcess } from '../docker.ts';
import { HARNESSES, type Harness } from '../harness.ts';

/** Both harnesses, which is what a reading of a box is taken against. */
const BOTH: readonly Harness[] = [HARNESSES.claude, HARNESSES.codex];

/** A conversation of the box. */
const ONE = '90732d29-a1aa-4df7-9b78-a726bb859148';
/** A second conversation of the same box. */
const TWO = 'd6d8f0a1-2b3c-4d5e-8f90-1a2b3c4d5e6f';

// --- what the adapters say -------------------------------------------------

/** A spawn, as either adapter sends one. */
function spawned(id: string, fields: Record<string, unknown> = {}): unknown {
  return {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: id,
    name: 'npm run build',
    taskType: 'shell',
    canStop: true,
    showInTranscript: true,
    ...fields,
  };
}

/** A state update, which is the only thing Codex sends after a spawn. */
function state(id: string, value: string): unknown {
  return { sessionUpdate: 'async_task_state_update', asyncTaskId: id, state: value };
}

test('a spawn becomes what the bar shows, on the thread it names', () => {
  const board = new TaskBoard(() => 1_700_000_000_000);
  assert.equal(board.note(ONE, spawned('task-1')), true);

  assert.deepEqual(board.for(ONE), [
    {
      id: 'task-1',
      command: 'npm run build',
      kind: 'shell',
      stoppable: true,
      startedAt: 1_700_000_000_000,
    },
  ]);
  // The other conversation in the same box gets nothing.
  assert.deepEqual(board.for(TWO), []);
  assert.deepEqual(board.threads, [ONE]);
});

test('a task with no name of its own is still something a person can read', () => {
  const board = new TaskBoard();
  // Claude's shell tasks carry the command as both `name` and `description`.
  // Its other kinds carry a description alone, or nothing.
  board.note(ONE, spawned('a', { name: undefined, description: 'Watching the build log' }));
  board.note(ONE, spawned('b', { name: undefined, description: undefined }));
  assert.deepEqual(
    board.for(ONE).map((task) => task.command),
    ['Watching the build log', 'a background task'],
  );
});

test('a task that ends is gone, whichever way it ended', () => {
  for (const ending of ['completed', 'failed', 'stopped']) {
    const board = new TaskBoard();
    board.note(ONE, spawned('task-1'));
    assert.equal(board.note(ONE, state('task-1', ending)), true, ending);
    assert.deepEqual(board.for(ONE), []);
    assert.deepEqual(board.threads, []);
  }
});

test('a task that says it is still going is not news', () => {
  // Claude reports `running` and `paused` as a task goes. The Codex source
  // shows only the final states.
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));
  assert.equal(board.note(ONE, state('task-1', 'running')), false);
  assert.equal(board.note(ONE, state('task-1', 'paused')), false);
  assert.equal(board.for(ONE).length, 1);
});

test('progress may rename a task and is required to say nothing at all', () => {
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));

  // Only Claude sends progress, and every field of it is optional.
  assert.equal(
    board.note(ONE, {
      sessionUpdate: 'async_task_progress',
      asyncTaskId: 'task-1',
      description: 'Compiling 412 of 900 files',
    }),
    true,
  );
  assert.equal(board.for(ONE)[0]?.command, 'Compiling 412 of 900 files');
  assert.equal(
    board.note(ONE, { sessionUpdate: 'async_task_progress', asyncTaskId: 'task-1' }),
    false,
  );
  assert.equal(
    board.note(ONE, {
      sessionUpdate: 'async_task_progress',
      asyncTaskId: 'task-1',
      description: 'Compiling 412 of 900 files',
    }),
    false,
  );
});

test('an update about a task this process never announced changes nothing', () => {
  // For example a task of another adapter, or one this board has dropped.
  const board = new TaskBoard();
  assert.equal(board.note(ONE, state('task-9', 'completed')), false);
  assert.equal(board.note(ONE, { sessionUpdate: 'async_task_progress', asyncTaskId: 'x' }), false);
  assert.equal(board.note(ONE, spawned(undefined as unknown as string)), false);
  assert.equal(board.note(ONE, { sessionUpdate: 'agent_message_chunk' }), false);
  assert.equal(board.note(ONE, null), false);
  assert.deepEqual(board.threads, []);
});

test('two conversations of one adapter keep their own tasks', () => {
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));
  board.note(TWO, spawned('task-2', { name: 'npm run watch' }));
  assert.deepEqual(
    board.for(TWO).map((task) => task.command),
    ['npm run watch'],
  );
  assert.deepEqual(board.threads.sort(), [ONE, TWO].sort());
  assert.equal(board.any, true);
});

test('a task that was already over is dropped by the stop that found out', () => {
  // An adapter answers `stopped: false` for a task that finished before the
  // stop. It sends no state update for that task.
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));
  assert.equal(board.drop(ONE, 'task-1'), true);
  assert.equal(board.drop(ONE, 'task-1'), false);
  assert.deepEqual(board.for(ONE), []);
});

test('an adapter that has gone takes every task it announced with it', () => {
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));
  board.note(TWO, spawned('task-2'));
  assert.deepEqual(board.clear().sort(), [ONE, TWO].sort());
  assert.equal(board.any, false);
  assert.deepEqual(board.for(ONE), []);
});

// --- what the box says -----------------------------------------------------

/** A process table, written parent-first. */
function table(...rows: Array<[number, number, string]>): ContainerProcess[] {
  return rows.map(([pid, ppid, command]) => ({ pid, ppid, command, elapsedSeconds: null }));
}

/**
 * The Claude CLI that the adapter spawns as its agent. Its path carries the
 * adapter's process token.
 */
const CLAUDE_AGENT =
  '/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/' +
  '@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json --verbose';

/** A tool call's shell under Claude, wrapper and all. */
function shell(command: string, token = 'cfec'): string {
  return (
    `/bin/bash -c source /home/agent/.claude/shell-snapshots/snapshot-bash-1788851622550.sh ` +
    `2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-${token}-cwd`
  );
}

/** The box held open, with nothing of Boxes' own in it yet. */
const HELD: Array<[number, number, string]> = [
  [1, 0, '/sbin/docker-init -- /usr/local/bin/entrypoint.sh'],
  [7, 1, 'sleep infinity'],
];

/** Both adapters up, each with its agent, and nothing running under either. */
const BOTH_IDLE: Array<[number, number, string]> = [
  ...HELD,
  [22977, 0, 'node /usr/local/bin/claude-agent-acp'],
  [23019, 22977, CLAUDE_AGENT],
  [30001, 0, 'node /usr/local/bin/codex-acp'],
  [30002, 30001, '/usr/local/bin/codex app-server'],
];

test('a box holding both adapters and doing nothing is idle', () => {
  // The entrypoint, one adapter per harness and the agent under each belong
  // to Boxes.
  const reading = readBox(table(...BOTH_IDLE), BOTH);
  assert.equal(reading.busy, false);
  assert.deepEqual(reading.work, []);
});

test('a box numbered by the host rather than by itself is still idle', () => {
  // `docker top` prints host pids, so no process of the box is 1.
  const reading = readBox(
    table(
      [175384, 175359, '/sbin/docker-init -- /usr/local/bin/entrypoint.sh'],
      [175415, 175384, 'sleep infinity'],
      [175441, 175359, 'node /usr/local/bin/claude-agent-acp'],
      [175478, 175441, CLAUDE_AGENT],
    ),
    BOTH,
  );
  assert.equal(reading.busy, false);
  assert.deepEqual(reading.work, []);
});

test('a shell in a host-numbered box is still the only work in it', () => {
  const reading = readBox(
    table(
      [175384, 175359, '/sbin/docker-init -- /usr/local/bin/entrypoint.sh'],
      [175415, 175384, 'sleep infinity'],
      [175441, 175359, 'node /usr/local/bin/claude-agent-acp'],
      [175478, 175441, CLAUDE_AGENT],
      [175600, 175478, shell('npm run build')],
    ),
    BOTH,
  );
  assert.equal(reading.busy, true);
  assert.equal(reading.work.length, 1);
  assert.match(reading.work[0]?.command ?? '', /npm run build/);
});

test('a shell under either agent is work, and both are named', () => {
  const reading = readBox(
    table(
      ...BOTH_IDLE,
      [23490, 23019, shell('npm run build')],
      [23492, 23490, 'npm run build'],
      [30010, 30002, 'bash -lc npm run watch'],
    ),
    BOTH,
  );
  assert.equal(reading.busy, true);
  // The Claude wrapper, the build under it, and the Codex shell.
  assert.equal(reading.work.length, 3);
  assert.ok(reading.work.some((found) => found.command.includes('npm run build')));
  assert.ok(reading.work.some((found) => found.command === 'bash -lc npm run watch'));
});

test("Codex's sandbox wrappers are the command's own, not the harness's", () => {
  // In the two sandboxed modes a command sits under wrappers. They end with
  // the command, so they count as work.
  const reading = readBox(
    table(
      ...BOTH_IDLE,
      [30010, 30002, '/usr/local/bin/codex-linux-sandbox bash -lc npm test'],
      [30011, 30010, 'bwrap --unshare-user --unshare-pid -- bash -lc npm test'],
      [30012, 30011, 'bash -lc npm test'],
    ),
    BOTH,
  );
  assert.equal(reading.busy, true);
  assert.equal(reading.work.length, 3);
});

test('a build orphaned to PID 1 by a dead adapter still holds the box', () => {
  // The adapter that started it is gone, so no task names it. Only the
  // reading keeps the reaper away.
  const reading = readBox(table(...HELD, [23490, 1, shell('npm run build')]), BOTH);
  assert.equal(reading.busy, true);
  assert.deepEqual(
    reading.work.map((found) => found.command.includes('npm run build')),
    [true],
  );
});

test('what the reading found is named, numbered and aged', () => {
  // The age tells a build somebody waits for from work left behind hours ago.
  const reading = readBox(
    [
      ...table(...HELD),
      { pid: 23490, ppid: 1, command: 'james -config conf/james.yaml', elapsedSeconds: 16_741 },
    ],
    BOTH,
  );
  assert.deepEqual(reading.work, [
    { pid: 23490, command: 'james -config conf/james.yaml', elapsedSeconds: 16_741 },
  ]);
});

test('a box with nothing of ours in it is empty, not unreadable', () => {
  // Boxes spawns an adapter as an exec, so a box that was never opened runs
  // only the entrypoint.
  assert.equal(readBox(table(...HELD), BOTH).busy, false);
  assert.equal(readBox([], BOTH).busy, false);
  // An entrypoint that is PID 1 itself, in a box started without an init.
  assert.equal(readBox(table([1, 0, 'sleep infinity']), BOTH).busy, false);
});

test('the ps that took the reading is not work the reading found', () => {
  // A stop reads the box through its own `ps`, which appears in its output.
  const reading = readBox(table(...HELD, [4242, 0, 'ps -eo pid,ppid,args']), BOTH);
  assert.equal(reading.busy, false);
});

test('an agent an adapter left behind is still the harness, not work', () => {
  // `residentProcesses` matches wherever the process sits. The shell under
  // the agent is still work.
  const reading = readBox(
    table(...HELD, [23019, 1, CLAUDE_AGENT], [23490, 23019, shell('npm test')]),
    BOTH,
  );
  assert.deepEqual(
    reading.work.map((found) => found.command.includes('npm test')),
    [true],
  );
});

// --- stopping what nobody claims -------------------------------------------

test('the pids to kill are the work, leaves before what spawned them', () => {
  const procs = table(
    ...BOTH_IDLE,
    [23490, 23019, shell('npm run build')],
    [23492, 23490, 'node .../vite build'],
    [30010, 30002, 'bash -lc npm run watch'],
  );
  assert.deepEqual(workPids(procs, BOTH), [23492, 23490, 30010]);
});

test('a stop never reaches the box itself', () => {
  // A kill of the adapter, the agent, the entrypoint or the `ps` would stop
  // the conversation rather than its work.
  assert.deepEqual(workPids(table(...BOTH_IDLE, [4242, 0, 'ps -eo pid,ppid,args']), BOTH), []);
});

// --- the probe -------------------------------------------------------------

/** A probe over a table the test can swap, with a clock it can move. */
function probe(initial: ContainerProcess[] | null): {
  p: BackgroundProbe;
  set: (procs: ContainerProcess[] | null) => void;
  fail: (yes: boolean) => void;
  pass: (ms: number) => void;
  reads: () => number;
  trouble: () => Array<string | null>;
  changes: () => boolean[];
  settle: () => Promise<void>;
} {
  let procs = initial;
  let failing = false;
  let reads = 0;
  let now = 1_000_000;
  const trouble: Array<string | null> = [];
  const changes: boolean[] = [];
  const p = new BackgroundProbe({
    list: () => {
      reads += 1;
      return failing ? Promise.reject(new Error('no daemon')) : Promise.resolve(procs);
    },
    harnesses: BOTH,
    ttlMs: 5_000,
    now: () => now,
    onTrouble: (error) => trouble.push(error?.message ?? null),
    onChange: (reading) => changes.push(reading.busy),
  });
  return {
    p,
    set: (next) => {
      procs = next;
    },
    fail: (yes) => {
      failing = yes;
    },
    pass: (ms) => {
      now += ms;
    },
    reads: () => reads,
    trouble: () => trouble,
    changes: () => changes,
    settle: () => p.refresh(),
  };
}

/** The box with a command still going in it. */
const WORKING = table(...BOTH_IDLE, [23490, 23019, shell('npm run build')]);

/** The same box with the command finished. */
const IDLE = table(...BOTH_IDLE);

test('the first reading is not waited for, and lands behind the reader', async () => {
  const { p, settle } = probe(WORKING);
  assert.equal(p.active, null);
  await settle();
  assert.equal(p.active, true);
});

test('what is running is served from the same reading as whether anything is', async () => {
  const { p, settle } = probe(WORKING);
  // Before the first reading, and after it.
  assert.equal(p.work.length, 0);
  await settle();
  assert.equal(p.active, true);
  assert.deepEqual(
    p.work.map((found) => found.command.includes('npm run build')),
    [true],
  );
  // A box that has been shut down holds nothing from that moment.
  p.clear();
  assert.equal(p.work.length, 0);
});

test('a box that has been stopped is empty rather than unread', async () => {
  const { p } = probe(WORKING);
  p.clear();
  assert.equal(p.active, false);
});

test('a reading already on the wire does not undo the stop that overtook it', async () => {
  // The box is read, then shut down, and the reading arrives afterwards.
  let land: (procs: ContainerProcess[]) => void = () => {};
  const p = new BackgroundProbe({
    list: () =>
      new Promise<ContainerProcess[]>((resolve) => {
        land = resolve;
      }),
    harnesses: BOTH,
    ttlMs: 5_000,
  });
  const reading = p.refresh();

  p.clear();
  land(WORKING);
  await reading;

  assert.equal(p.active, false);
});

test('a reading stands until it goes stale', async () => {
  const { p, set, pass, reads, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);
  assert.equal(reads(), 1);

  set(IDLE);
  // Asked again inside the window: the same answer, and the box is not asked.
  assert.equal(p.active, true);
  assert.equal(reads(), 1);

  pass(5_000);
  assert.equal(p.active, true);
  await settle();
  assert.equal(p.active, false);
  assert.equal(reads(), 2);
});

test('work nobody reported the end of is still gone from the next reading', async () => {
  // For example a task killed without notice, a restarted adapter or a lost
  // frame. The reading shows only what runs now.
  const { p, set, pass, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.equal(p.active, false);
});

test('a box going busy or idle is said once, and only when it turns', async () => {
  const { set, pass, changes, settle } = probe(IDLE);
  await settle();
  assert.deepEqual(changes(), []);

  set(WORKING);
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [true]);

  // The same reading again fires nothing.
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [true]);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [true, false]);
});

test('a box that is not there is empty, not unreadable', async () => {
  const { p, settle } = probe(null);
  await settle();
  assert.equal(p.active, false);
});

test('a box that stops is empty from that moment, not from the next reading', async () => {
  const { p, set, changes, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);

  set(null);
  p.clear();
  assert.equal(p.active, false);
  assert.deepEqual(changes(), [true, false]);
});

test('a box that cannot be asked keeps the answer it had, and says so once', async () => {
  // The kept answer holds the reaper off, so the failure must show in the log.
  const { p, fail, pass, trouble, settle } = probe(WORKING);
  await settle();
  assert.deepEqual(trouble(), []);

  fail(true);
  pass(5_000);
  await settle();
  assert.equal(p.active, true);
  assert.deepEqual(trouble(), ['no daemon']);

  // More failures add no line.
  for (let i = 0; i < 3; i += 1) {
    pass(5_000);
    await settle();
  }
  assert.deepEqual(trouble(), ['no daemon']);

  // It reports when readings work again.
  fail(false);
  pass(5_000);
  await settle();
  assert.deepEqual(trouble(), ['no daemon', null]);
});

test('two readers in the same moment are one reading', async () => {
  // For example the reaper sweeping while a browser is served. Each reader
  // finds the same stale answer.
  const { p, reads } = probe(WORKING);
  await Promise.all([p.refresh(), p.refresh(), p.refresh()]);
  assert.equal(reads(), 1);
});

// --- the call that started it ----------------------------------------------

test('the adapters say outright which call backgrounded something', () => {
  // Codex sends no `run_in_background` flag and no tool name, so the marker is
  // its only sign of a backgrounded call.
  const marker = { _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } };
  assert.equal(startsBackgroundWork(marker, HARNESSES.codex.alwaysBackground), true);
  assert.equal(startsBackgroundWork(marker, HARNESSES.claude.alwaysBackground), true);
  // A marker set to false does not count.
  assert.equal(
    startsBackgroundWork(
      { _meta: { jetbrains: { air: { asyncTasks: { backgrounded: false } } } } },
      HARNESSES.codex.alwaysBackground,
    ),
    false,
  );
});

test('a tool call that backgrounds something is still recognisable as one', () => {
  const claude = HARNESSES.claude.alwaysBackground;
  assert.equal(startsBackgroundWork({ rawInput: { command: 'npm test' } }, claude), false);
  assert.equal(
    startsBackgroundWork({ rawInput: { command: 'npm test', run_in_background: true } }, claude),
    true,
  );
  assert.equal(
    startsBackgroundWork({ _meta: { claudeCode: { toolName: 'Monitor' } } }, claude),
    true,
  );
  assert.equal(startsBackgroundWork({ name: 'Bash' }, claude), false);

  // Codex lists no tool that always runs in the background.
  const codex = HARNESSES.codex.alwaysBackground;
  assert.equal(
    startsBackgroundWork({ _meta: { claudeCode: { toolName: 'Monitor' } } }, codex),
    false,
  );
});
