import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test } from 'vitest';
import Docker from 'dockerode';
import { Duplex } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.ts';
import { openDb, type Db } from '../db.ts';
import * as dk from '../docker.ts';
import { EgressManager } from '../egress.ts';
import { Notifier, type NotifyEvent } from '../notify.ts';
import { AgentStore } from '../agents.ts';
import { SessionManager } from '../sessions.ts';
import type { DownstreamHandle } from './upstream.ts';

/**
 * The upstream's spawn path against an adapter that answers for real, with
 * only the Docker socket faked.
 *
 * What matters here is what happens to the stored threads when the adapter no
 * longer holds one. The agent SDK writes a transcript only once a prompt has
 * run, so a thread minted and never prompted does not survive the adapter
 * restarting — and that must cost the session only that one thread.
 */

/** One frame of a Docker-multiplexed stream, on stdout. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** A JSON-RPC frame, in either direction. */
interface Rpc {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A stand-in adapter on the hijacked exec stream: the orchestrator's
 * newline-delimited JSON-RPC comes in as writes, and answers go back out as
 * Docker frames.
 */
class FakeAdapter extends Duplex {
  private buffer = '';
  /** Methods the orchestrator sent, in order. */
  readonly seen: string[] = [];

  constructor(private readonly answer: (msg: Rpc) => unknown | Promise<unknown>) {
    super();
  }

  override _read(): void {
    // Answers are pushed as they are produced.
  }

  override _write(chunk: Buffer, _enc: string, done: (err?: Error) => void): void {
    this.buffer += chunk.toString('utf8');
    let cut = this.buffer.indexOf('\n');
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (line) this.handle(line);
      cut = this.buffer.indexOf('\n');
    }
    done();
  }

  /** Sends a notification, the way an adapter's replay does. */
  notify(method: string, params: unknown): void {
    this.push(frame(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`));
  }

  private handle(line: string): void {
    const msg = JSON.parse(line) as Rpc;
    if (msg.id === undefined || !msg.method) return;
    this.seen.push(msg.method);
    // An answer may be a promise, which is how a test holds one call open
    // while asserting on what is true meanwhile.
    void Promise.resolve(this.answer(msg)).then((result) => {
      const body =
        result instanceof Error
          ? { error: { code: -32002, message: result.message } }
          : { result };
      this.push(frame(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })}\n`));
    });
  }
}

/**
 * Installs a fake Docker whose adapter exec is the given stand-in.
 *
 * A function rather than an instance builds a fresh one per exec, which is
 * what a respawn needs: killing an exec destroys its stream, so an adapter
 * that has been torn down cannot answer the connection that replaces it.
 */
function fakeDocker(adapter: FakeAdapter | (() => FakeAdapter)): void {
  const spawn = typeof adapter === 'function' ? adapter : () => adapter;
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;
  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      start: async () => undefined,
      inspect: async () => ({ State: { Running: true } }),
      exec: async () => ({
        start: async () => spawn(),
        inspect: async () => ({ ExitCode: 0 }),
      }),
    }),
    getNetwork: () => ({
      inspect: async () => ({ Containers: {} }),
      connect: async () => undefined,
    }),
    listContainers: async () => [],
  } as unknown as Docker);
}

let dir: string;
let db: Db;
let manager: SessionManager;
/** Every event the gateway announced, in order; see notifications below. */
let announced: NotifyEvent[];

/** A notifier that records instead of sending. */
class RecordingNotifier extends Notifier {
  override async notify(event: NotifyEvent): Promise<void> {
    announced.push(event);
  }
}

/** A running session with two threads, the first of which is current. */
function seed(): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       created_at, last_active_at)
     VALUES ('s1', 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', 't1', ?, ?)`,
  ).run(now, now);
  for (const [id, acp, ordinal] of [
    ['t1', 'acp-gone', 1],
    ['t2', 'acp-kept', 2],
  ] as const) {
    db.prepare(
      `INSERT INTO threads (id, session_id, acp_session_id, title, ordinal,
         created_at, last_active_at)
       VALUES (?, 's1', ?, NULL, ?, ?, ?)`,
    ).run(id, acp, ordinal, now, now);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-upstream-'));
  process.env['DATA_DIR'] = dir;
  db = openDb(dir);
  const cfg = config();
  announced = [];
  manager = new SessionManager(
    db,
    cfg,
    new EgressManager(cfg),
    new RecordingNotifier(db, cfg),
    new AgentStore(db, cfg.DATA_DIR),
  );
  seed();
});

