import type { ContainerProcess } from '../docker.ts';
import type { Harness } from '../harness.ts';
import type { BackgroundProcess, BoxWork } from '../../../shared/types.ts';

// --- what the adapters say -------------------------------------------------

/**
 * One `session/update` of the async-task extension, as either adapter sends it.
 *
 * Every field is `unknown`, because no schema covers this extension. Only
 * the update names and `asyncTaskId` are required.
 */
export interface AsyncTaskUpdate {
  /** `async_task_spawned`, `async_task_state_update` or `async_task_progress`. */
  sessionUpdate?: unknown;
  /** The adapter's id for the task. */
  asyncTaskId?: unknown;
  /** The command for a shell task, a description for any other kind. */
  name?: unknown;
  /** `shell`, `workflow`, `monitor` or `task` under Claude; always `shell` under Codex. */
  taskType?: unknown;
  /** A description of the task, and the only name a progress update carries. */
  description?: unknown;
  /** Whether the adapter can stop the task. */
  canStop?: unknown;
  /** On a state update: `running`, `paused`, `completed`, `failed` or `stopped`. */
  state?: unknown;
}

/** States that mean the task is over. */
const OVER = new Set(['completed', 'failed', 'stopped']);

/** The name shown for a task that has none. */
const UNNAMED_TASK = 'a background task';

/**
 * The tasks one adapter process has announced, by the conversation they are on.
 *
 * These are what a thread's bar shows and what its stop button names. Neither
 * adapter re-announces the tasks of a process that has died, so a respawned
 * adapter starts with an empty board. What the old process left running is
 * found by {@link readBox}.
 */
export class TaskBoard {
  /** The tasks of each thread by task id, in the order they arrived. */
  private readonly byThread = new Map<string, Map<string, BackgroundProcess>>();

  /** @param now The clock that stamps a task's start. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Reads one update for what it says about a task.
   *
   * A spawn adds an entry, a final state removes it, and a progress update may
   * rename one. Anything else leaves the board as it is.
   *
   * @returns Whether the thread's bar has changed.
   */
  note(acpThreadId: string, update: unknown): boolean {
    if (!update || typeof update !== 'object') return false;
    const u = update as AsyncTaskUpdate;
    const taskId = typeof u.asyncTaskId === 'string' ? u.asyncTaskId : null;
    if (!taskId) return false;

    switch (u.sessionUpdate) {
      case 'async_task_spawned': {
        const tasks = this.tasksOf(acpThreadId);
        tasks.set(taskId, {
          id: taskId,
          command: describe(u) ?? UNNAMED_TASK,
          // The adapter's own word, not mapped onto a fixed list.
          kind: typeof u.taskType === 'string' ? u.taskType : 'task',
          // A task that says it cannot be stopped gets no stop button.
          stoppable: u.canStop === true,
          startedAt: this.now(),
        });
        return true;
      }
      case 'async_task_state_update': {
        if (typeof u.state !== 'string' || !OVER.has(u.state)) return false;
        return this.drop(acpThreadId, taskId);
      }
      case 'async_task_progress': {
        // Sent by Claude only. One without a description changes nothing.
        const named = describe(u);
        const task = this.byThread.get(acpThreadId)?.get(taskId);
        if (!task || !named || task.command === named) return false;
        task.command = named;
        return true;
      }
      default:
        return false;
    }
  }

  /** The tasks one conversation has running. */
  for(acpThreadId: string): BackgroundProcess[] {
    return [...(this.byThread.get(acpThreadId)?.values() ?? [])];
  }

  /** The conversations with at least one task running. */
  get threads(): string[] {
    return [...this.byThread].filter(([, tasks]) => tasks.size > 0).map(([thread]) => thread);
  }

  /** Whether any conversation of this adapter has a task running. */
  get any(): boolean {
    return this.threads.length > 0;
  }

  /**
   * Forgets one task. A stop also calls this, because an adapter that answers
   * `stopped: false` sends no final state update.
   *
   * @returns Whether the task was on the board.
   */
  drop(acpThreadId: string, taskId: string): boolean {
    const tasks = this.byThread.get(acpThreadId);
    if (!tasks?.delete(taskId)) return false;
    if (tasks.size === 0) this.byThread.delete(acpThreadId);
    return true;
  }

