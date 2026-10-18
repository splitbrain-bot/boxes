import type { BackgroundProcess, BoxWork } from '../../../shared/types.ts';
import type { Harness } from '../harness.ts';
import type { ContainerProcess } from '../processes.ts';

/**
 * One `session/update` of the async-task extension, as either adapter sends it.
 *
 * Every field is `unknown`, because no schema covers this extension. {@link TaskBoard.note} needs only the update
 * name and `asyncTaskId`.
 */
export interface AsyncTaskUpdate {
  /** `async_task_spawned`, `async_task_state_update` or `async_task_progress`. */
  sessionUpdate?: unknown;
  /** The adapter's id for the task. */
  asyncTaskId?: unknown;
  /** The command for a shell task, a description for any other kind. */
  name?: unknown;
  /**
   * The kind of the task. Claude sends `shell`, `workflow`, `monitor`, `task` or the raw type of the CLI. Codex sends
   * `shell`.
   */
  taskType?: unknown;
  /** A description of the task, and the only name a progress update carries. */
  description?: unknown;
  /** True when the adapter can stop the task. */
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
 * A thread's bar shows these tasks, and its stop button names them. The adapters do not announce the tasks of a
 * dead process again, so a respawned adapter starts with an empty board. {@link readBox} finds the work that the old
 * process left running.
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
   * @param acpThreadId The adapter's id for the conversation of the update.
   * @param update The `update` field of the `session/update` notification.
   * @returns True when the thread's bar has changed.
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

  /**
   * The tasks one conversation has running.
   *
   * @param acpThreadId The adapter's id for the conversation.
   * @returns The tasks, in the order they arrived.
   */
  for(acpThreadId: string): BackgroundProcess[] {
    return [...(this.byThread.get(acpThreadId)?.values() ?? [])];
  }

  /** The conversations with at least one task running. */
  get threads(): string[] {
    return [...this.byThread].filter(([, tasks]) => tasks.size > 0).map(([thread]) => thread);
  }

  /** True when any conversation of this adapter has a task running. */
  get any(): boolean {
    return this.threads.length > 0;
  }

  /** Number of tasks this adapter has running, across its conversations. */
  get count(): number {
    let total = 0;
    for (const tasks of this.byThread.values()) total += tasks.size;
    return total;
  }

  /**
   * Forgets one task. A stop also calls this, because an adapter that answers
   * `stopped: false` sends no final state update.
   *
   * @param acpThreadId The adapter's id for the conversation.
   * @param taskId The adapter's id for the task.
   * @returns True when the task was on the board.
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
   * @returns The conversations that had a task.
   */
  clear(): string[] {
    const had = this.threads;
    this.byThread.clear();
    return had;
  }

