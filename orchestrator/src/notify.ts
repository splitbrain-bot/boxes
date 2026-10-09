import type { Config } from './config.ts';
import {
  deletePushSubscription,
  dropOtherKeySubscriptions,
  listPushSubscriptions,
  touchPushSubscription,
  type Db,
} from './db.ts';
import { log } from './log.ts';
import { loadVapidKeys, sendPush, type VapidKeys } from './push.ts';

/** Web Push notifications for the events where a thread needs a person. */

/** Longest a thread title may be in a notification, in characters. */
const MAX_TITLE = 80;

/** What happened, which picks the wording. */
export type NotifyKind = 'approval' | 'idle';

/** One thing worth interrupting somebody for. */
export interface NotifyEvent {
  /** What happened. */
  kind: NotifyKind;
  /** The box the thread is in. */
  boxId: string;
  /** The box's display name. */
  boxName: string;
  /** The dashboard's own thread id, so the notification can link at it. */
  threadId: string | null;
  /** What that conversation is called, or null for an untitled one. */
  threadName: string | null;
  /**
   * Whether this thread still has background work running, when the event
   * knows. Work in other threads of the box does not count.
   */
  background?: boolean;
}

/** The JSON a service worker receives. */
interface PushPayload {
  /** The notification title. */
  title: string;
  /** The notification text. */
  body: string;
  /**
   * Replaces an earlier notification with the same tag rather than stacking
   * on it, so a thread that asks twice does not leave two to dismiss.
   */
  tag: string;
  /** Where a tap goes, relative to the dashboard's own origin. */
  url: string;
}

/**
 * Title and body for one event. Exported for tests, as the encrypted payload
 * cannot be read on the wire.
 */
export function wording(event: NotifyEvent): { title: string; body: string } {
  const where = event.threadName
    ? `${event.boxName} · ${shortTitle(event.threadName)}`
    : event.boxName;
  if (event.kind === 'approval') {
    return {
      title: 'Boxes: approval needed',
      body: `${where} is waiting for a permission decision.`,
    };
  }
  // Says that something runs, not what: a lock screen is no place for a command.
  const still = event.background ? ' Something is still running.' : '';
  return {
    title: 'Boxes: waiting for you',
    body: `${where} has stopped and is waiting for input.${still}`,
  };
}

/**
 * A thread title cut to MAX_TITLE characters. The whole payload must fit one
 * encrypted record.
 */
function shortTitle(name: string): string {
  return name.length <= MAX_TITLE ? name : `${name.slice(0, MAX_TITLE - 1)}…`;
}

/** Where a notification about this event points. */
function target(event: NotifyEvent): string {
  return event.threadId ? `/boxes/${event.boxId}/threads/${event.threadId}` : '/';
}

/** Sends one event to every subscribed browser. */
export class Notifier {
  /** The VAPID keypair, or null before first use. */
  private keys: VapidKeys | null = null;

  constructor(
    /** Where the push subscriptions and the keypair are stored. */
    private readonly db: Db,
    /** The deployment's configuration. */
    private readonly cfg: Config,
  ) {}

  /**
   * The deployment's VAPID public key, which a browser needs to subscribe.
   * The first read generates the keypair, so a deployment without subscribers
   * writes none.
   */
  get publicKey(): string {
    return this.vapid().publicKey;
  }

  /** The keypair, loaded or generated on first use. */
  private vapid(): VapidKeys {
    if (!this.keys) this.keys = loadVapidKeys(this.db);
    return this.keys;
  }

  /**
   * Sends one event. It never throws: every failure is logged.
   *
   * The gateway does not await it, so a turn waiting on a person does not also
   * wait on a push service. An unhandled rejection would crash the process.
   * The promise lets a test wait.
   */
  async notify(event: NotifyEvent): Promise<void> {
    try {
      await this.push(event);
    } catch (err) {
      log.warn('could not notify anybody about a box event', {
        kind: event.kind,
        box: event.boxId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Pushes to every subscribed browser. It deletes subscriptions the push
   * service reports as gone, and those made under another VAPID key.
   */
  private async push(event: NotifyEvent): Promise<void> {
    const stored = listPushSubscriptions(this.db);
    // Before the keypair is read, so a deployment without subscribers writes none.
    if (stored.length === 0) return;

    const keys = this.vapid();
    // One made under another key is refused with a status the gone check
    // below misses, so without this it would be retried forever.
    const dropped = dropOtherKeySubscriptions(this.db, keys.publicKey);
    if (dropped > 0) {
      log.info('dropped push subscriptions made under an earlier key', { count: dropped });
    }
    const subscriptions = stored.filter((row) => row.vapid_key === keys.publicKey);
    if (subscriptions.length === 0) return;

    const { title, body } = wording(event);
    const payload: PushPayload = {
      title,
      body,
      tag: `${event.threadId ?? event.boxId}:${event.kind}`,
      url: target(event),
    };
    const message = JSON.stringify(payload);

    await Promise.all(
      subscriptions.map(async (row) => {
        const result = await sendPush(
          { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
          message,
          keys,
          this.cfg.PUSH_SUBJECT,
        );
        if (result.ok) {
          touchPushSubscription(this.db, row.endpoint);
          return;
        }
        if (result.gone) {
          deletePushSubscription(this.db, row.endpoint);
          log.info('dropped a finished push subscription', {
            status: result.status,
            endpoint: originOf(row.endpoint),
          });
          return;
        }
        log.warn('push notification failed', {
          status: result.status,
          endpoint: originOf(row.endpoint),
          error: result.error,
        });
      }),
    );
  }
}

/**
 * The push service an endpoint belongs to, for the log. The path is a
 * capability — anyone holding it can push to that browser — so it never
 * reaches a log line.
 */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unparseable';
  }
}
