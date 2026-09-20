import { UPDATE_KIND } from '../../../shared/acp.ts';
import type { SessionConfigOption, SessionModeState } from '../../../shared/types.ts';

/**
 * How many bytes of one thread's log are kept, counted on the notifications
 * as they are written to a socket.
 *
 * Past this the oldest messages go. A thread opens at its bottom, so what is
 * lost is scrollback nobody reaches; a browser that already held it keeps
 * it. The same figure as the ceiling on one browser's socket buffer, which
 * is about the same question — how much of a thread is worth holding in
 * memory for one reader.
 */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * What the adapter advertises about a thread, besides the messages: the modes
 * it offers and the options it lets a client set.
 */
export interface AdapterOptions {
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
}

/** What a browser asking to open a thread is sent, and told about it. */
export interface Opening {
  /** True when `updates` starts at the message the browser named. */
  resumed: boolean;
  /** The notifications to send, in order. */
  updates: unknown[];
  /** The answer to the browser's own `session/load`. */
  options: AdapterOptions;
}

/** One logged notification, with the size it has on the wire. */
interface Entry {
  params: unknown;
  size: number;
}

/**
 * Everything a browser watching one thread would have been sent, in order.
 *
 * A browser opens a thread by being sent this and nothing else: whole for a
 * fresh tab, from the last message it holds for one that is reconnecting. The
 * adapter's own replay is never sent to a browser. It is read once, into
 * this, and only when the thread is otherwise silent — see `filling`.
 *
 * The log also carries the adapter's answer for the thread — its modes and
 * options — kept current from the notifications that change them, so the
 * answer to a browser's `session/load` needs no round trip either.
 */
export class ThreadLog {
  private entries: Entry[] = [];
  private bytes = 0;
  /**
   * True while the adapter is reading the transcript into this log.
   *
   * A replay and a live turn arrive on one connection in one shape, so a
   * log filled while the thread was talking would hold both, mixed. The
   * gateway only fills a thread nothing else can reach — one just brought up
   * on a fresh adapter — and while it does, what arrives is logged and sent
   * to nobody.
   */
  filling = false;
  /** The adapter's answer for this thread; see the class comment. */
  options: AdapterOptions = { modes: null, configOptions: [] };

  constructor(private readonly cap = MAX_LOG_BYTES) {}

  /** Adds one notification, and drops the oldest messages once over the cap. */
  append(params: unknown): void {
    this.noteOptions(params);
    const size = JSON.stringify(params).length;
    this.entries.push({ params, size });
    this.bytes += size;
    while (this.bytes > this.cap && this.entries.length > 1) this.evictOldest();
  }

  /**
   * Starts this log as a copy of another thread's, said to be about this one.
   *
   * A fork holds the source's context from the moment it is minted, but the
   * adapter writes it a transcript only when it is first prompted. Copying
   * the source's log is what lets the fork open on the conversation it is
   * carrying rather than on a blank screen.
   */
  copyFrom(source: ThreadLog, acpThreadId: string): void {
    this.entries = source.entries.map(({ params, size }) => ({
      params: { ...(params as Record<string, unknown>), sessionId: acpThreadId },
      size,
    }));
    this.bytes = source.bytes;
  }

  /**
   * What to send a browser opening this thread.
   *
   * `anchor` is the last message the browser holds. When the log still has
   * it, the browser is sent that message and everything after it — the
   * message itself again rather than skipped, because a socket can drop
   * partway through one, and the browser drops its own copy before folding
   * the tail on. A message the log no longer holds, or none named, means the
   * thread whole.
   */
  opening(anchor?: string): Opening {
    const at = anchor ? this.entries.findIndex((e) => messageOf(e.params) === anchor) : -1;
    return {
      resumed: at >= 0,
      updates: this.entries.slice(Math.max(at, 0)).map((e) => e.params),
      options: this.options,
    };
  }

  /**
   * Drops the oldest message: its own chunks and everything up to the next
   * message's first chunk, which is the tool calls it made and whatever else
   * was said without naming a message. A cut anywhere else would leave a
   * message that starts mid-sentence at the top of the thread, or a tool
   * result without the call it answers.
   */
  private evictOldest(): void {
    const message = messageOf(this.entries[0]?.params);
    do {
      const gone = this.entries.shift();
      if (!gone) return;
      this.bytes -= gone.size;
      const next = messageOf(this.entries[0]?.params);
      if (next !== undefined && next !== message) return;
    } while (this.entries.length > 0);
  }

  /**
   * Keeps the answer current: the adapter says which mode a thread is in and
   * what its options are through these two notifications, whether the change
   * was asked for or its own.
   */
  private noteOptions(params: unknown): void {
    const update = (params as { update?: Record<string, unknown> } | null)?.update;
    if (update?.['sessionUpdate'] === UPDATE_KIND.currentMode) {
      const modes = this.options.modes;
      if (modes && typeof update['currentModeId'] === 'string') {
        this.options = { ...this.options, modes: { ...modes, currentModeId: update['currentModeId'] } };
      }
      return;
    }
    if (update?.['sessionUpdate'] === UPDATE_KIND.configOption) {
      const configOptions = update['configOptions'];
      this.options = {
        ...this.options,
        configOptions: Array.isArray(configOptions) ? (configOptions as SessionConfigOption[]) : [],
      };
    }
  }
}

/** The message a session/update belongs to, or undefined when it names none. */
export function messageOf(params: unknown): string | undefined {
  const messageId = (params as { update?: { messageId?: unknown } } | undefined)?.update?.messageId;
  return typeof messageId === 'string' && messageId ? messageId : undefined;
}