  /**
   * The tasks of one thread, created on first use.
   *
   * @param acpThreadId The adapter's id for the thread.
   * @returns The tasks of the thread by task id.
   */
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
 * The name to show for a task. `name` comes first, then `description`.
 *
 * @param update The async-task update.
 * @returns The trimmed name, or null when the update has neither.
 */
function describe(update: AsyncTaskUpdate): string | null {
  for (const value of [update.name, update.description]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * One reading of the work that runs in a box, which is every process that does not belong to the box setup or to an
 * adapter.
 *
 * The reading covers the whole box. The process table does not show which conversation owns a process, because
 * `codex app-server` runs every Codex conversation of a box in one process.
 */
export interface BoxReading {
  /** True when the reading found work. */
  busy: boolean;
  /**
   * The work found, for the log and for a reader who decides to stop it or not.
   *
   * A stop does not signal these pids, because it reads the table again just
   * before. They tell two identical command lines apart.
   */
  work: readonly BoxWork[];
}

/** The reading of a box that does not exist or is not running. */
const NOTHING: BoxReading = { busy: false, work: [] };

/**
 * The `ps` that took the reading, which appears in its own output, alone or
 * under the `timeout` command that the runtime wraps it in. It is not work and
 * must not be killed.
 */
const READING_ITSELF = /^(?:\S*\/)?(?:timeout\s+(?:-\S+\s+)*\S+\s+(?:\S*\/)?)?ps(?:\s|$)/;

/**
 * The file service, which the orchestrator starts in the box. Its script runs
 * under node, so `ps` shows the interpreter first.
 */
const FILE_SERVICE = /^(?:\S*\/)?(?:node\s+)?(?:\S*\/)?boxes-files(?:\s|$)/;

/** The command the entrypoint execs to hold the container open. */
const ENTRYPOINT_HOLD = 'sleep infinity';

/** The pid of a box's init in the box's own numbering. */
const INIT_PID = 1;

/**
 * Checks if one process is resident, which means it belongs to the box setup or to an adapter and is not work.
 *
 * Work includes a build orphaned by an adapter that died, and the sandbox wrappers around a Codex command.
 *
 * @param process The process to check.
 * @param adapters The pids of the adapter processes.
 * @param harnesses Every harness. With one missing, the adapter and the agent of that harness read as work.
 * @returns True when the process is resident.
 */
function isResident(
  process: ContainerProcess,
  adapters: ReadonlySet<number>,
  harnesses: readonly Harness[],
): boolean {
  if (process.pid === INIT_PID) return true;
  if (process.ppid === INIT_PID && process.command.trim() === ENTRYPOINT_HOLD) return true;
  if (adapters.has(process.pid)) return true;
  // The direct children of an adapter are the agent processes.
  if (adapters.has(process.ppid)) return true;
  if (READING_ITSELF.test(process.command.trim())) return true;
  if (FILE_SERVICE.test(process.command.trim())) return true;
  return harnesses.some((h) =>
    h.residentProcesses.some((pattern) => pattern.test(process.command)),
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
 *
 * @param processes The processes of the box.
 * @param harnesses Every harness.
 * @returns The pids of the adapters.
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
  /** Checks if an ancestor of a process carries an adapter's token. */
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
  return new Set(processes.filter((p) => carries(p) && !named(p) && !under(p)).map((p) => p.pid));
}

/**
 * Finds the work that runs in a box.
 *
 * The reaper uses this reading next to the task events, because a respawned adapter does not know the work that
 * its predecessor left running. A running box with no adapter, which runs only the entrypoint, reads as empty.
 *
 * @param processes The processes of the box.
 * @param harnesses Every harness.
 * @returns The reading.
 */
export function readBox(
  processes: readonly ContainerProcess[],
  harnesses: readonly Harness[],
): BoxReading {
  const adapters = adapterPids(processes, harnesses);
  const work = processes
    .filter((p) => !isResident(p, adapters, harnesses))
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
 *
 * @param processes The processes of the box, read inside the box just now.
 * @param harnesses Every harness.
 * @returns The pids of the work, deepest first.
 */
export function workPids(
  processes: readonly ContainerProcess[],
  harnesses: readonly Harness[],
): number[] {
  const adapters = adapterPids(processes, harnesses);
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  /** The number of steps from a process up to the root. A loop in the parent chain ends the count. */
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
    .filter((p) => !isResident(p, adapters, harnesses))
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
  /** Every harness, because one box can hold the adapters of both. */
  harnesses: readonly Harness[];
  /** Time that one reading stays current, in milliseconds. */
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
 * The cached reading of one container.
 *
 * Readers get the last reading at once and never wait. A reading older than `ttlMs` starts a refresh in the
 * background.
 */
export class BackgroundProbe {
  /** The last reading. */
  private reading: BoxReading = NOTHING;
  /** The time of the last reading, or of the last failed reading. */
  private readAt = -Infinity;
  /** The reading being taken, if any. */
  private inFlight: Promise<void> | null = null;
  /** True after the first reading, so an empty reading is an answer. */
  private read = false;
  /**
   * Counts the times {@link BackgroundProbe.clear} has set the answer. A reading that started
   * under an older count is dropped.
   */
  private generation = 0;
  /** True while readings fail, so the class reports the trouble once. */
  private failing = false;

  /** Lists the processes of the box, or null when it is not running. */
  private readonly list: ProbeOptions['list'];
  /** Every harness, to tell resident processes from work. */
  private readonly harnesses: readonly Harness[];
  /** Time that one reading stays current, in milliseconds. */
  private readonly ttlMs: number;
  /** The clock. */
  private readonly now: () => number;
  /** Runs when readings start or stop failing. */
  private readonly onTrouble: (error: Error | null) => void;
  /** Runs when the box changes between busy and idle. */
  private readonly onChange: (reading: BoxReading) => void;

  /** @param options The process source, the harnesses, the reading lifetime and the callbacks. */
  constructor(options: ProbeOptions) {
    this.list = options.list;
    this.harnesses = options.harnesses;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.onTrouble = options.onTrouble ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
  }

  /**
   * True when work runs in the box, or null before the first reading.
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
   * The work that the last reading found. Empty before the first reading.
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

  /**
   * Reads the box, at most one reading at a time.
   *
   * @returns A promise that resolves when the reading is done or has failed.
   */
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
 * Checks if a tool call leaves something running after the turn that made it.
 *
 * Both adapters set the `_meta.jetbrains.air.asyncTasks.backgrounded` marker on the `tool_call_update` of a shell
 * command that went to the background, because the gateway advertises the `asyncTasks` capability. Under Claude
 * this is a Bash call. The marker is the only sign that Codex sends. Claude also sends the
 * `rawInput.run_in_background` flag and a tool name.
 *
 * @param update The tool call update.
 * @param alwaysBackground The tool names of the harness that always run in the background.
 * @returns True when the call starts background work.
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