afterEach(() => {
  manager.closeAll();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/** One thread row as stored. */
function thread(id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown>;
}

/** A browser watching one thread, recording what it was asked and told. */
function fakeHandle(
  id: number,
  acpThreadId: string | null,
): DownstreamHandle & { asked: unknown[]; told: unknown[]; closed: number } {
  return {
    id,
    acpThreadId,
    lastActiveAt: Date.now(),
    asked: [] as unknown[],
    told: [] as unknown[],
    closed: 0,
    notify(this: { told: unknown[] }, _method, params) {
      this.told.push(params);
    },
    request(this: { asked: unknown[] }, _method, params) {
      this.asked.push(params);
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    },
    close(this: { closed: number }) {
      this.closed++;
    },
  };
}

/** A session/request_permission from the adapter, about one thread. */
function permissionFrame(acpThreadId: string): Buffer {
  return frame(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 9000,
      method: 'session/request_permission',
      params: {
        sessionId: acpThreadId,
        toolCall: { toolCallId: 'tc-1' },
        options: [{ optionId: 'yes', kind: 'allow_once' }],
      },
    })}\n`,
  );
}

test('a thread the adapter has forgotten is re-minted, and the others are left alone', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    // The stored thread has no transcript on disk, which is what the adapter
    // reports as a missing resource.
    if (msg.method === 'session/load') return new Error('Session not found');
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  // The current thread keeps its row and its ordinal, and gets the freshly
  // minted conversation.
  assert.equal(thread('t1')['acp_session_id'], 'acp-fresh');
  assert.equal(thread('t1')['ordinal'], 1);
  // The session's other thread has a transcript of its own and is untouched.
  assert.equal(thread('t2')['acp_session_id'], 'acp-kept');
  const count = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
  assert.equal(count.n, 2);
  // Still the same current thread: a re-mint is not a switch.
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
    string,
    unknown
  >;
  assert.equal(session['current_thread_id'], 't1');
});

test('a thread the adapter still holds is replayed rather than replaced', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  assert.equal(thread('t1')['acp_session_id'], 'acp-gone');
  assert.ok(adapter.seen.includes('session/load'));
  assert.ok(!adapter.seen.includes('session/new'));
});

test('a session with no thread yet gets its first one recorded', async () => {
  db.prepare('DELETE FROM threads').run();
  db.prepare('UPDATE sessions SET current_thread_id = NULL WHERE id = ?').run('s1');

  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-first' };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  const rows = db.prepare('SELECT * FROM threads').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['acp_session_id'], 'acp-first');
  assert.equal(rows[0]!['ordinal'], 1);
  assert.ok(!adapter.seen.includes('session/load'));
});

test('every conversation is created asking for readable thinking', async () => {
  /** The `_meta` each session-creating call carried. */
  const meta: Array<{ method: string; meta: unknown }> = [];
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/load' || msg.method === 'session/new') {
      meta.push({
        method: msg.method,
        meta: (msg.params as { _meta?: unknown } | undefined)?._meta,
      });
    }
    // The stored thread is gone, so both paths run: a load that fails and
    // the fresh conversation that replaces it.
    if (msg.method === 'session/load') return new Error('Session not found');
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);

  await manager.upstream('s1').ensureStarted();

  // Without `display`, a current model streams thinking blocks with no text
  // in them and the dashboard has no reasoning to show.
  const wanted = {
    claudeCode: {
      options: {
        thinking: { type: 'enabled', budgetTokens: 10_000, display: 'summarized' },
      },
    },
  };
  assert.ok(meta.length >= 2);
  for (const call of meta) assert.deepEqual(call.meta, wanted, call.method);
});

test('forking is offered only when the adapter advertises the capability', async () => {
  const withFork = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        // ACP spells a supported capability as an object, `{}` included.
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    return {};
  });
  fakeDocker(withFork);

  const up = manager.upstream('s1');
  assert.equal(up.canFork, false, 'nothing is claimed before the adapter is reached');
  await up.ensureStarted();
  assert.equal(up.canFork, true);
});

test('a title the adapter reports lands on the thread it is about', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  await manager.upstream('s1').ensureStarted();

  // A session_info_update for the thread that is not current, to show the
  // title is routed by the update's own ACP id rather than by what is current.
  adapter.push(
    frame(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-kept',
          update: { sessionUpdate: 'session_info_update', title: 'Refactor the proxy' },
        },
      })}\n`,
    ),
  );

  await expect.poll(() => thread('t2')['title']).toBe('Refactor the proxy');
  assert.equal(thread('t1')['title'], null);
});

