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

/**
 * What a thread is told it has running, and what the box says underneath it.
 *
 * Two questions with two answers. The adapters name the tasks, which is the
 * only way a stop can name one; the process table says whether the box is
 * busy, which is the only answer that survives an adapter restart. The
 * fixtures below are the shapes both harnesses really leave in a container.
 */

/** Both harnesses, which is what a reading of a box is taken against. */
const BOTH: readonly Harness[] = [HARNESSES.claude, HARNESSES.codex];

/** Two conversations of the same box. */
const ONE = '90732d29-a1aa-4df7-9b78-a726bb859148';
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
  // And only that thread. The other conversation in the same box is told
  // nothing, which is the whole of who a task belongs to.
  assert.deepEqual(board.for(TWO), []);
  assert.deepEqual(board.threads, [ONE]);
});

test('a task with no name of its own is still something a person can read', () => {
  const board = new TaskBoard();
  // Claude's shell tasks carry the command as both `name` and `description`;
  // its other kinds carry a description alone, and a monitor with neither
  // would otherwise draw a blank line with a stop button beside it.
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
  // Claude reports `running` and `paused` as it goes; Codex, as far as its
  // source shows, sends only the terminal states. Either way a bar that
  // already shows the task has nothing to redraw.
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));
  assert.equal(board.note(ONE, state('task-1', 'running')), false);
  assert.equal(board.note(ONE, state('task-1', 'paused')), false);
  assert.equal(board.for(ONE).length, 1);
});

test('progress may rename a task and is required to say nothing at all', () => {
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));

  // Claude only, and every field of it optional. One that carries a
  // description says what the task is doing now; one that carries none is
  // still a perfectly good update.
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
  // A state update for a task of some other adapter, or one this connection
  // has already dropped. Inventing an entry from it would put a task on a bar
  // with no spawn to say what it is.
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
  // What an adapter answering `stopped: false` means: the task finished
  // between the reading the browser is showing and the button being pressed,
  // and no state update is coming for it any more.
  const board = new TaskBoard();
  board.note(ONE, spawned('task-1'));
  assert.equal(board.drop(ONE, 'task-1'), true);
  assert.equal(board.drop(ONE, 'task-1'), false);
  assert.deepEqual(board.for(ONE), []);
});

test('an adapter that has gone takes every task it announced with it', () => {
  // Nothing re-announces them on the respawn: Claude's replay mentions tasks
  // nowhere, and Codex's reconciles against a fresh app-server that owns none
  // of the old terminals. The threads come back so their bars can be redrawn
  // empty, and what is still running in the box is the reading's to find.
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

/** The adapter as the registry spawns it, and the agent underneath it. */
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
  // Every one of these is Boxes' own: the entrypoint holding the container
  // open, an adapter per harness, and the agent process each one drives. A
  // rule that knew one harness's shape would read the other's box as busy
  // forever, or as empty with a build in it.
  const reading = readBox(table(...BOTH_IDLE), BOTH);
  assert.equal(reading.busy, false);
  assert.deepEqual(reading.work, []);
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
  // What it is running, for the log: the words are in the wrapper, and the
  // line is the evidence of what a box nobody can name work in was doing.
  assert.equal(reading.work.length, 3);
  assert.ok(reading.work.some((line) => line.includes('npm run build')));
  assert.ok(reading.work.includes('bash -lc npm run watch'));
});

test("Codex's sandbox wrappers are the command's own, not the harness's", () => {
  // In the two sandboxed modes a command sits three wrappers down. Every one
  // of them belongs to that command and goes when it goes, so reading them as
  // work is right — and is what makes the box busy while the command runs.
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
  // The case the whole floor exists for. The adapter that started this is
  // gone, so no task names it and no bar shows it; the box is still building
  // and must not be reaped.
  const reading = readBox(table(...HELD, [23490, 1, shell('npm run build')]), BOTH);
  assert.equal(reading.busy, true);
  assert.deepEqual(
    reading.work.map((line) => line.includes('npm run build')),
    [true],
  );
});

test('a box with nothing of ours in it is empty, not unreadable', () => {
  // Boxes spawns an adapter as an exec and keeps none there between
  // connections, so a container that is up and has never been opened runs the
  // entrypoint and nothing else. Counting that as busy would put "still
  // running" on its card and keep the reaper off it for as long as it is up.
  assert.equal(readBox(table(...HELD), BOTH).busy, false);
  assert.equal(readBox([], BOTH).busy, false);
  // And an entrypoint that is PID 1 itself, in a box started without an init.
  assert.equal(readBox(table([1, 0, 'sleep infinity']), BOTH).busy, false);
});

test('the ps that took the reading is not work the reading found', () => {
  // A stop reads the box through its own `ps`, from inside, and that process
  // is in the table it prints. Counting it would make every box busy the
  // moment it was asked, and killing it would be Boxes shooting its own
  // reading.
  const reading = readBox(table(...HELD, [4242, 0, 'ps -eo pid,ppid,args']), BOTH);
  assert.equal(reading.busy, false);
});

