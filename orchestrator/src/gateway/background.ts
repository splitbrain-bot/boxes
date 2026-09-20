import type { ContainerProcess } from '../docker.ts';
import type { Harness } from '../harness.ts';
import type { BackgroundProcess } from '../../../shared/types.ts';

/**
 * What a session has left running: what the adapters say, and what the box
 * says underneath them.
 *
 * A turn that leaves something running in the background ends like any other:
 * the agent says it will report back, the thread goes quiet, and — with the
 * browser closed — every test the reaper makes says the session is idle. Half
 * an hour later the container is stopped, and with it the build, the crawl or
 * the monitor watching them.
 *
 * Two answers, and they are not the same question.
 *
 * **What a person sees comes from the adapters.** Both harnesses implement the
 * same async-task extension: a task is announced with an id, a name and a kind,
 * and it is announced again when it ends. {@link TaskBoard} is the translation,
 * and what it holds is what a thread's bar shows and what its stop button
 * names. That is the only way a task can be named at all — the id a stop sends
 * is the adapter's, and no reading of the process table has it.
 *
 * **Whether the box is busy comes from the box.** The reaper's question has to
 * be answerable when no adapter is running and when not every thread is
 * loaded, and no event can answer it: a respawned adapter knows nothing about
 * the shells the one before it left running, so after any restart the bars are
 * empty and the build is still compiling. {@link readBox} is a level rather
 * than a count of transitions — it cannot drift, it needs nothing reported, and
 * a task killed with no notification answers correctly on the next reading.
 *
 * **The events decorate the reading. They never replace it.** A missed event
 * costs a name on a bar. A missed reading costs a build.
 */

// --- what the adapters say -------------------------------------------------

/**
 * One `session/update` about a task, as either adapter sends it.
 *
 * Typed loosely on purpose: the ACP SDK carries no types for this extension,
 * the gateway passes its frames through raw, and every field here belongs to
 * an adapter rather than to a specification. What is relied on is the three
 * update names and `asyncTaskId`; everything else is read where it is there.
 */
export interface AsyncTaskUpdate {
  sessionUpdate?: unknown;
  asyncTaskId?: unknown;
  /** The command for a shell task, a description for any other kind. */
  name?: unknown;
  /** `shell`, `workflow`, `monitor` or `task` under Claude; always `shell` under Codex. */
  taskType?: unknown;
  description?: unknown;
  canStop?: unknown;
  /** On a state update: `running`, `paused`, `completed`, `failed` or `stopped`. */
  state?: unknown;
}

/** States that mean the task is over, whichever way it went. */
const OVER = new Set(['completed', 'failed', 'stopped']);

/** What a task with no name to show is called, so a bar never draws a blank. */
const UNNAMED_TASK = 'a background task';

/**
 * The tasks one adapter process has announced, by the conversation they are on.
 *
 * Held in memory beside the connection that announced them, and gone with it.
 * Neither adapter re-announces the tasks of a process that has died — Claude's
 * replay mentions them nowhere, and Codex's reconciles against a fresh
 * app-server that owns none of the old terminals — so a respawn starts with an
 * empty board, and what the old process left running is the floor's to find.
 */
export class TaskBoard {
  /** Thread id → task id → what that task is, in the order they arrived. */
  private readonly byThread = new Map<string, Map<string, BackgroundProcess>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Reads one update for what it says about a task, and answers whether the
   * thread's bar has changed.
   *
   * A spawn adds an entry, a terminal state removes it, and a progress update
   * may rename one. `running` and `paused` keep what is there: a task that
   * reports itself still running is not news. Anything else — a state for a
   * task this process never announced, an update with no id on it — is passed
   * over, because the answer to a bar showing a stale task is the next state
   * update rather than a guess made here.
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
          // Codex sends `shell` and nothing else; Claude's four kinds are its
          // own. Kept as the adapter's word rather than mapped onto an
          // enumeration Boxes would have to keep in step with two harnesses.
          kind: typeof u.taskType === 'string' ? u.taskType : 'task',
          // Both adapters send true today. A task that says it cannot be
          // stopped is shown without a button rather than with one that
          // answers `stopped: false` every time.
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
        // Claude only, and nothing is required of it: a progress update that
        // carries no description says nothing this holds.
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

