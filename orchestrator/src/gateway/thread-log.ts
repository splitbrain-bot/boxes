import { UPDATE_KIND } from '../../../shared/acp.ts';
import type { ThreadConfigOption, ThreadModeState } from '../../../shared/types.ts';

/**
 * The size limit of one thread's log, counted as the summed JSON length of the logged updates.
 *
 * Past this the log drops the oldest messages. A thread opens at its bottom, so only old scrollback is lost.
 */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** The modes and options that the adapter advertises for a thread. */
export interface AdapterOptions {
  /** The modes the thread offers and the current one, or null for none. */
  modes: ThreadModeState | null;
  /** The options a client may set on the thread. */
  configOptions: ThreadConfigOption[];
}

/** The content that a browser gets when it opens a thread. */
export interface Opening {
  /** True when `updates` starts at the message the browser named. */
  resumed: boolean;
  /** True when the log has dropped the oldest messages of the thread. */
  truncated: boolean;
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

/** The log of every update that a browser watching one thread gets, in order. */
export class ThreadLog {
  /** The logged notifications, oldest first. */
  private entries: Entry[] = [];
  /** The summed size of `entries`. */
  private bytes = 0;
  /** True once the log has dropped a message to stay under its cap. */
  private truncated = false;
  /**
   * True while the adapter's transcript replay fills this log. Updates that arrive meanwhile go into the log and to
   * no browser.
   *
   * A replay and a live turn look the same on the wire. The gateway fills a log only for a thread that the adapter
   * did not hold when the load started.
   */
  filling = false;
  /**
   * The modes and options the adapter advertises for this thread, kept current
   * from the updates that change them. They answer a browser's `session/load`.
   */
  options: AdapterOptions = { modes: null, configOptions: [] };

  /** @param cap The size limit, as the summed JSON length of the entries. */
  constructor(private readonly cap = MAX_LOG_BYTES) {}

  /**
   * Adds one notification, and drops the oldest messages once over the cap.
   *
   * @param params The params of the `session/update` notification.
   */
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
   *
   * @param source The log of the thread that was forked.
   * @param acpThreadId The adapter's id for this thread.
   */
  copyFrom(source: ThreadLog, acpThreadId: string): void {
    this.entries = source.entries.map(({ params, size }) => ({
      params: { ...(params as Record<string, unknown>), sessionId: acpThreadId },
      size,
    }));
    this.bytes = source.bytes;
    this.truncated = source.truncated;
  }

  /**
   * The content to send to a browser that opens this thread.
   *
   * When the log holds `anchor`, the browser gets that message and everything
   * after it. The anchor message is sent again because a socket can drop
   * partway through it. Otherwise the browser gets the whole thread.
   *
   * @param anchor The last message the browser holds, if any.
   * @returns The updates to send, the answer to the load, and two flags that describe the updates.
   */
  opening(anchor?: string): Opening {
    const at = anchor ? this.entries.findIndex((e) => messageOf(e.params) === anchor) : -1;
    return {
      resumed: at >= 0,
      truncated: this.truncated,
      updates: this.entries.slice(Math.max(at, 0)).map((e) => e.params),
      options: this.options,
    };
  }

  /**
   * Drops the oldest message with its chunks and every entry up to the first chunk of the next message, e.g. the
   * tool calls it made. A cut anywhere else would leave a partial message or a tool result without its call.
   */
  private evictOldest(): void {
    this.truncated = true;
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
   * Sets the current mode in {@link ThreadLog.options}, for a mode set by request. The
   * adapter need not send a `current_mode_update` for it.
   *
   * @param modeId The mode that is now current.
   * @returns The mode that was current before, or null for a thread with no modes.
   */
  setMode(modeId: string): string | null {
    const modes = this.options.modes;
    if (!modes) return null;
    this.options = { ...this.options, modes: { ...modes, currentModeId: modeId } };
    return modes.currentModeId;
  }

  /**
   * Sets one option's value in {@link ThreadLog.options}, for a value set by request.
   * The adapter need not send a `config_option_update` for it.
   *
   * @param configId The option's id.
   * @param value The value it is now set to.
   * @param answered The options the adapter answered the request with. They
   *   replace the known ones, because a change can change other options too.
   */
  setConfig(configId: string, value: string, answered?: ThreadConfigOption[]): void {
    const configOptions =
      answered ??
      this.options.configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      );
    this.options = { ...this.options, configOptions };
  }

  /**
   * Updates {@link ThreadLog.options} from a `current_mode_update` or a
   * `config_option_update`.
   *
   * @param params The params of the `session/update` notification.
   */
  private noteOptions(params: unknown): void {
    const update = (params as { update?: Record<string, unknown> } | null)?.update;
    if (update?.sessionUpdate === UPDATE_KIND.currentMode) {
      if (typeof update.currentModeId === 'string') this.setMode(update.currentModeId);
      return;
    }
    if (update?.sessionUpdate === UPDATE_KIND.configOption) {
      const configOptions = update.configOptions;
      this.options = {
        ...this.options,
        configOptions: Array.isArray(configOptions) ? (configOptions as ThreadConfigOption[]) : [],
      };
    }
  }
}

/**
 * The message a session/update belongs to.
 *
 * @param params The params of the notification.
 * @returns The message id, or undefined when the update names none.
 */
export function messageOf(params: unknown): string | undefined {
  const messageId = (params as { update?: { messageId?: unknown } } | undefined)?.update?.messageId;
  return typeof messageId === 'string' && messageId ? messageId : undefined;
}
