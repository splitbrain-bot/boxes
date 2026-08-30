import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type Orchestrator } from './app.ts';
import { config } from './config.ts';
import { openDb, type Db } from './db.ts';
import * as dk from './docker.ts';

/**
 * The exec endpoint over its real routes, real database and real session
 * lookup, with only the Docker socket faked.
 */

/** One frame of a demuxable Docker stream. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Installs a fake Docker client that answers everything the routes touch. */
function fakeDocker(output: string, exitCode = 0): { execs: string[][] } {
  const execs: string[][] = [];
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;

  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      start: async () => undefined,
      inspect: async () => ({ State: { Running: true } }),
      exec: async (opts: { Cmd: string[] }) => {
        execs.push(opts.Cmd);
        return {
          start: async () => {
            const stream = new PassThrough();
            queueMicrotask(() => {
              // The repo probe is a plain `test -d`, which produces nothing.
              if (opts.Cmd[0] !== 'bash') return stream.end();
              stream.write(frame(output));
              stream.end();
            });
            return stream;
          },
          inspect: async () => ({ ExitCode: opts.Cmd[0] === 'bash' ? exitCode : 1 }),
        };
      },
    }),
  } as unknown as Docker);

  return { execs };
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;

/** A running session row, which is all the exec routes need to exist. */
function insertSession(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, status, current_thread_id, turn_active,
       created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', '["claude-agent-acp"]', 'c1',
       ?, '10.200.0.0/24', ?, ?, 'running', NULL, 0, ?, ?)`,
  ).run(id, `sn-${id}`, `ws-${id}`, `home-${id}`, now, now);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-app-'));
  // Before config(), which generates and writes the WS token on first read.
  process.env['DATA_DIR'] = dir;
  db = openDb(dir);
  orchestrator = buildApp(config(), db);
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

test('a command runs in the container and streams its output with a trailer', async () => {
  insertSession('abc123');
  const { execs } = fakeDocker('hello\n');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'echo hello' },
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/plain/);
  assert.equal(res.body, 'hello\n\n[exit 0]\n');
  // The command travels as an argument to bash inside the container; nothing
  // is assembled into a host command line.
  assert.deepEqual(execs.at(-1), ['bash', '-lc', 'echo hello']);
});

test('a non-zero exit is reported in the trailer', async () => {
  insertSession('abc123');
  fakeDocker('bash: nope: command not found\n', 127);

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'nope' },
  });
  assert.match(res.body, /\[exit 127\]/);
});

test('a finished run is stored and listed', async () => {
  insertSession('abc123');
  fakeDocker('clean\n');

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'git status' },
  });

  const res = await orchestrator.app.inject({ url: '/api/sessions/abc123/exec' });
  assert.equal(res.statusCode, 200);
  const { records } = res.json() as { records: Array<Record<string, unknown>> };
  assert.equal(records.length, 1);
  assert.equal(records[0]!['command'], 'git status');
  assert.equal(records[0]!['output'], 'clean\n');
  assert.equal(records[0]!['exitCode'], 0);
  assert.equal(records[0]!['truncated'], false);
});

test('running a command holds off the reaper', async () => {
  insertSession('abc123');
  fakeDocker('ok\n');
  db.prepare('UPDATE sessions SET last_active_at = 0 WHERE id = ?').run('abc123');

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'true' },
  });

  const row = db.prepare('SELECT last_active_at FROM sessions WHERE id = ?').get('abc123') as {
    last_active_at: number;
  };
  assert.ok(row.last_active_at > 0);
});

test('an empty command is rejected before anything runs', async () => {
  insertSession('abc123');
  const { execs } = fakeDocker('');

  for (const payload of [{ command: '' }, { command: '   ' }, {}]) {
    const res = await orchestrator.app.inject({
      method: 'POST',
      url: '/api/sessions/abc123/exec',
      payload,
    });
    assert.equal(res.statusCode, 400);
  }
  assert.deepEqual(execs, []);
});

test('an absurdly long command is rejected', async () => {
  insertSession('abc123');
  fakeDocker('');
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'x'.repeat(9000) },
  });
  assert.equal(res.statusCode, 400);
});

test('an unknown session is a 404 on both exec routes', async () => {
  fakeDocker('');
  const post = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/nosuch/exec',
    payload: { command: 'ls' },
  });
  assert.equal(post.statusCode, 404);

  const get = await orchestrator.app.inject({ url: '/api/sessions/nosuch/exec' });
  assert.equal(get.statusCode, 404);
});

test('a deleted session is a 404 too', async () => {
  insertSession('gone');
  db.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('gone');
  fakeDocker('');

  const res = await orchestrator.app.inject({ url: '/api/sessions/gone/exec' });
  assert.equal(res.statusCode, 404);
});

test('a session with no container cannot run a command', async () => {
  insertSession('abc123');
  db.prepare('UPDATE sessions SET container_id = NULL WHERE id = ?').run('abc123');
  fakeDocker('');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/abc123/exec',
    payload: { command: 'ls' },
  });
  assert.equal(res.statusCode, 409);
});

test('one session cannot see another session commands', async () => {
  insertSession('aaa');
  insertSession('bbb');
  fakeDocker('mine\n');

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/sessions/aaa/exec',
    payload: { command: 'whoami' },
  });

  const res = await orchestrator.app.inject({ url: '/api/sessions/bbb/exec' });
  assert.deepEqual((res.json() as { records: unknown[] }).records, []);
});

/**
 * The static handler, over a fixture bundle laid out the way the runtime
 * image lays out the dashboard's build output.
 */

/** Writes a minimal bundle next to where the handler looks for one. */
function writeBundle(): string {
  // The handler resolves the bundle relative to its own module, which is
  // src/ in a checkout and dist/ in the image. Both sit one level under the
  // package root, so the fixture goes where each of them would find it.
  const bundle = resolve(import.meta.dirname, '../dashboard');
  mkdirSync(join(bundle, 'assets'), { recursive: true });
  writeFileSync(
    join(bundle, 'index.html'),
    '<!doctype html><html><body><div id="app"></div></body></html>',
  );
  writeFileSync(join(bundle, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(bundle, 'assets', 'index-abc.css'), 'body{}');
  return bundle;
}

test('the dashboard bundle is served, with a single-page fallback', async () => {
  const bundle = writeBundle();
  try {
    // Real files come back as themselves, with the right content type.
    const js = await orchestrator.app.inject({ url: '/assets/index-abc.js' });
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'] as string, /text\/javascript/);

    const css = await orchestrator.app.inject({ url: '/assets/index-abc.css' });
    assert.match(css.headers['content-type'] as string, /text\/css/);

    // A client-side route is not a file, and must survive a reload.
    for (const url of ['/', '/new', '/sessions/abc123', '/sessions/abc123/info']) {
      const res = await orchestrator.app.inject({ url });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'] as string, /text\/html/, url);
      assert.match(res.body, /id="app"/, url);
    }

    // The API and the gateway do not get the fallback: a mistyped endpoint
    // must be a 404, not a page.
    for (const url of ['/api/nope', '/ws/nope']) {
      const res = await orchestrator.app.inject({ url });
      assert.equal(res.statusCode, 404, url);
    }

    // Nothing outside the bundle is reachable through a traversal.
    for (const url of ['/../package.json', '/assets/../../package.json']) {
      const res = await orchestrator.app.inject({ url });
      assert.match(res.headers['content-type'] as string, /text\/html/, url);
    }
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('a POST that matches no route is a 404 rather than the page', async () => {
  const bundle = writeBundle();
  try {
    const res = await orchestrator.app.inject({ method: 'POST', url: '/nope' });
    assert.equal(res.statusCode, 404);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});