test('a new thread is minted, recorded and made current', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-third' };
    return {};
  });
  fakeDocker(adapter);

  const created = await manager.createThread('s1', undefined);

  assert.equal(created.acpSessionId, 'acp-third');
  // Past the highest the session has used, so "Thread 2" stays that thread's.
  assert.equal(created.ordinal, 3);
  assert.equal(created.title, null);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<
    string,
    unknown
  >;
  assert.equal(session['current_thread_id'], created.id);
  assert.deepEqual(
    manager.threads('s1').map((t) => t.ordinal),
    [1, 2, 3],
  );
});

test('a fork asks the adapter to branch the named thread', async () => {
  let forkedFrom: unknown = null;
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/fork') {
      forkedFrom = msg.params?.['sessionId'];
      return { sessionId: 'acp-branch' };
    }
    return {};
  });
  fakeDocker(adapter);

  const created = await manager.createThread('s1', { from: 't2' });

  // The adapter's own id for the source, not the row id Boxes uses.
  assert.equal(forkedFrom, 'acp-kept');
  assert.equal(created.acpSessionId, 'acp-branch');
  // The source is left exactly as it was; a fork branches rather than moves.
  assert.equal(thread('t2')['acp_session_id'], 'acp-kept');
});

test('forking a thread of another session is a 404 rather than a fork', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);

  await assert.rejects(
    () => manager.createThread('s1', { from: 'someone-elses-thread' }),
    (err: Error & { statusCode?: number }) => err.statusCode === 404,
  );
});

test('selecting a thread moves the default without disturbing anyone watching', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const watcher = fakeHandle(1, 'acp-gone');
  up.attach(watcher);

  const selected = manager.selectThread('s1', 't2');

  assert.equal(selected.id, 't2');
  assert.equal(up.current?.id, 't2');
  // No live connection is pinned to the default, so selecting one is an
  // ordinary write: the browser on the other thread keeps its socket, its
  // transcript and its place.
  assert.equal(watcher.closed, 0);
  assert.equal(watcher.acpThreadId, 'acp-gone');
});

/**
 * Threads in parallel: what has to be true for one thread to keep working
 * while another is used to explore it.
 */

test('a prompt sets the running-turn flag on its own thread and no other', async () => {
  let releasePrompt = (): void => {};
  const held = new Promise<Record<string, never>>((resolve) => {
    releasePrompt = () => resolve({});
  });
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    // The turn does not end until the test lets it, which is what "one thread
    // keeps working" looks like from here.
    if (msg.method === 'session/prompt') return held;
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const inFlight = up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'a long job' }],
  });
  await expect.poll(() => thread('t1')['turn_active']).toBe(1);
  // The session's other conversation is not running anything.
  assert.equal(thread('t2')['turn_active'], 0);
  // And the session's own answer is derived from its threads.
  const summary = await manager.detail('s1');
  assert.equal(summary.turnActive, true);
  assert.deepEqual(
    summary.threads.map((t) => t.turnActive),
    [true, false],
  );

  releasePrompt();
  await inFlight;
  await expect.poll(() => thread('t1')['turn_active']).toBe(0);
  assert.equal((await manager.detail('s1')).turnActive, false);
});

test('a permission request goes to a browser watching the thread that asked', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const working = fakeHandle(1, 'acp-gone');
  const exploring = fakeHandle(2, 'acp-kept');
  up.attach(working);
  up.attach(exploring);
  // The most recently active browser overall is on the other thread, which is
  // exactly the case that used to pick the wrong one.
  exploring.lastActiveAt = Date.now() + 1000;

  adapter.push(permissionFrame('acp-gone'));

  await expect.poll(() => working.asked.length).toBe(1);
  assert.equal(exploring.asked.length, 0);
  assert.equal(manager.pending.countForSession('s1'), 0);
});