  /**
   * Forgets every task, for a process that has gone.
   *
   * @returns The conversations that had a task, so their browsers can be told.
   */
  clear(): string[] {
    const had = this.threads;
    this.byThread.clear();
    return had;
  }

  /** The tasks of one thread, created on first use. */
  private tasksOf(acpThreadId: string): Map<string, BackgroundProcess> {
    let tasks = this.byThread.get(acpThreadId);
    if (!tasks) {
      tasks = new Map();
      this.byThread.set(acpThreadId, tasks);
    }
    return tasks;
  }
}

/**
 * The name to show for a task: `name` when set, else `description`, else null.
 */
function describe(update: AsyncTaskUpdate): string | null {
  for (const value of [update.name, update.description]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// --- what the box says -----------------------------------------------------

/**
 * One reading of a box: whether anything is running in it that Boxes did not
 * put there, and what.
 *
 * The reading covers the whole box. The process table cannot say which
 * conversation owns a process: `codex app-server` runs every Codex
 * conversation of a box in one process.
 */
export interface BoxReading {
  /** Whether anything is running that Boxes did not put there to hold the box open. */
  busy: boolean;
  /**
   * The work found, for the log and for a reader deciding whether to stop it.
   *
   * The pids may be host pids, so a stop does not signal them. They tell two
   * identical command lines apart.
   */
  work: readonly BoxWork[];
}

/** The reading of a box that does not exist or is not running. */
const NOTHING: BoxReading = { busy: false, work: [] };

/**
 * The `ps` that took a reading from inside the box, which appears in its own
 * output. It is not work and must not be killed.
 */
const READING_ITSELF = /^(?:\S*\/)?ps(?:\s|$)/;

/** The command the entrypoint execs to hold the container open. */
const ENTRYPOINT_HOLD = 'sleep infinity';

/**
 * The command of a box's init, or of the entrypoint where there is no init.
 *
 * Matched on the command rather than on PID 1, because `docker top` reports
 * host pids, where no process of the box is 1.
 */
const BOX_INIT = /^(?:\S*\/)?(?:docker-init|tini)(?:\s|$)|entrypoint\.sh(?:\s|$)/;

/**
 * Whether one process belongs to the box itself rather than to work done in it.
 *
 * Resident processes are the box's init and its `sleep infinity`, every adapter, every
 * adapter's direct children (the agent processes), anything matching a
 * harness's `residentProcesses`, and the `ps` that took the reading.
 * Everything else is work, including a build orphaned by an adapter that died
 * and the sandbox wrappers around a Codex command.
 *
 * `harnesses` must list every harness. With one missing, a box running that
 * harness reads as empty.
 */
function isResident(
  process: ContainerProcess,
  adapters: ReadonlySet<number>,
  harnesses: readonly Harness[],
  inits: ReadonlySet<number>,
): boolean {
  if (inits.has(process.pid)) return true;
  if (inits.has(process.ppid) && process.command.trim() === ENTRYPOINT_HOLD) return true;
  if (adapters.has(process.pid)) return true;
  if (adapters.has(process.ppid)) return true;
  if (READING_ITSELF.test(process.command.trim())) return true;
  return harnesses.some((h) =>
    h.residentProcesses.some((pattern) => pattern.test(process.command)),
  );
}

/**
 * The pids of whatever holds the box open: the init, or a `sleep infinity`
 * at the root of the tree where there is no init.
 *
 * A root is a process whose parent is not in the reading. This works with
 * pids from inside the box and with host pids. When no hold is found, the
 * `sleep infinity` counts as work, which keeps the box awake.
 */
function initPids(processes: readonly ContainerProcess[]): Set<number> {
  const listed = new Set(processes.map((p) => p.pid));
  return new Set(
    processes
      .filter((p) => {
        const command = p.command.trim();
        if (BOX_INIT.test(command)) return true;
        return command === ENTRYPOINT_HOLD && !listed.has(p.ppid);
      })
      .map((p) => p.pid),
  );
}

/**
 * The pids of every adapter process in a box, found by each harness's
 * `processToken`.
 *
 * The token also appears in the agent's path, because the Claude CLI lives
 * inside the `claude-agent-acp` package. A process is not an adapter when it
 * matches a harness's `residentProcesses`, or when a process above it carries
 * a token. Reading an agent as an adapter would hide the shells under it.
 */
function adapterPids(
  processes: readonly ContainerProcess[],
  harnesses: readonly Harness[],
): Set<number> {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const carries = (p: ContainerProcess): boolean =>
    harnesses.some((h) => p.command.includes(h.processToken));
  const named = (p: ContainerProcess): boolean =>
    harnesses.some((h) => h.residentProcesses.some((pattern) => pattern.test(p.command)));
  /** Whether anything above a process carries an adapter's token. */
  const under = (start: ContainerProcess): boolean => {
    const seen = new Set<number>([start.pid]);
    let at = byPid.get(start.ppid);
    while (at && !seen.has(at.pid)) {
      if (carries(at)) return true;
      seen.add(at.pid);
      at = byPid.get(at.ppid);
    }
    return false;
  };
  return new Set(
    processes.filter((p) => carries(p) && !named(p) && !under(p)).map((p) => p.pid),
  );
}

/**
 * What is running in a box that Boxes did not put there.
 *
 * The reaper relies on this rather than on task events: a respawned adapter
 * knows nothing of the work its predecessor left running. A running box with
 * no adapter, which runs only the entrypoint, reads as empty.
 */
export function readBox(
  processes: readonly ContainerProcess[],
  harnesses: readonly Harness[],
): BoxReading {
  const adapters = adapterPids(processes, harnesses);
  const inits = initPids(processes);
  const work = processes
    .filter((p) => !isResident(p, adapters, harnesses, inits))
    .map((p) => ({
      pid: p.pid,
      command: p.command.trim(),
      elapsedSeconds: p.elapsedSeconds,
    }));
  return { busy: work.length > 0, work };
}

/**
 * The pids to kill to empty a box, deepest first.
 *
 * Uses the same rule as {@link readBox}. The processes must come from a
 * reading taken inside the box just now, so the pids fit a `kill` there.
 * Children come before parents, because a parent killed first hands its
 * children to init before they are signalled.
 */
export function workPids(
  processes: readonly ContainerProcess[],
  harnesses: readonly Harness[],
): number[] {
  const adapters = adapterPids(processes, harnesses);
  const inits = initPids(processes);
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  /** How far under the root a process sits; anything that loops is shallow. */
  const depth = (start: ContainerProcess): number => {
    const seen = new Set<number>();
    let at: ContainerProcess | undefined = start;
    let steps = 0;
    while (at && !seen.has(at.pid)) {
      seen.add(at.pid);
      at = byPid.get(at.ppid);
      steps += 1;
    }
    return steps;
  };
  return processes
    .filter((p) => !isResident(p, adapters, harnesses, inits))
    .map((p) => ({ pid: p.pid, depth: depth(p) }))
    .sort((a, b) => b.depth - a.depth)
    .map((p) => p.pid);
}

/** Options for a {@link BackgroundProbe}. */
export interface ProbeOptions {
  /**
   * Lists the processes of the box. Resolves to null when there is no
   * container or it is not running, which reads as nothing running.
   */
  list: () => Promise<ContainerProcess[] | null>;
  /** Every harness, because a box may run either adapter, or both. */
  harnesses: readonly Harness[];
  /** How long one reading stays current, in milliseconds. */
  ttlMs: number;
  /** The clock. A test can replace it. */
  now?: () => number;
  /**
   * Receives the error when readings start failing, and null when they work
   * again. It runs on changes only, so a failing box logs one line.
   */
  onTrouble?: (error: Error | null) => void;
  /**
   * Receives the reading whenever the box changes between busy and idle.
   *
   * It exists for the log. Work that no thread has a task for, such as work
   * left by a dead adapter, is visible only through the commands it reports.
   */
  onChange?: (reading: BoxReading) => void;
}

/**
 * The reading of one container, taken again at most once per `ttlMs`.
 *
 * Readers get the last reading at once and never wait. A stale reading starts
 * a refresh in the background.
 */
export class BackgroundProbe {
  /** The last reading. */
  private reading: BoxReading = NOTHING;
  /** When the last reading was taken or failed. */
  private readAt = -Infinity;
  /** The reading being taken, if any. */
  private inFlight: Promise<void> | null = null;
  /** Whether the box has been read at all, so an empty reading is an answer. */
  private read = false;
  /**
   * Counts the times {@link clear} has set the answer. A reading that started
   * under an older count is dropped.
   */
  private generation = 0;
  /** Whether the last reading failed, so the trouble is reported once. */
  private failing = false;

  /** Lists the processes of the box, or null when it is not running. */
  private readonly list: ProbeOptions['list'];
  /** Every harness, to tell resident processes from work. */
  private readonly harnesses: readonly Harness[];
  /** How long one reading stays current, in milliseconds. */
  private readonly ttlMs: number;
  /** The clock. */
  private readonly now: () => number;
  /** Runs when readings start or stop failing. */
  private readonly onTrouble: (error: Error | null) => void;
  /** Runs when the box changes between busy and idle. */
  private readonly onChange: (reading: BoxReading) => void;

  constructor(options: ProbeOptions) {
    this.list = options.list;
    this.harnesses = options.harnesses;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.onTrouble = options.onTrouble ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
  }

  /**
   * Whether anything is running in the box, or null before the first reading.
   * Starts a refresh when the reading is stale.
   *
   * Null does not mean nothing is running. A caller that stops boxes must
   * keep a box it has no answer for.
   */
  get active(): boolean | null {
    this.freshen();
    return this.read ? this.reading.busy : null;
  }

  /**
   * What the last reading found running. Empty before the first reading.
   * Starts a refresh when the reading is stale.
   */
  get work(): readonly BoxWork[] {
    this.freshen();
    return this.reading.work;
  }

  /**
   * Sets the reading to nothing running, for a box that is stopping.
   *
   * A reading still in flight is dropped when it lands.
   */
  clear(): void {
    const before = this.reading;
    this.reading = NOTHING;
    this.readAt = -Infinity;
    // A stopped box is known to be empty.
    this.read = true;
    this.generation += 1;
    if (before.busy) this.onChange(this.reading);
  }

  /** Starts a reading if the last one has gone stale. */
  private freshen(): void {
    if (this.now() - this.readAt >= this.ttlMs) void this.refresh();
  }

  /** Reads the box, at most one reading at a time. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = this.list()
      .then((processes) => {
        // A clear() since this reading started has settled the answer.
        if (generation !== this.generation) return;
        const before = this.reading;
        this.reading = processes === null ? NOTHING : readBox(processes, this.harnesses);
        this.readAt = this.now();
        this.read = true;
        if (this.failing) {
          this.failing = false;
          this.onTrouble(null);
        }
        if (before.busy !== this.reading.busy) this.onChange(this.reading);
      })
      .catch((error: Error) => {
        // A failed reading keeps the last answer until a later one succeeds.
        this.readAt = this.now();
        if (!this.failing) {
          this.failing = true;
          this.onTrouble(error);
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

// --- the call that started it ----------------------------------------------

/** The fields of a tool call update that {@link startsBackgroundWork} reads. */
export interface ToolCallUpdate {
  /** The tool name, where the adapter sets one. */
  name?: string;
  /** The tool's input as the agent sent it. */
  rawInput?: unknown;
  /** Adapter extensions that name the tool or mark the call as backgrounded. */
  _meta?: {
    claudeCode?: { toolName?: string };
    jetbrains?: { air?: { asyncTasks?: { backgrounded?: unknown } } };
  };
}

/**
 * Whether a tool call leaves something running after the turn that made it.
 *
 * Three checks, in order. The `_meta.jetbrains.air.asyncTasks.backgrounded`
 * marker, which both adapters set and the only one Codex sends. Claude's
 * `rawInput.run_in_background` flag, which arrives with the call. And the tool
 * name, checked against `alwaysBackground`, the harness's list of tools that
 * always run in the background.
 */
export function startsBackgroundWork(
  update: ToolCallUpdate,
  alwaysBackground: ReadonlySet<string>,
): boolean {
  if (update._meta?.jetbrains?.air?.asyncTasks?.backgrounded === true) return true;
  const input = update.rawInput;
  if (
    input &&
    typeof input === 'object' &&
    (input as { run_in_background?: unknown }).run_in_background === true
  ) {
    return true;
  }
  const tool = update._meta?.claudeCode?.toolName ?? update.name ?? null;
  return typeof tool === 'string' && alwaysBackground.has(tool);
}
