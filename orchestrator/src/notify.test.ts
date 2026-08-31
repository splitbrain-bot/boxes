import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { loadConfig, type Config } from './config.ts';
import { openDb, upsertPushSubscription, type Db } from './db.ts';
import { Notifier, type NotifyEvent } from './notify.ts';

/**
 * The fan-out, with both channels' transports faked at fetch.
 *
 * What matters here is not the bytes — push.test.ts covers those against the
 * RFC's own vectors — but that one event reaches every channel, that a turn
 * is never held up by a push service, and that a subscription the service
 * says is finished is forgotten rather than retried forever.
 */

let dir: string;
let db: Db;
let cfg: Config;
let calls: Array<{ url: string; headers: Record<string, string> }>;
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

/** One subscription row, with keys of the sizes the crypto needs. */
function subscribe(endpoint: string): void {
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
  );
}

const event: NotifyEvent = {
  kind: 'approval',
  sessionId: 's1',
  sessionName: 'muffin',
  threadId: 't2',
  threadName: 'Rewrite the parser',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-notify-'));
  db = openDb(dir);
  cfg = loadConfig({ DATA_DIR: dir, NTFY_URL: 'https://ntfy.example/boxes' });
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('one event reaches ntfy and every subscribed browser', async () => {
  subscribe('https://push.example.net/a');
  subscribe('https://push.example.org/b');
  fakeFetch(() => ({ status: 201 }));

  await new Notifier(db, cfg).notify(event);

  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, [
    'https://ntfy.example/boxes',
    'https://push.example.net/a',
    'https://push.example.org/b',
  ]);
  const push = calls.find((c) => c.url.includes('push.example.net'))!;
  assert.equal(push.headers['Content-Encoding'], 'aes128gcm');
  assert.match(push.headers['Authorization']!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

test('the thread is named in the message, not just the session', async () => {
  fakeFetch(() => ({ status: 200 }));
  let body = '';
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    body = String(init?.body ?? '');
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;

  await new Notifier(db, cfg).notify(event);
  // From a lock screen, "your session needs you" is not enough to act on.
  assert.match(body, /muffin · Rewrite the parser/);
});

test('an idle event and an approval read differently', async () => {
  const titles: string[] = [];
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    titles.push((init?.headers as Record<string, string>)['Title'] ?? '');
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;

  const notifier = new Notifier(db, cfg);
  await notifier.notify(event);
  await notifier.notify({ ...event, kind: 'idle' });
  assert.deepEqual(titles, ['Boxes: approval needed', 'Boxes: turn finished']);
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

  // Neither the throw nor the 500 may escape: the caller is a turn waiting on
  // a human, and a push service is not its problem.
  await new Notifier(db, cfg).notify(event);
  await new Notifier(db, cfg).notify(event);

  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM push_subscriptions')
    .get() as { n: number };
  assert.equal(remaining.n, 1);
});

test('nothing is sent when no channel is configured', async () => {
  fakeFetch(() => ({ status: 200 }));
  await new Notifier(db, loadConfig({ DATA_DIR: dir })).notify(event);
  assert.deepEqual(calls, []);
});