test('a permission request queues when only another thread has a browser', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  const elsewhere = fakeHandle(1, 'acp-kept');
  up.attach(elsewhere);

  adapter.push(permissionFrame('acp-gone'));

  // Nobody is looking at the thread that asked, so it waits, exactly as it
  // does with no browser attached at all. A question about one conversation
  // cannot be answered from another's transcript.
  await expect.poll(() => manager.pending.countForSession('s1')).toBe(1);
  assert.equal(elsewhere.asked.length, 0);
  // And it is counted against the thread that asked, which is what the badge
  // on that thread's row reads.
  assert.deepEqual(
    (await manager.detail('s1')).threads.map((t) => t.pendingCount),
    [1, 0],
  );
});

test('a queued request is delivered only to a browser on its own thread', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  adapter.push(permissionFrame('acp-kept'));
  await expect.poll(() => manager.pending.countForSession('s1')).toBe(1);

  const wrongThread = fakeHandle(1, 'acp-gone');
  up.attach(wrongThread);
  up.flushPendingTo(wrongThread);
  assert.equal(wrongThread.asked.length, 0);

  const rightThread = fakeHandle(2, 'acp-kept');
  up.attach(rightThread);
  up.flushPendingTo(rightThread);
  await expect.poll(() => rightThread.asked.length).toBe(1);
});

test('a respawn re-issues session/load for every watched thread', async () => {
  const loaded: string[] = [];
  // A fresh stand-in per spawn, because the first one's stream is destroyed
  // when the adapter it stands in for goes away.
  fakeDocker(
    () =>
      new FakeAdapter((msg) => {
        if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
        if (msg.method === 'session/load') {
          loaded.push(String(msg.params?.['sessionId']));
          return {};
        }
        return {};
      }),
  );
  const up = manager.upstream('s1');
  await up.ensureStarted();
  assert.deepEqual(loaded, ['acp-gone']);

  // A browser on the thread that is not the session's default. Without the
  // reload below, its next prompt would name a thread the adapter has never
  // heard of.
  up.attach(fakeHandle(1, 'acp-kept'));

  // The adapter dies and comes back. The browsers' own sockets are to the
  // gateway, not to it, so nothing on their side notices or re-handshakes.
  up.stop();
  await up.ensureStarted();

  assert.deepEqual(loaded, ['acp-gone', 'acp-gone', 'acp-kept']);
});

test('a respawn that cannot bring a watched thread back drops its browsers', async () => {
  let firstLoadDone = false;
  fakeDocker(
    () =>
      new FakeAdapter((msg) => {
        if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
        if (msg.method === 'session/load') {
          // The default thread always comes back; the watched one is gone by
          // the time the adapter restarts.
          if (msg.params?.['sessionId'] === 'acp-kept' && firstLoadDone) {
            return new Error('Session not found');
          }
          return {};
        }
        if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
        return {};
      }),
  );
  const up = manager.upstream('s1');
  await up.ensureStarted();
  firstLoadDone = true;

  const stranded = fakeHandle(1, 'acp-kept');
  up.attach(stranded);

  up.stop();
  await up.ensureStarted();

  // Its pinned id is one the adapter would now reject, so its socket is
  // closed: the browser reconnects and pins whatever that thread is next.
  assert.equal(stranded.closed, 1);
  assert.equal(thread('t2')['acp_session_id'], null);
});

test('a connection pins the thread it named, and a bare one gets the default', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');

  const named = fakeHandle(1, null);
  const bare = fakeHandle(2, null);
  up.attach(named);
  up.attach(bare);

  assert.equal(await up.pin(named, 't2'), 'acp-kept');
  assert.equal(await up.pin(bare, null), 'acp-gone');
  assert.equal(named.acpThreadId, 'acp-kept');
  assert.equal(bare.acpThreadId, 'acp-gone');
});

