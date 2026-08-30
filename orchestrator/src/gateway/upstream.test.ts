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
import { SessionManager } from '../sessions.ts';

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

  constructor(private readonly answer: (msg: Rpc) => unknown) {
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

  private handle(line: string): void {
    const msg = JSON.parse(line) as Rpc;
    if (msg.id === undefined || !msg.method) return;
    this.seen.push(msg.method);
    const result = this.answer(msg);
    const body =
      result instanceof Error
        ? { error: { code: -32002, message: result.message } }
        : { result };
    this.push(frame(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })}\n`));
  }
}

/** Installs a fake Docker whose adapter exec is the given stand-in. */
function fakeDocker(adapter: FakeAdapter): void {
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;
  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      start: async () => undefined,
      inspect: async () => ({ State: { Running: true } }),
      exec: async () => ({
        start: async () => adapter,
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

/** A running session with two threads, the first of which is current. */
function seed(): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id,
       turn_active, created_at, last_active_at)
     VALUES ('s1', 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       'sn-s1', '10.200.0.0/24', 'ws-s1', 'home-s1', 'running', 't1', 0, ?, ?)`,
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
  manager = new SessionManager(db, cfg, new EgressManager(cfg));
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

test('selecting a thread makes it current and drops the browsers watching', async () => {
  const adapter = new FakeAdapter((msg) => {
    if (msg.method === 'initialize') return { protocolVersion: 1, agentCapabilities: {} };
    return {};
  });
  fakeDocker(adapter);
  const up = manager.upstream('s1');
  await up.ensureStarted();

  let closed = 0;
  up.attach({
    id: 1,
    lastActiveAt: Date.now(),
    notify: () => {},
    request: () => Promise.resolve({}),
    close: () => {
      closed++;
    },
  });

  const selected = manager.selectThread('s1', 't2');

  assert.equal(selected.id, 't2');
  assert.equal(up.current?.id, 't2');
  // Each browser reconnects on its own and lands on the new thread.
  assert.equal(closed, 1);
});