  /** What one conversation has running, for the bar above its composer. */
  for(acpThreadId: string): BackgroundProcess[] {
    return [...(this.byThread.get(acpThreadId)?.values() ?? [])];
  }

  /** The conversations with something running, for a list that shows them all. */
  get threads(): string[] {
    return [...this.byThread].filter(([, tasks]) => tasks.size > 0).map(([thread]) => thread);
  }

  /** Whether any conversation of this adapter has a task running. */
  get any(): boolean {
    return this.threads.length > 0;
  }

  /**
   * Forgets one task, and says whether it was there.
   *
   * The stop uses this as well as the terminal update: an adapter answering
   * `stopped: false` is saying the task was already over, and a bar still
   * showing it has to catch up without waiting for a state update that is
   * never coming.
   */
  drop(acpThreadId: string, taskId: string): boolean {
    const tasks = this.byThread.get(acpThreadId);
    if (!tasks?.delete(taskId)) return false;
    if (tasks.size === 0) this.byThread.delete(acpThreadId);
    return true;
  }

  /**
   * Forgets everything, for a process that has gone, and answers with the
   * conversations that had something so their browsers can be told.
   */
  clear(): string[] {
    const had = this.threads;
    this.byThread.clear();
    return had;
  }

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
 * What to call a task, from whichever of the two fields carries it.
 *
 * `name` is the command for a shell task under both adapters — Codex strips
 * its own `bash -lc` wrapper before sending it — and a description for
 * anything else. `description` is the fallback, and the only thing a progress
 * update carries.
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
 * One answer about the whole box rather than one per conversation. The process
 * table cannot say whose work is whose any more — `codex app-server` runs every
 * Codex conversation of a box in one process and names none of them on its
 * command line — and it no longer has to: the adapters name the work they know
 * about, and this answers the only question left, which is the reaper's.
 */
export interface BoxReading {
  /** Whether anything is running that Boxes did not put there to hold the box open. */
  busy: boolean;
  /** The command lines of what is, for the log and for the session-level stop. */
  work: readonly string[];
}

/** Nothing running anywhere: a box that is not there, or not up. */
const NOTHING: BoxReading = { busy: false, work: [] };

/**
 * The `ps` that took the reading, which is in every reading taken from inside.
 *
 * A stop reads the box through its own `ps`, and that process is in the table
 * it prints. Counting it would make every box busy the moment it was asked,
 * and killing it would be Boxes shooting its own reading.
 */
const READING_ITSELF = /^(?:\S*\/)?ps(?:\s|$)/;

/** The line the entrypoint holds the container open with, once it has exec'd. */
const ENTRYPOINT_HOLD = 'sleep infinity';

/**
 * What a box is held open by: its init, or the entrypoint where it has none.
 *
 * Matched on the command rather than found at PID 1, because the reading does
 * not always speak the box's own numbers. `docker top` reports the host's
 * pids, where the box's init is some five-digit number and nothing is 1 at
 * all, and a rule looking for 1 then finds neither the init nor the hold
 * below it — so both read as work, and every box is busy from the moment it
 * starts. The inside reading does number them from 1, and this matches in
 * either.
 */
const BOX_INIT = /^(?:\S*\/)?(?:docker-init|tini)(?:\s|$)|entrypoint\.sh(?:\s|$)/;

/**
 * Whether one process is the box itself rather than work being done in it.
 *
 * Resident is a short list, and everything not on it is work:
 *
 * - the box's init, and the `sleep infinity` the entrypoint holds it open
 *   with — that is `exec`ed, so it is the init itself where there is none,
 *   and the init's own child where there is. Both are found by what they are
 *   running rather than by their number, which the reading does not always
 *   state in the box's own terms;
 * - every adapter, found by its harness's `processToken`;
 * - every adapter's direct children, which are the agent processes: `claude`
 *   under `claude-agent-acp`, `codex app-server` under `codex-acp`;
 * - anything matching a harness's `residentProcesses`, which is where a
 *   long-lived helper of either agent goes — an MCP server would be the one
 *   thing this rule would otherwise misread, and Boxes configures none;
 * - the `ps` that took the reading.
 *
 * Everything else is work: a shell under an agent, a build orphaned to PID 1
 * by an adapter that died, a `!command` exec somebody is still waiting on.
 * Under Codex's sandboxed modes a command is three wrappers deep
 * (`codex-linux-sandbox` → `bwrap` → `codex-linux-sandbox
 * --apply-seccomp-then-exec` → `bash -lc …`), and every one of them is that
 * command's own and correctly reads as work.
 *
 * The rule has to know both harnesses' tokens. Left with one, it silently
 * mis-reads the other harness's box as empty, and an invisible build gets
 * suspended half an hour later.
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
 * Whatever is holding the box open, by what it is running.
 *
 * The init where there is one, and the `sleep infinity` itself where there is
 * not: the entrypoint `exec`s that, so with no init above it the hold is the
 * root of the tree rather than a child of anything. A root is one whose
 * parent is not in the reading, which is the same test in either numbering —
 * the box's own init answers to 0, and the host's to a shim that is not a
 * process of this box.
 *
 * A set because nothing here needs it to be one process, and a reading that
 * shows none leaves the hold reading as work: a box held awake rather than
 * one suspended with a build still in it.
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
 * Every adapter process in a box, by the token its harness is spawned as.
 *
 * The token alone is not enough, because it is on the agent's command line
 * too: `claude-agent-acp` is a package name, and the CLI it spawns lives
 * inside that package's own `node_modules`, three directories into a path. An
 * agent read as an adapter would make the shells under it read as agents,
 * which is work made invisible — exactly the mistake that costs a build.
 *
 * Two things tell them apart, and either is enough. A harness names its own
 * agent in `residentProcesses`, and a process matching that is the agent
 * whatever else is on its line; and the adapter is what Boxes `exec`s into the
 * box, so nothing carrying a token sits above it.
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
 * A box with nothing of Boxes' own in it — no adapter, no agent — is empty
 * rather than a shape this cannot understand. Boxes spawns an adapter as an
 * exec and keeps none there between connections, so a container that is up and
 * has never been opened runs the entrypoint and nothing else; counting that as
 * busy would put "still running" on its card and keep the reaper off it
 * forever.
 */
export function readBox(
  processes: readonly ContainerProcess[],
  harnesses: readonly Harness[],
): BoxReading {
  const adapters = adapterPids(processes, harnesses);
  const inits = initPids(processes);
  const work = processes
    .filter((p) => !isResident(p, adapters, harnesses, inits))
    .map((p) => p.command.trim());
  return { busy: work.length > 0, work };
}

/**
 * The pids to kill to empty a box, deepest first.
 *
 * The same rule as {@link readBox}, answered in the numbering a `kill` inside
 * the box takes — so the processes must be that box's own reading, taken a
 * moment ago and used immediately.
 *
 * Children before parents, because a parent killed first hands its children to
 * init before they are signalled: a box that looks empty with a build still
 * running in it is worse than one that was never asked to stop.
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

/**
 * The answer for one container, re-read no more often than `ttlMs`.
 *
 * Every reader wants an answer it can have without waiting — the reaper mid
 * sweep, a session summary being built for a browser — and every reader wants
 * it to be current. So it is polled behind them: a reading is served from the
 * last one until it goes stale, and refreshing is something the holder does,
 * not something a reader waits on.
 */
export interface ProbeOptions {
  /**
   * How to ask the box what is running, or null where there is no box to ask
   * — no container, or one that is not up. Null is an answer and not a
   * failure: a stopped box is empty, and saying so is the difference between
   * a session that is quiet and one that says "still running" forever.
   *
   * Injected so this is testable without a Docker daemon under it.
   */
  list: () => Promise<ContainerProcess[] | null>;
  /** Every harness, because a box may be running either adapter, or both. */
  harnesses: readonly Harness[];
  /** How long one reading stands for. */
  ttlMs: number;
  /** Present so a test can move time without waiting for it. */
  now?: () => number;
  /**
   * Told the error when readings start failing, and null when they start
   * working again. Only the changes, because a probe polls: a box that cannot
   * be read would otherwise be three lines a minute for as long as it lasts,
   * which is how a real fault gets scrolled past. The answer this holds is a
   * guess whenever it is failing, and a guess that holds boxes awake
   * indefinitely is worth one line saying so.
   */
  onTrouble?: (error: Error | null) => void;
  /**
   * Told whenever the box changes between busy and idle, with the reading that
   * says so. Only the transitions, so a poll over a box where nothing is
   * happening says nothing at all.
   *
   * What it is for is the log. Work the reading finds may be work no thread
   * has a task for — everything an adapter left behind when it died is — and
   * that state looks exactly like a fault from the outside: a card saying
   * "still running" with every one of its threads quiet. The commands are the
   * only evidence of what it was.
   */
  onChange?: (reading: BoxReading) => void;
}

export class BackgroundProbe {
  private reading: BoxReading = NOTHING;
  private readAt = -Infinity;
  private inFlight: Promise<void> | null = null;
  /**
   * Whether the box has been read at all, which is what makes an empty
   * reading an answer rather than a starting point.
   */
  private read = false;
  /**
   * How many times the answer has been settled without asking the box. A
   * reading carries the number it started under, so one still on the wire
   * when a session is stopped is dropped rather than put back.
   */
  private generation = 0;
  /** Whether the last reading failed, so the trouble is reported once. */
  private failing = false;