test('pinning to a thread the adapter has forgotten mints one for it', async () => {
  // A thread minted and never prompted: the row exists, the conversation
  // behind it did not survive the adapter restarting.
  db.prepare('UPDATE threads SET acp_session_id = NULL WHERE id = ?').run('t2');

  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    if (msg.method === 'session/new') return { sessionId: 'acp-minted' };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');

  const handle = fakeHandle(1, null);
  up.attach(handle);

  // There is no transcript to lose, so a fresh conversation in that row is
  // the whole repair — and the id the connection pins is a live one.
  assert.equal(await up.pin(handle, 't2'), 'acp-minted');
  assert.equal(thread('t2')['acp_session_id'], 'acp-minted');
});

test('a fork starts in plan mode where a fresh thread starts in auto', async () => {
  const modeSet: Array<{ session: unknown; mode: unknown }> = [];
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    const modes = {
      currentModeId: 'default',
      availableModes: [{ id: 'auto' }, { id: 'plan' }, { id: 'default' }],
    };
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh', modes };
    if (msg.method === 'session/fork') return { sessionId: 'acp-branch', modes };
    if (msg.method === 'session/set_mode') {
      modeSet.push({ session: msg.params?.['sessionId'], mode: msg.params?.['modeId'] });
      return {};
    }
    return {};
  });
  fakeDocker(adapter);

  await manager.createThread('s1', undefined);
  await manager.createThread('s1', { from: 't2' });

  // The fork shares the source's checkout, so it starts somewhere that reads
  // rather than writes. It is the user's choice from then on.
  assert.deepEqual(modeSet, [
    { session: 'acp-fresh', mode: 'auto' },
    { session: 'acp-branch', mode: 'plan' },
  ]);
});

/** The threads each session/fork named as its source, in order. */
let forkedFrom: unknown[] = [];
/** The threads each session/load asked for, in order. */
let loaded: string[] = [];

/**
 * An adapter that forks, and replays a thread's history when it is loaded.
 *
 * It behaves the way the real one does about a fork: branching answers with a
 * new id, but nothing is written for it until it is prompted, so loading it
 * replays nothing. Only the source has a transcript.
 */
function forkingAdapter(history: Record<string, string>): FakeAdapter {
  let branches = 0;
  forkedFrom = [];
  loaded = [];
  const adapter: FakeAdapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    if (msg.method === 'session/fork') {
      branches += 1;
      forkedFrom.push(msg.params?.['sessionId']);
      return { sessionId: `acp-branch-${branches}` };
    }
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    if (msg.method === 'session/load') {
      const of = String(msg.params?.['sessionId']);
      loaded.push(of);
      const said = history[of];
      if (said) {
        adapter.notify('session/update', {
          sessionId: of,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said } },
        });
      }
      return {};
    }
    return {};
  });
  return adapter;
}

test('a fork with no transcript of its own is shown the one it came from', async () => {
  fakeDocker(forkingAdapter({ 'acp-kept': 'what was said before the fork' }));
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');
  const reader = fakeHandle(1, 'acp-branch-1');
  up.attach(reader);

  // What the spawn loaded on its way up is not what this is about.
  loaded.length = 0;
  await up.forwardRequest(
    'session/load',
    { sessionId: 'acp-branch-1', cwd: '/workspace', mcpServers: [] },
    reader,
  );

  // Its own load replays nothing, so the source's is sent in its place --
  // re-tagged as this thread's, because that is the conversation the browser
  // reading it is pinned to.
  assert.deepEqual(reader.told, [
    {
      sessionId: 'acp-branch-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'what was said before the fork' },
      },
    },
  ]);
  assert.deepEqual(loaded, ['acp-branch-1', 'acp-kept']);
  assert.equal(thread(created.id)['inherits_from'], 't2');
});

test('a fork stops borrowing the moment it is prompted', async () => {
  fakeDocker(forkingAdapter({ 'acp-kept': 'what was said before the fork' }));
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');
  const reader = fakeHandle(1, 'acp-branch-1');
  up.attach(reader);

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-branch-1',
    prompt: [{ type: 'text', text: 'and now something of my own' }],
  });
  reader.told.length = 0;
  loaded.length = 0;
  await up.forwardRequest(
    'session/load',
    { sessionId: 'acp-branch-1', cwd: '/workspace', mcpServers: [] },
    reader,
  );

  // The adapter writes the fork a transcript at its first prompt, and that
  // transcript opens with everything the source had said. Replaying the
  // source as well would say all of it twice.
  assert.equal(thread(created.id)['inherits_from'], null);
  assert.deepEqual(loaded, ['acp-branch-1']);
  assert.deepEqual(reader.told, []);
});