test('an agent an adapter left behind is still the harness, not work', () => {
  // `residentProcesses` is matched wherever the process sits, so an agent
  // outliving its adapter does not read as a running command — while the
  // shell under it does.
  const reading = readBox(
    table(...HELD, [23019, 1, CLAUDE_AGENT], [23490, 23019, shell('npm test')]),
    BOTH,
  );
  assert.deepEqual(
    reading.work.map((line) => line.includes('npm test')),
    [true],
  );
});

// --- stopping what nobody claims -------------------------------------------

test('the pids to kill are the work, leaves before what spawned them', () => {
  // A parent killed first hands its children to init, still running and out
  // of every reading — a box that looks empty with a build in it.
  const procs = table(
    ...BOTH_IDLE,
    [23490, 23019, shell('npm run build')],
    [23492, 23490, 'node .../vite build'],
    [30010, 30002, 'bash -lc npm run watch'],
  );
  assert.deepEqual(workPids(procs, BOTH), [23492, 23490, 30010]);
});

test('a stop never reaches the box itself', () => {
  // No adapter, no agent, no entrypoint and no `ps`: a kill that took any of
  // them would stop the conversation rather than its work.
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
  // Nothing has been read yet, and an unstarted box has nothing in it.
  assert.equal(p.active, false);
  await settle();
  assert.equal(p.active, true);
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
  // The whole point of a level. A task killed with no notification, an
  // adapter restarted, a frame lost: all answer correctly here, because the
  // question is about the present rather than about what was announced.
  const { p, set, pass, settle } = probe(WORKING);
  await settle();
  assert.equal(p.active, true);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.equal(p.active, false);
});

test('a box going busy or idle is said once, and only when it turns', async () => {
  // It is the log's only news about work no conversation can name — a card
  // saying "still running" with every thread of it quiet is otherwise
  // indistinguishable from a fault.
  const { set, pass, changes, settle } = probe(IDLE);
  await settle();
  assert.deepEqual(changes(), []);

  set(WORKING);
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [true]);

  // A reading that says the same thing again says nothing at all.
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [true]);

  set(IDLE);
  pass(5_000);
  await settle();
  assert.deepEqual(changes(), [true, false]);
});

test('a box that is not there is empty, not unreadable', async () => {
  // The two answers are opposites — one is knowledge, the other is silence —
  // and they arrived here as the same empty table. So every session that had
  // ever been started and was now stopped said "still running" for as long as
  // the orchestrator remembered it.
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
  // The answer is a guess for as long as this lasts, and the guess holds the
  // reaper off — so a probe that has quietly stopped working is a session
  // that never stops, for a reason nobody can see.
  const { p, fail, pass, trouble, settle } = probe(WORKING);
  await settle();
  assert.deepEqual(trouble(), []);

  fail(true);
  pass(5_000);
  await settle();
  assert.equal(p.active, true);
  assert.deepEqual(trouble(), ['no daemon']);

  // Still broken a minute later, and still one line: a poll that reported
  // every failure would bury the one that mattered.
  for (let i = 0; i < 3; i += 1) {
    pass(5_000);
    await settle();
  }
  assert.deepEqual(trouble(), ['no daemon']);

  // And it says when it is reading again, because until then every answer it
  // gave was the last one it was sure of.
  fail(false);
  pass(5_000);
  await settle();
  assert.deepEqual(trouble(), ['no daemon', null]);
});

test('two readers in the same moment are one reading', async () => {
  // `active` starts a refresh when it finds a stale answer, and every reader
  // finds it stale at once — the reaper sweeping while a browser is served.
  const { p, reads } = probe(WORKING);
  await Promise.all([p.refresh(), p.refresh(), p.refresh()]);
  assert.equal(reads(), 1);
});

// --- the call that started it ----------------------------------------------

test('the adapters say outright which call backgrounded something', () => {
  // The marker both adapters put on the call's own update, and the only one of
  // the three answers that speaks for Codex: it has no `run_in_background`
  // flag and puts no tool name on a call at all.
  const marker = { _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } };
  assert.equal(startsBackgroundWork(marker, HARNESSES.codex.alwaysBackground), true);
  assert.equal(startsBackgroundWork(marker, HARNESSES.claude.alwaysBackground), true);
  // A call the adapter has not marked is not one, whatever else is on it.
  assert.equal(
    startsBackgroundWork(
      { _meta: { jetbrains: { air: { asyncTasks: { backgrounded: false } } } } },
      HARNESSES.codex.alwaysBackground,
    ),
    false,
  );
});

test('a tool call that backgrounds something is still recognisable as one', () => {
  // Asked in activity.ts, because a call that runs in the background is the
  // call whose silence says nothing about whether the agent is working.
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

  // Which names those are is the harness's, from the registry: Codex has no
  // tool that backgrounds itself, and `Monitor` there is a tool name like any
  // other.
  const codex = HARNESSES.codex.alwaysBackground;
  assert.equal(
    startsBackgroundWork({ _meta: { claudeCode: { toolName: 'Monitor' } } }, codex),
    false,
  );
});
