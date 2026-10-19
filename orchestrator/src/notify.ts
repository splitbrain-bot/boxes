/** Web Push notifications for the events where a thread needs a person. */

import type { Config } from './config.ts';
import {
  type Db,
  deletePushSubscription,
  dropOtherKeySubscriptions,
  listPushSubscriptions,
  touchPushSubscription,
} from './db.ts';
import { log } from './log.ts';
import { loadVapidKeys, sendPush, type VapidKeys } from './push.ts';
import { isMultiUser } from './users.ts';

/** Longest a thread title may be in a notification, in characters. */
const MAX_TITLE = 80;

/** The kind of event. It selects the wording. */
export type NotifyKind = 'approval' | 'idle';

/** One event that needs a person. */
export interface NotifyEvent {
  /** The kind of event. */
  kind: NotifyKind;
  /** The box the thread is in. */
  boxId: string;
  /** The box's display name. */
  boxName: string;
  /** The dashboard's own thread id, so the notification can link at it. */
  threadId: string | null;
  /** The title of the thread, or null for an untitled one. */
  threadName: string | null;
  /**
   * True when this thread still has background work running. Undefined when
   * the event does not know. Work in other threads of the box does not count.
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
   * The notification tag. A notification replaces an earlier one with the
   * same tag, so a thread that asks twice leaves one notification to dismiss.
   */
  tag: string;
  /** Where a tap goes, relative to the dashboard's own origin. */
  url: string;
}

/**
 * Returns the title and body for one event. Exported for tests, as the encrypted payload
 * cannot be read on the wire.
 *
 * @param event The event.
 * @returns The title and the body of the notification.
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
  // The text does not name the command, because a lock screen can show it to anyone.
  const still = event.background ? ' Something is still running.' : '';
  return {
    title: 'Boxes: waiting for you',
    body: `${where} has stopped and is waiting for input.${still}`,
  };
}

/**
 * Returns a thread title cut to MAX_TITLE characters. The whole payload must fit one
 * encrypted record.
 *
 * @param name The thread title.
 * @returns The title, with an ellipsis at the end when it was cut.
 */
function shortTitle(name: string): string {
  return name.length <= MAX_TITLE ? name : `${name.slice(0, MAX_TITLE - 1)}…`;
}

/**
 * Returns the dashboard path that a notification about an event opens.
 *
 * @param event The event.
 * @returns The path of the thread, or the root path for an event without a thread.
 */
function target(event: NotifyEvent): string {
  return event.threadId ? `/boxes/${event.boxId}/threads/${event.threadId}` : '/';
}

/** Sends one event to the subscribed browsers of the user of the box. */
export class Notifier {
  /** The VAPID keypair, or null before first use. */
  private keys: VapidKeys | null = null;

  /**
   * @param db The database that holds the push subscriptions and the keypair.
   * @param cfg The configuration of the deployment.
   */
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
   *
   * @returns The public key, base64url.
   */
  get publicKey(): string {
    return this.vapid().publicKey;
  }

  /**
   * Returns the keypair, loaded or generated on first use.
   *
   * @returns The keypair.
   */
  private vapid(): VapidKeys {
    if (!this.keys) this.keys = loadVapidKeys(this.db);
    return this.keys;
  }

  /**
   * Sends one event. It never throws, and it logs every failure.
   *
   * The gateway does not await it, so a turn waiting on a person does not also
   * wait on a push service. An unhandled rejection would crash the process.
   * The promise lets a test wait.
   *
   * @param event The event.
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
   * Pushes to the subscribed browsers of the user of the box. It deletes
   * subscriptions the push service reports as gone, and those made under
   * another VAPID key.
   *
   * In multi-user mode, the user is the owner of the box. In single user mode,
   * the user sees every box, so each event goes to the browsers of the empty user.
   *
   * @param event The event.
   */
  private async push(event: NotifyEvent): Promise<void> {
    const box = this.db.prepare('SELECT owner FROM boxes WHERE id = ?').get(event.boxId) as
      | { owner: string }
      | undefined;
    const user = isMultiUser(this.cfg) ? box?.owner : '';
    if (user === undefined) return;
    const stored = listPushSubscriptions(this.db, user);
    // Before the keypair is read, so a deployment without subscribers writes none.
    if (stored.length === 0) return;

    const keys = this.vapid();
    // The push service refuses a subscription made under another key with a
    // status that the gone check misses. Without the drop, it is retried forever.
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
 * Returns the origin of the push service of an endpoint, for the log. The
 * path identifies one subscription of one browser, so the log leaves it out.
 *
 * @param endpoint The endpoint URL.
 * @returns The origin, or `unparseable` for an endpoint that is no URL.
 */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unparseable';
  }
}