  private readonly list: ProbeOptions['list'];
  private readonly harnesses: readonly Harness[];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onTrouble: (error: Error | null) => void;
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
   * Whether anything at all is running in the box, null before any reading
   * has landed, and a refresh started if the reading has gone stale.
   *
   * Never awaits: the first call answers null and the reading behind it
   * arrives before the reaper's next sweep. Null is not "nothing running" —
   * a box that has not been read is not a box known to be empty, and a
   * caller that stops boxes has to hold it.
   */
  get active(): boolean | null {
    this.freshen();
    return this.read ? this.reading.busy : null;
  }

  /**
   * Forgets what was read, for a box that is going away.
   *
   * Stopping a session is the one moment the answer is known without asking,
   * and waiting a poll to say so would leave "still running" on a box that
   * has just been shut down.
   */
  clear(): void {
    const before = this.reading;
    this.reading = NOTHING;
    this.readAt = -Infinity;
    // Knowledge rather than a starting point: a box that has been shut down
    // is empty, and a reading taken before it went down is history.
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
        // A stop while this was on the wire already settled the answer, and
        // this reading is of the box as it was before it.
        if (generation !== this.generation) return;
        const before = this.reading;
        // No box to ask is not the same as a box that would not answer: it is
        // empty, and known to be.
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
        // A box that cannot be asked is not a box known to be empty. Hold the
        // last answer and let the next reading settle it; a container that has
        // genuinely gone is stopped by its own state, not by this.
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

/**
 * One tool call, as much of it as the two questions about it need.
 *
 * Shared with `activity.ts`, which asks the same predicate for the opposite
 * reason: a call that runs in the background is exactly the call whose silence
 * says nothing about whether the agent is still working.
 */
export interface ToolCallUpdate {
  name?: string;
  rawInput?: unknown;
  _meta?: {
    claudeCode?: { toolName?: string };
    jetbrains?: { air?: { asyncTasks?: { backgrounded?: unknown } } };
  };
}

/**
 * Whether a tool call leaves something running after the turn that made it.
 *
 * Three answers, in the order of how much they know.
 *
 * The marker both adapters put on the call's own update —
 * `_meta.jetbrains.air.asyncTasks.backgrounded` — is the adapter saying it
 * outright, about the call it has just backgrounded, and it is the only one of
 * the three that speaks for Codex: Codex has no `run_in_background` flag and
 * puts no tool name on a call at all.
 *
 * `rawInput.run_in_background` is Claude's Bash tool being asked for one, which
 * arrives with the call rather than after it. The names are the tools that
 * background their work whatever their input says, and the registry is where
 * each harness's are written down — `Monitor` and `Workflow` under Claude, none
 * under Codex, where `Monitor` would be a tool name like any other.
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