test('a fork the adapter has forgotten is branched again rather than started empty', async () => {
  fakeDocker(forkingAdapter({}));
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');

  // What an adapter restart leaves behind: the fork was never prompted, so it
  // has no transcript and its id is gone.
  db.prepare('UPDATE threads SET acp_session_id = NULL WHERE id = ?').run(created.id);
  const handle = fakeHandle(1, null);
  up.attach(handle);

  // Branched again, not started empty: the thread exists to carry the
  // source's context, and a restart is not the user changing their mind.
  assert.equal(await up.pin(handle, created.id), 'acp-branch-2');
  assert.deepEqual(forkedFrom, ['acp-kept', 'acp-kept']);
  assert.equal(thread(created.id)['inherits_from'], 't2');
});

test('a fork whose source is gone too is started empty rather than left unpinnable', async () => {
  let branches = 0;
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') {
      return {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
      };
    }
    if (msg.method === 'session/fork') {
      branches += 1;
      // The first branch is the fork itself. By the second the adapter has
      // restarted, and the source turns out to have had no transcript either.
      return branches === 1 ? { sessionId: 'acp-branch' } : new Error('Session not found');
    }
    if (msg.method === 'session/new') return { sessionId: 'acp-fresh' };
    return {};
  });
  fakeDocker(adapter);
  const created = await manager.createThread('s1', { from: 't2' });
  const up = manager.upstream('s1');
  db.prepare('UPDATE threads SET acp_session_id = NULL WHERE id = ?').run(created.id);
  const handle = fakeHandle(1, null);
  up.attach(handle);

  // A thread with nothing to say is better than one the browser cannot pin
  // to anything at all.
  assert.equal(await up.pin(handle, created.id), 'acp-fresh');
});

// --- notifications ----------------------------------------------------------

/**
 * What the gateway announces, and when.
 *
 * Both events are gated on the same thing — nobody is watching that thread —
 * because both exist for the same moment: the browser is gone and the box
 * still wants something. A notification for a turn you are looking at is
 * noise, and noise is what gets notifications turned off.
 */

/** An adapter that answers everything, with prompts finishing immediately. */
function plainAdapter(): FakeAdapter {
  return new FakeAdapter((msg) =>
    msg.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : {},
  );
}

test('a turn that finishes with nobody watching is announced, naming the thread', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'go' }],
  });

  assert.deepEqual(announced, [
    {
      kind: 'idle',
      sessionId: 's1',
      sessionName: 'test',
      // The dashboard's own id, so the notification can link straight at the
      // conversation rather than at the box.
      threadId: 't1',
      // Untitled until a turn produces one, so it goes by its ordinal — the
      // same name the session list shows.
      threadName: 'Thread 1',
    },
  ]);
});

test('a turn that finishes in front of a browser is not announced', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();
  up.attach(fakeHandle(1, 'acp-gone'));

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'go' }],
  });
  assert.deepEqual(announced, []);
});

test('a browser on another thread does not count as watching this one', async () => {
  fakeDocker(plainAdapter());
  const up = manager.upstream('s1');
  await up.ensureStarted();
  // Watching the session's other conversation: this turn still finished with
  // nobody on it.
  up.attach(fakeHandle(1, 'acp-kept'));

  await up.forwardRequest('session/prompt', {
    sessionId: 'acp-gone',
    prompt: [{ type: 'text', text: 'go' }],
  });
  assert.deepEqual(
    announced.map((e) => [e.kind, e.threadId]),
    [['idle', 't1']],
  );
});

test('a queued permission request is announced as one', async () => {
  const adapter = plainAdapter();
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  // Nobody is attached, so the request is queued rather than delivered.
  adapter.push(permissionFrame('acp-kept'));
  await expect.poll(() => announced.length).toBe(1);
  assert.deepEqual(announced[0], {
    kind: 'approval',
    sessionId: 's1',
    sessionName: 'test',
    threadId: 't2',
    threadName: 'Thread 2',
  });
});
