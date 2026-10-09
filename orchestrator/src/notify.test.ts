import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { loadConfig, type Config } from './config.ts';
import { openDb, upsertPushSubscription, type Db } from './db.ts';
import { Notifier, wording, type NotifyEvent } from './notify.ts';
import { loadVapidKeys } from './push.ts';

let dir: string;
let db: Db;
let cfg: Config;
let calls: Array<{ url: string; headers: Record<string, string> }>;
/** The real fetch, restored after each test. */
const realFetch = globalThis.fetch;

/** Installs a fetch that records every call and answers as told. */
function fakeFetch(answer: (url: string) => { status: number } | Error): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const result = answer(url);
    if (result instanceof Error) throw result;
    return new Response(null, { status: result.status });
  }) as typeof globalThis.fetch;
}

/**
 * Stores one subscription row, with keys of the sizes the crypto needs.
 * `vapidKey` defaults to the deployment's current key.
 */
function subscribe(endpoint: string, vapidKey = loadVapidKeys(db).publicKey): void {
  upsertPushSubscription(
    db,
    endpoint,
    Buffer.concat([
      Buffer.from([0x04]),
      // A point on the curve is needed for the ECDH, so the RFC's own
      // receiver key stands in for a browser's.
      Buffer.from(
        'JXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDg',
        'base64url',
      ),
    ]).toString('base64url'),
    'BTBZMqHH6r4Tts7J_aSIgg',
    'phone',
    vapidKey,
  );
}

/** An approval request for a named thread. */
const event: NotifyEvent = {
  kind: 'approval',
  boxId: 's1',
  boxName: 'muffin',
  threadId: 't2',
  threadName: 'Rewrite the parser',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-notify-'));
  db = openDb(dir);
  cfg = loadConfig({ DATA_DIR: dir });
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('one event reaches every subscribed browser', async () => {
  subscribe('https://push.example.net/a');
  subscribe('https://push.example.org/b');
  fakeFetch(() => ({ status: 201 }));

  await new Notifier(db, cfg).notify(event);

  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, ['https://push.example.net/a', 'https://push.example.org/b']);
  const push = calls.find((c) => c.url.includes('push.example.net'))!;
  assert.equal(push.headers['Content-Encoding'], 'aes128gcm');
  assert.match(push.headers['Authorization']!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test('the thread is named in the message, not just the box', () => {
  // From a lock screen, "your box needs you" is not enough to act on.
  assert.match(wording(event).body, /muffin · Rewrite the parser/);
});

test('an idle event and an approval read differently', () => {
  assert.equal(wording(event).title, 'Boxes: approval needed');
  assert.equal(wording({ ...event, kind: 'idle' }).title, 'Boxes: waiting for you');
});

test('an idle event says what is still running, when anything is', () => {
  const idle = { ...event, kind: 'idle' as const };
  // With background work running, the thread posts again without a new prompt.
  assert.doesNotMatch(wording(idle).body, /still running/);
  assert.match(wording({ ...idle, background: true }).body, /Something is still running/);
  assert.doesNotMatch(wording({ ...idle, background: false }).body, /still running/);
});

test('a subscription the push service has finished with is forgotten', async () => {
  subscribe('https://push.example.net/gone');
  subscribe('https://push.example.net/live');
  fakeFetch((url) => ({ status: url.endsWith('/gone') ? 410 : 201 }));

  await new Notifier(db, cfg).notify(event);

  const rows = db.prepare('SELECT endpoint FROM push_subscriptions').all() as Array<{
    endpoint: string;
  }>;
  assert.deepEqual(
    rows.map((r) => r.endpoint),
    ['https://push.example.net/live'],
  );
});

test('a push service that is merely down keeps its subscription', async () => {
  subscribe('https://push.example.net/a');
  fakeFetch(() => new Error('connect ECONNREFUSED'));

  // The error must not escape, because the caller is a turn waiting on a person.
  await new Notifier(db, cfg).notify(event);
  await new Notifier(db, cfg).notify(event);

  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM push_subscriptions')
    .get() as { n: number };
  assert.equal(remaining.n, 1);
});

test('a subscription made under an earlier key is forgotten rather than retried', async () => {
  // The push service refuses it with a status that the gone check misses.
  subscribe('https://push.example.net/rotated', 'a-key-this-deployment-no-longer-holds');
  subscribe('https://push.example.net/live');
  fakeFetch(() => ({ status: 201 }));

  await new Notifier(db, cfg).notify(event);

  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://push.example.net/live'],
  );
  const rows = db.prepare('SELECT endpoint FROM push_subscriptions').all() as Array<{
    endpoint: string;
  }>;
  assert.deepEqual(
    rows.map((r) => r.endpoint),
    ['https://push.example.net/live'],
  );
});

test('nothing is sent when no browser has subscribed', async () => {
  fakeFetch(() => ({ status: 200 }));
  await new Notifier(db, cfg).notify(event);
  assert.deepEqual(calls, []);
});
