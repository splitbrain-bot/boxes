import { UPDATE_KIND } from '../../../shared/acp.ts';
import type { ThreadConfigOption, ThreadModeState } from '../../../shared/types.ts';

/**
 * How much of one thread's log is kept, counted as the JSON length of each
 * logged update.
 *
 * Past this the oldest messages go. A thread opens at its bottom, so only
 * old scrollback is lost.
 */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

/**
 * What the adapter advertises about a thread, besides the messages: the modes
 * it offers and the options it lets a client set.
 */
export interface AdapterOptions {
  /** The modes the thread offers and the current one, or null for none. */
  modes: ThreadModeState | null;
  /** The options a client may set on the thread. */
  configOptions: ThreadConfigOption[];
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
  /** The params of the `session/update` notification. */
  params: unknown;
  /** The JSON length of `params`. */
  size: number;
}

/**
 * Log of everything a browser watching one thread would have been sent, in
 * order.
 *
 * A browser opens a thread by being sent this log: whole for a fresh tab, or
 * from the last message it holds when it reconnects.
 */
export class ThreadLog {
  /** The logged notifications, oldest first. */
  private entries: Entry[] = [];
  /** The summed size of `entries`. */
  private bytes = 0;
  /**
   * True while the adapter is reading the transcript into this log. What
   * arrives meanwhile is logged and sent to nobody.
   *
   * A replay and a live turn look the same on the wire, so the gateway fills
   * only a thread that is not talking.
   */
  filling = false;
  /**
   * The modes and options the adapter advertises for this thread, kept current
   * from the updates that change them. They answer a browser's `session/load`.
   */
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
   * Starts this log as a copy of another thread's, with every entry renamed
   * to this thread.
   *
   * The adapter writes a fork a transcript only when it is first prompted, so
   * the copy lets a new fork open on the conversation it carries.
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
   * When the log holds `anchor`, the browser gets that message and everything
   * after it. The anchor message is sent again because a socket can drop
   * partway through it. Otherwise the browser gets the whole thread.
   *
   * @param anchor The last message the browser holds, if any.
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
   * Drops the oldest message: its chunks and everything up to the next
   * message's first chunk, such as the tool calls it made. A cut anywhere
   * else would leave a partial message or a tool result without its call.
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
   * Updates {@link options} from a `current_mode_update` or a
   * `config_option_update`.
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
        configOptions: Array.isArray(configOptions) ? (configOptions as ThreadConfigOption[]) : [],
      };
    }
  }
}

/** The message a session/update belongs to, or undefined when it names none. */
export function messageOf(params: unknown): string | undefined {
  const messageId = (params as { update?: { messageId?: unknown } } | undefined)?.update?.messageId;
  return typeof messageId === 'string' && messageId ? messageId : undefined;
}
