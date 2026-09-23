import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type Orchestrator } from './app.ts';
import { config } from './config.ts';
import { openDb, upsertHarnessCatalog, type Db } from './db.ts';
import * as dk from './docker.ts';
import type { LoginExecSpec } from './login.ts';
import * as ws from './workspaces.ts';

/**
 * Installs a fake Docker client that answers everything the routes touch.
 *
 * Every exec here is a probe the manager runs while it prepares a box — the
 * repository check, the process list — and each produces nothing.
 */

/** One frame of a demuxable Docker stream. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/**
 * What the box's own `ps` prints, for the stop that reads it from inside.
 * Reset for every test, like everything else the fake Docker answers with.
 */
let insideBox = '';

/** Every `kill` the routes ran inside a box, as its arguments. */
let killedInBox: string[][] = [];

/** Installs a fake Docker client that answers everything the routes touch. */
function fakeDocker(): void {
  const modem = new Docker({ socketPath: '/var/run/docker.sock' }).modem;

  dk.setDockerForTests({
    modem,
    getContainer: () => ({
      start: async () => undefined,
      inspect: async () => ({ State: { Running: true } }),
      exec: async (opts: { Cmd: string[] }) => {
        if (opts.Cmd[0] === 'kill') killedInBox.push(opts.Cmd.slice(1));
        // The box-wide stop's two calls: a reading taken inside the container,
        // and the signal it aims at what the reading found.
        const answers = opts.Cmd[0] === 'ps' ? insideBox : null;
        return {
          start: async () => {
            const stream = new PassThrough();
            queueMicrotask(() => {
              // The repo probe is a plain `test -d`, which produces nothing.
              if (answers === null) return stream.end();
              stream.write(frame(answers));
              stream.end();
            });
            return stream;
          },
          inspect: async () => ({
            // A `ps` or a `kill` the stop ran succeeded; anything else this fake
            // does not answer for failed.
            ExitCode: answers === null && opts.Cmd[0] !== 'kill' ? 1 : 0,
          }),
        };
      },
    }),
  } as unknown as Docker);
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;

/**
 * A running box row with one thread, made current.
 *
 * The thread is what a local command is logged against, so a box without
 * one runs commands nobody is ever shown.
 */
function insertBox(id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO boxes (id, name, profile, image, container_id,
       network_name, subnet, ws_volume, home_volume, status,
       ws_token, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', 'img', 'c1',
       ?, '10.200.0.0/24', ?, ?, 'running', ?, ?, ?)`,
  ).run(id, `bn-${id}`, `ws-${id}`, `home-${id}`, `token-${id}`, now, now);
  insertThread(id, `${id}-t1`, 1);
}

/** One conversation of a box. Which one is current is set on the box. */
function insertThread(boxId: string, threadId: string, ordinal: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, box_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(threadId, boxId, ordinal, now, now);
}

beforeEach(() => {
  insideBox = '';
  killedInBox = [];
  dir = mkdtempSync(join(tmpdir(), 'boxes-app-'));
  // Before config(), which reads DATA_DIR once and keeps it for the process.
  process.env['DATA_DIR'] = dir;
  db = openDb(dir);
  orchestrator = buildApp(config(), db);
});

afterEach(async () => {
  // See insertWorkspaceBox: workspaces are written under the config's
  // DATA_DIR, which outlives this test's own directory.
  rmSync(ws.workspacesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  rmSync(ws.homesRoot(orchestrator.cfg.DATA_DIR), { recursive: true, force: true });
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

/** A directory-backed box, which is what an attachment needs. */
function insertWorkspaceBox(id: string): string {
  insertBox(id);
  // config() is memoised for the process, so the app's DATA_DIR is whatever
  // the first test in this file set — not necessarily this test's `dir`.
  // Everything that reaches the disk has to go through the app's own copy.
  const workspace = ws.createWorkspace(orchestrator.cfg.DATA_DIR, id);
  const home = ws.createHome(orchestrator.cfg.DATA_DIR, id);
  db.prepare('UPDATE boxes SET workspace_dir = ?, home_dir = ? WHERE id = ?').run(
    workspace,
    home,
    id,
  );
  return workspace;
}

test('an attachment is stored in the workspace and its path reported back', async () => {
  const workspace = insertWorkspaceBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('PNGDATA'),
  });

  assert.equal(res.statusCode, 200);
  const stored = res.json() as { name: string; path: string; size: number };
  assert.deepEqual(stored, { name: 'shot.png', path: '.boxes/attachments/shot.png', size: 7 });
  assert.equal(readFileSync(join(workspace, stored.path), 'utf8'), 'PNGDATA');
});

/**
 * Lists boxes until one reports a workspace size, or gives up.
 *
 * A measurement happens off the request path on purpose — the list must never
 * wait for a disk walk — so a test that wants one has to ask again. See
 * diskusage.ts.
 */
async function measuredSize(id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await orchestrator.app.inject({ url: '/api/boxes' });
    const listed = res.json() as Array<{ id: string; diskBytes: number | null }>;
    const size = listed.find((s) => s.id === id)?.diskBytes ?? null;
    if (size !== null) return size;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test('a box is measured off the request path and reported on the list', async () => {
  const workspace = insertWorkspaceBox('abc123');
  writeFileSync(join(workspace, 'checkout.bin'), Buffer.alloc(4096));
  // The home counts too, and on a box that has been working it is the larger
  // half: the thread history, the tool caches, whatever the agent installed.
  writeFileSync(
    join(ws.homePath(orchestrator.cfg.DATA_DIR, 'abc123'), 'cache.bin'),
    Buffer.alloc(2048),
  );

  // The first list answers with no size rather than waiting for the walk it
  // starts. A card shows nothing; a zero would be a claim.
  const first = await orchestrator.app.inject({ url: '/api/boxes' });
  assert.equal(
    (first.json() as Array<{ diskBytes: number | null }>)[0]!.diskBytes,
    null,
  );

  assert.equal(await measuredSize('abc123'), 4096 + 2048);
});

test('an upload is what says a workspace grew, since nothing else can say it', async () => {
  const workspace = insertWorkspaceBox('abc123');
  writeFileSync(join(workspace, 'checkout.bin'), Buffer.alloc(4096));
  assert.equal(await measuredSize('abc123'), 4096);

  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(2048),
  });

  // A measurement stands for a quarter of an hour, and a stopped box's stands
  // for as long as it is stopped — so the one thing that puts bytes in a
  // workspace from out here has to drop it rather than wait for it to expire.
  const after = await measuredSize('abc123');
  assert.ok(after !== null && after >= 4096 + 2048, `grew to ${String(after)}`);
});

test('an attachment name that is a path is reduced to a name', async () => {
  const workspace = insertWorkspaceBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/boxes/abc123/attachments?name=${encodeURIComponent('../../escape.txt')}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });

  assert.equal((res.json() as { path: string }).path, '.boxes/attachments/escape.txt');
  assert.ok(existsSync(join(workspace, '.boxes/attachments/escape.txt')));
});

test('an attachment upload without a name or a body is refused', async () => {
  insertWorkspaceBox('abc123');
  const headers = { 'content-type': 'application/octet-stream' };

  const nameless = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments',
    headers,
    payload: Buffer.from('x'),
  });
  assert.equal(nameless.statusCode, 400);

  const empty = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=a.txt',
    headers,
    payload: Buffer.alloc(0),
  });
  assert.equal(empty.statusCode, 400);
});

test('an attachment to a box that has no workspace is a 404', async () => {
  // Inserted, but never given a workspace directory: nothing to write into.
  insertBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=a.txt',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });
  assert.equal(res.statusCode, 404);
});

test('an attachment over the size limit is refused, and says so', async () => {
  insertWorkspaceBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=big.bin',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(config().MAX_ATTACHMENT_MB * 1024 * 1024 + 1),
  });

  // Fastify's own refusal, passed through with its status rather than
  // flattened into a 500 — the size is the one thing the user can act on.
  assert.equal(res.statusCode, 413);
});

test('a stored image is served back as itself, for the thread to show', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=shot.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('PNGDATA'),
  });

  const res = await orchestrator.app.inject({ url: '/api/boxes/abc123/attachments/shot.png' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body, 'PNGDATA');
});

test('an SVG is served as one, inert, so a diagram can be looked at', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=diagram.svg',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('<svg onload="alert(1)"></svg>'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/attachments/diagram.svg',
  });

  assert.equal(res.headers['content-type'], 'image/svg+xml');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // This is what makes the line above safe: an SVG opened as a document has
  // no script, no origin and no network. Behind the <img> the thread uses it
  // is inert regardless.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
});

test('a PDF is served as one, unsandboxed, so a tab can show it', async () => {
  insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=report.pdf',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('%PDF-1.4'),
  });

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/attachments/report.pdf',
  });

  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'] as string, /^inline/);
  // No `sandbox`: a sandboxed document is one a browser may decline to hand
  // to its PDF viewer, which would make opening it a download again. The
  // rest of the policy still applies.
  assert.equal(res.headers['content-security-policy'], "default-src 'none'");
});

test('a format nothing renders is served as a download of unknown type', async () => {
  insertWorkspaceBox('abc123');
  // HTML above all: served as itself it would run as this origin, and unlike
  // an SVG there is no way to show it that does not.
  for (const name of ['page.html', 'notes.txt', 'archive.zip']) {
    await orchestrator.app.inject({
      method: 'POST',
      url: `/api/boxes/abc123/attachments?name=${name}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });

    const res = await orchestrator.app.inject({
      url: `/api/boxes/abc123/attachments/${name}`,
    });
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'] as string, /^attachment/);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  }
});

test('a link planted in the attachments directory serves nothing', async () => {
  const workspace = insertWorkspaceBox('abc123');
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/attachments?name=real.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('x'),
  });
  // What an agent with a foothold in its own workspace would try: the
  // orchestrator's own uid can read the database, and every box's gateway
  // token is in it.
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'a gateway token');
  symlinkSync(secret, join(workspace, '.boxes/attachments/escape.png'));

  const res = await orchestrator.app.inject({
    url: '/api/boxes/abc123/attachments/escape.png',
  });
  assert.equal(res.statusCode, 404);
});

test('an attachment name that is a path fetches nothing', async () => {
  insertWorkspaceBox('abc123');
  const res = await orchestrator.app.inject({
    url: `/api/boxes/abc123/attachments/${encodeURIComponent('../../../etc/passwd')}`,
  });
  assert.equal(res.statusCode, 404);
});

test('an attachment that was never stored is a 404', async () => {
  insertWorkspaceBox('abc123');
  const res = await orchestrator.app.inject({ url: '/api/boxes/abc123/attachments/nope.png' });
  assert.equal(res.statusCode, 404);
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
  // Vite copies public/ to the bundle root, which is where these two have to
  // stay: see the service worker test below.
  writeFileSync(join(bundle, 'sw.js'), 'self.addEventListener("push", () => {})');
  writeFileSync(join(bundle, 'manifest.webmanifest'), '{"name":"Boxes"}');
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
    for (const url of ['/', '/new', '/boxes/abc123', '/boxes/abc123/info']) {
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

test('the service worker and the manifest are served from the bundle root', async () => {
  const bundle = writeBundle();
  try {
    // A service worker may only control the scope it is served from, so this
    // has to be /sw.js and not an asset path — and it must be the file rather
    // than the single-page fallback, which would register an HTML document as
    // a worker and take push out silently.
    const sw = await orchestrator.app.inject({ url: '/sw.js' });
    assert.equal(sw.statusCode, 200);
    assert.match(sw.headers['content-type'] as string, /text\/javascript/);
    assert.match(sw.body, /addEventListener\("push"/);

    // Without the manifest an iPhone cannot install the page, and without
    // installing it, it has no Push API at all.
    const manifest = await orchestrator.app.inject({ url: '/manifest.webmanifest' });
    assert.equal(manifest.statusCode, 200);
    assert.match(manifest.headers['content-type'] as string, /application\/manifest\+json/);
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

test('the hashed assets are cached for good and the page never is', async () => {
  const bundle = writeBundle();
  try {
    // The name carries the content hash, so this copy can never be the wrong
    // one: a changed file is a changed name.
    const asset = await orchestrator.app.inject({ url: '/assets/index-abc.js' });
    assert.match(asset.headers['cache-control'] as string, /immutable/);

    // index.html is the file that says which assets are current, so a held
    // copy would go on naming the ones it was built with.
    const page = await orchestrator.app.inject({ url: '/boxes/abc123' });
    assert.equal(page.headers['cache-control'], 'no-cache');
    // And so is everything else that keeps its name across builds.
    const worker = await orchestrator.app.inject({ url: '/sw.js' });
    assert.equal(worker.headers['cache-control'], 'no-cache');
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('the page is served under a policy that pins every fetch to this origin', async () => {
  const bundle = writeBundle();
  try {
    const res = await orchestrator.app.inject({
      url: '/',
      headers: { host: 'boxes.example:8443' },
    });
    const csp = res.headers['content-security-policy'] as string;

    // A remote image in markdown the agent wrote is the channel this closes.
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /default-src 'none'/);
    // The gateway socket is spelled out, on this host and no other.
    assert.match(csp, /connect-src 'self' ws:\/\/boxes\.example:8443 wss:\/\/boxes\.example:8443/);
    // The one inline script the page has is allowed by its hash, and nothing
    // else inline is.
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);

    // A Host header that is not a plain host never reaches the header.
    const odd = await orchestrator.app.inject({
      url: '/',
      headers: { host: 'evil; script-src *' },
    });
    const oddCsp = odd.headers['content-security-policy'] as string;
    assert.ok(!oddCsp.includes('script-src *'), 'the header is not writable from outside');
    assert.match(oddCsp, /connect-src 'self';/);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('a bundle worth compressing is compressed', async () => {
  const bundle = writeBundle();
  try {
    writeFileSync(join(bundle, 'assets', 'big-abc.js'), `// ${'x'.repeat(20_000)}\n`);
    const res = await orchestrator.app.inject({
      url: '/assets/big-abc.js',
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.ok(res.rawPayload.length < 2000, `${res.rawPayload.length} bytes on the wire`);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

// --- Liveness, readiness and the request log ---------------------------------

test('a deployment that cannot serve boxes is live but not ready', async () => {
  // Nothing has pushed an egress policy here, so a box created now would
  // get no egress at all.
  const ready = await orchestrator.app.inject({ url: '/readyz' });
  assert.equal(ready.statusCode, 503);
  const body = ready.json() as { ready: boolean; checks: Record<string, boolean> };
  assert.equal(body.ready, false);
  // The database is the one of the three that is there.
  assert.equal(body.checks['database'], true);
  assert.equal(body.checks['egress'], false);

  // Liveness is about this process serving, and it is: a probe reading the
  // status code must not restart an orchestrator that is merely unconfigured.
  const live = await orchestrator.app.inject({ url: '/healthz' });
  assert.equal(live.statusCode, 200);
});

test('every response is logged with what was asked and what came back', async () => {
  const lines: string[] = [];
  const written = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await orchestrator.app.inject({ url: '/api/boxes?name=secret' });
    await orchestrator.app.inject({ url: '/api/boxes/nope' });
  } finally {
    process.stderr.write = written;
  }

  const logged = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === 'request');

  const ok = logged.find((line) => line['status'] === 200);
  assert.equal(ok?.['method'], 'GET');
  // The query string is left off: it carries what the reader typed.
  assert.equal(ok?.['path'], '/api/boxes');
  assert.equal(typeof ok?.['ms'], 'number');

  // A refusal is the caller's problem rather than the deployment's, so it is
  // a warning and not an error.
  const refused = logged.find((line) => line['status'] === 404);
  assert.equal(refused?.['level'], 'warn');
});

// --- Web Push registration --------------------------------------------------

/** A subscription shaped the way the browser's own toJSON() produces one. */
function subscription(endpoint = 'https://push.example.net/x/abc'): Record<string, unknown> {
  return {
    endpoint,
    keys: {
      // 65 and 16 bytes: what a real P-256 point and auth secret decode to.
      p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    },
  };
}

/** Every stored subscription, as rows. */
function subscriptions(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM push_subscriptions').all() as Array<
    Record<string, unknown>
  >;
}

test('the VAPID public key is served and stays the same across reads', async () => {
  const first = await orchestrator.app.inject({ url: '/api/push/key' });
  const second = await orchestrator.app.inject({ url: '/api/push/key' });

  assert.equal(first.statusCode, 200);
  const key = (first.json() as { publicKey: string }).publicKey;
  // Uncompressed P-256, which is the only form a browser accepts here.
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  // A key that changed between reads would invalidate every subscription
  // made against the previous one.
  assert.equal((second.json() as { publicKey: string }).publicKey, key);
});

test('a browser registers once however many times it subscribes', async () => {
  const first = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: subscription(),
  });
  assert.equal(first.statusCode, 204);

  // Re-subscribing hands back the same endpoint with fresh keys, which has to
  // update the row rather than add one.
  const rotated = subscription();
  (rotated['keys'] as Record<string, string>)['auth'] = Buffer.alloc(16, 1).toString(
    'base64url',
  );
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: rotated,
  });

  const rows = subscriptions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['auth'], (rotated['keys'] as Record<string, string>)['auth']);
});

test('the health probe counts subscribed browsers', async () => {
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: subscription(),
  });
  const res = await orchestrator.app.inject({ url: '/healthz' });
  assert.equal((res.json() as { pushSubscriptions: number }).pushSubscriptions, 1);
});

test('an endpoint the orchestrator must not be aimed at is refused', async () => {
  const refused = [
    'http://push.example.net/x', // not https
    'https://127.0.0.1/x', // an address literal in the owner's own space
    'https://localhost/x',
    'https://[::1]/x',
  ];
  for (const endpoint of refused) {
    const res = await orchestrator.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: subscription(endpoint),
    });
    assert.equal(res.statusCode, 400, `${endpoint} should be refused`);
  }
  assert.equal(subscriptions().length, 0);
});

test('a subscription with keys of the wrong size is refused', async () => {
  const bad = subscription();
  (bad['keys'] as Record<string, string>)['p256dh'] = Buffer.alloc(32).toString('base64url');
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: bad,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(subscriptions().length, 0);
});

test('a browser can unsubscribe itself', async () => {
  await orchestrator.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: subscription(),
  });
  const res = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/push/subscribe',
    payload: { endpoint: 'https://push.example.net/x/abc' },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(subscriptions().length, 0);
});

// --- agent configuration over its real routes ---------------------------------

test('a set is created, filled and read back over the API', async () => {
  const created = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/agent-sets',
    payload: { name: 'Go projects' },
  });
  assert.equal(created.statusCode, 201);
  const set = created.json() as { id: string; global: boolean };
  assert.equal(set.global, false);

  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: `/api/agent-sets/${set.id}/items`,
    payload: { kind: 'command', name: 'bench', content: 'Run the benchmarks.' },
  });
  assert.equal(put.statusCode, 200);
  // Every mutation answers with the whole set, so the editor needs one call.
  assert.deepEqual(
    (put.json() as { items: Array<{ name: string }> }).items.map((i) => i.name),
    ['bench'],
  );

  const listed = await orchestrator.app.inject({ url: '/api/agent-sets' });
  assert.deepEqual(
    (listed.json() as Array<{ id: string }>).map((s) => s.id),
    ['global', set.id],
  );
});

test('the preview shows the merge, overrides named', async () => {
  await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/agent-sets/global',
    payload: { agentsMd: 'House rules.' },
  });
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/items',
    payload: { kind: 'skill', name: 'review', content: 'global' },
  });
  const set = (
    await orchestrator.app.inject({
      method: 'POST',
      url: '/api/agent-sets',
      payload: { name: 'Go' },
    })
  ).json() as { id: string };
  await orchestrator.app.inject({
    method: 'PATCH',
    url: `/api/agent-sets/${set.id}`,
    payload: { agentsMd: 'Go rules.' },
  });
  await orchestrator.app.inject({
    method: 'PUT',
    url: `/api/agent-sets/${set.id}/items`,
    payload: { kind: 'skill', name: 'review', content: 'go' },
  });

  const preview = (
    await orchestrator.app.inject({ url: `/api/agent-sets/${set.id}/preview` })
  ).json() as {
    agentsMd: string;
    items: Array<{ name: string; content: string }>;
    overrides: Array<{ name: string }>;
  };
  assert.equal(preview.agentsMd, 'House rules.\n\nGo rules.');
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0]!.content, 'go');
  assert.deepEqual(preview.overrides, [{ kind: 'skill', name: 'review' }]);
});

test('the global set is refused deletion, and an unknown set is a 404', async () => {
  const global = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/agent-sets/global',
  });
  assert.equal(global.statusCode, 400);

  const unknown = await orchestrator.app.inject({ url: '/api/agent-sets/nope' });
  assert.equal(unknown.statusCode, 404);
});

test('creating a box against an unknown set is refused before anything is built', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: { name: 'a box', agentSet: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown agent set/);
  // Nothing was inserted: the check runs before the row does.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM boxes').get() as { n: number };
  assert.equal(rows.n, 0);
});

test('starting a container to reach into writes the current configuration first', async () => {
  // Opening a thread and opening a terminal both start a stopped box without
  // going through /start, and the entrypoint installs whatever is on disk at
  // that moment — so the box must not be started against a stale set.
  insertBox('abc123');
  fakeDocker();
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/agent-sets/global/items',
    payload: { kind: 'command', name: 'ship', content: 'Open a PR.' },
  });

  await orchestrator.manager.execTarget('abc123');

  // config() caches process-wide, so the data directory in force is the
  // orchestrator's own rather than this test's fresh one.
  assert.equal(
    readFileSync(
      join(orchestrator.cfg.DATA_DIR, 'agents', 'abc123', '.claude', 'commands', 'ship.md'),
      'utf8',
    ),
    'Open a PR.\n',
  );
});

test('stopping background work names a thread, and 404s for one that is not there', async () => {
  insertBox('abc123');

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/nope/background/stop',
    payload: {},
  });
  assert.equal(missing.statusCode, 404);

  // A thread with no conversation upstream cannot have announced a task: a
  // task is named by the adapter's own id for the conversation it is on, and
  // this thread has none. Said without reaching Docker at all.
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads (id, box_id, acp_session_id, title, ordinal,
       created_at, last_active_at)
     VALUES ('t1', 'abc123', NULL, NULL, 1, ?, ?)`,
  ).run(now, now);

  // `processId` is the adapter's async task id now, not a hash of a command
  // line. The body keeps its shape, so a browser from before this is wrong
  // about what the id means rather than about how to send it.
  const unminted = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/t1/background/stop',
    payload: { processId: 'task-1' },
  });
  assert.equal(unminted.statusCode, 200);
  assert.deepEqual(unminted.json(), { stopped: 0 });
});

test('stopping everything in a box signals the work and nothing of Boxes own', async () => {
  // The floor's own stop, for work no conversation can name: after an adapter
  // restart the bars are empty and the box is still compiling something.
  insertBox('abc123');
  fakeDocker();
  insideBox = [
    '  PID  PPID COMMAND',
    '    1     0 /sbin/docker-init -- /usr/local/bin/entrypoint.sh',
    '    7     1 sleep infinity',
    '   12     1 node /usr/local/bin/claude-agent-acp',
    '   13    12 claude --output-format stream-json --box-id=acp-1',
    "   14    13 /bin/bash -c eval 'npm run build'",
    '   20     1 node /usr/local/bin/codex-acp',
    '   21    20 codex app-server',
    '   22    21 bash -lc npm run watch',
    '   30     1 ps -eo pid,ppid,args',
  ].join('\n');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/background/stop',
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { stopped: 2 });
  // The two shells, and neither adapter, neither agent, nothing of the
  // entrypoint's and not the `ps` that took the reading.
  assert.deepEqual(killedInBox, [['-TERM', '14', '22']]);
});

test('stopping everything in a box that is not there is a 404', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/nope/background/stop',
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});

test('marking a thread done is remembered, reversible, and 404s for a thread that is not there', async () => {
  insertBox('abc123');
  const before = db.prepare("SELECT last_active_at FROM threads WHERE id = 'abc123-t1'").get() as {
    last_active_at: number;
  };

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/nope/done',
    payload: { done: true },
  });
  assert.equal(missing.statusCode, 404);

  // A mark is a boolean or it is nothing: a body that says neither would
  // otherwise unmark whatever it was sent about.
  const empty = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: {},
  });
  assert.equal(empty.statusCode, 400);

  const marked = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: { done: true },
  });
  assert.equal(marked.statusCode, 200);
  assert.equal((marked.json() as { done: boolean }).done, true);

  // Read back over the list route, which is where the dashboard sees it.
  const threads = await orchestrator.app.inject({
    method: 'GET',
    url: '/api/boxes/abc123/threads',
  });
  assert.deepEqual(
    (threads.json() as Array<{ id: string; done: boolean }>).map((t) => [t.id, t.done]),
    [['abc123-t1', true]],
  );

  // And the mark comes off the same way it went on.
  const unmarked = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: { done: false },
  });
  assert.equal((unmarked.json() as { done: boolean }).done, false);

  // Nothing else moved: marking a conversation done is bookkeeping about it,
  // not something that happened in it.
  const after = db.prepare("SELECT last_active_at FROM threads WHERE id = 'abc123-t1'").get() as {
    last_active_at: number;
  };
  assert.equal(after.last_active_at, before.last_active_at);
});

test('a listed box carries its own WebSocket token', async () => {
  insertBox('abc123');
  insertBox('def456');

  const res = await orchestrator.app.inject({ url: '/api/boxes' });
  const listed = res.json() as Array<{ id: string; wsToken: string }>;

  // Each summary hands out the token of the box it is about, so a reader
  // of one box never learns what opens the one beside it.
  assert.deepEqual(
    listed.map((s) => [s.id, s.wsToken]).sort(),
    [
      ['abc123', 'token-abc123'],
      ['def456', 'token-def456'],
    ],
  );
});

// --- request bodies over the real routes --------------------------------------
//
// Every route that takes a JSON body checks it before it acts, so a body that
// is wrong is a 400 saying which field is wrong rather than a cast that
// misbehaves further in.

test('a body missing a required field is refused, and the answer names it', async () => {
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /^name: /);
});

test('a field of the wrong type is refused rather than read as one', async () => {
  insertBox('abc123');

  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/abc123/threads/abc123-t1/done',
    payload: { done: 'yes' },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /^done: /);

  // And nothing was written on the way to the refusal.
  const row = db.prepare("SELECT done FROM threads WHERE id = 'abc123-t1'").get() as {
    done: number;
  };
  assert.equal(row.done, 0);
});

test('a body that leaves out an optional field is taken as it is', async () => {
  await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/agent-sets/global',
    payload: { name: 'Everywhere', agentsMd: 'House rules.' },
  });

  // An empty body names no field, so every field keeps what it had.
  const res = await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/agent-sets/global',
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const set = res.json() as { name: string; agentsMd: string };
  assert.equal(set.name, 'Everywhere');
  assert.equal(set.agentsMd, 'House rules.');
});

// --- credentials and settings over their real routes --------------------------

test('a pasted credential is stored, shown by its last four, and never read back', async () => {
  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcdefgh1234' },
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), {
    id: 'claude',
    method: 'token',
    account: '1234',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: (put.json() as { updatedAt: number }).updatedAt,
  });

  const list = await orchestrator.app.inject({ url: '/api/credentials' });
  // Write-only: the secret exists in the database and in the proxy, and in no
  // answer this API gives.
  assert.ok(!list.payload.includes('sk-ant-oat01-abcdefgh1234'));
  assert.deepEqual(
    (list.json() as Array<{ id: string }>).map((c) => c.id),
    ['claude'],
  );

  const removed = await orchestrator.app.inject({
    method: 'DELETE',
    url: '/api/credentials/claude',
  });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual((await orchestrator.app.inject({ url: '/api/credentials' })).json(), []);
});

test('a credential nobody can use is refused rather than stored', async () => {
  const unknown = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/bitbucket',
    payload: { method: 'token', secret: 'x' },
  });
  assert.equal(unknown.statusCode, 400);

  const method = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'magic', secret: 'x' },
  });
  assert.equal(method.statusCode, 400);

  const empty = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: '   ' },
  });
  assert.equal(empty.statusCode, 400);

  assert.deepEqual((await orchestrator.app.inject({ url: '/api/credentials' })).json(), []);
});

/**
 * A login, over its real routes and a scripted CLI.
 *
 * The container and the exec are injected — a daemon is the one thing these
 * tests cannot have — so what is exercised here is the shape the settings page
 * consumes: one call to start, a poll that answers with a state, a code posted
 * back, and a cancel that takes the container with it.
 */
function fakeLogins(): {
  execs: Array<{ spec: LoginExecSpec; output: PassThrough; input: string }> ;
  removed: string[];
} {
  const execs: Array<{ spec: LoginExecSpec; output: PassThrough; input: string }> = [];
  const removed: string[] = [];
  orchestrator.logins.setRuntimeForTests({
    start: async () => 'login-container',
    exec: async (_id, spec) => {
      const output = new PassThrough();
      const record = { spec, output, input: '' };
      execs.push(record);
      const stdin = spec.tty ? new PassThrough() : null;
      stdin?.on('data', (chunk: Buffer) => {
        record.input += chunk.toString('utf8');
      });
      return {
        output,
        stdin,
        exited: new Promise<number | null>(() => {}),
        kill: () => output.destroy(),
      };
    },
    remove: async (id) => {
      removed.push(id);
    },
  });
  return { execs, removed };
}

/** Waits for something a flow does on its own, or gives up loudly. */
async function untilTrue(
  what: string,
  ready: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a login is started, polled, and cancelled over its own routes', async () => {
  const fake = fakeLogins();

  const started = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/openai/login',
  });
  assert.equal(started.statusCode, 200);
  const { loginId } = started.json() as { loginId: string };
  assert.ok(loginId);

  const first = await orchestrator.app.inject({
    url: `/api/credentials/openai/login/${loginId}`,
  });
  assert.deepEqual(first.json(), { state: 'starting' });

  await untilTrue('the CLI to be running', () => fake.execs.length === 1);
  fake.execs[0]!.output.write(
    'Open https://auth.openai.com/codex/device and enter WXYZ-1234\n',
  );

  let state = { state: 'starting' } as Record<string, unknown>;
  await untilTrue('the poll to move', async () => {
    const res = await orchestrator.app.inject({
      url: `/api/credentials/openai/login/${loginId}`,
    });
    state = res.json() as Record<string, unknown>;
    return state['state'] === 'awaiting_browser';
  });
  assert.deepEqual(state, {
    state: 'awaiting_browser',
    url: 'https://auth.openai.com/codex/device',
    code: 'WXYZ-1234',
  });

  const cancelled = await orchestrator.app.inject({
    method: 'DELETE',
    url: `/api/credentials/openai/login/${loginId}`,
  });
  assert.equal(cancelled.statusCode, 204);
  await untilTrue('the container to go', () => fake.removed.length === 1);

  // The id stops resolving with it, which is what a page polling an abandoned
  // login sees.
  const gone = await orchestrator.app.inject({
    url: `/api/credentials/openai/login/${loginId}`,
  });
  assert.equal(gone.statusCode, 404);
});

test("a code is posted back into Claude's flow, and refused where none is wanted", async () => {
  const fake = fakeLogins();
  const started = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/claude/login',
  });
  const { loginId } = started.json() as { loginId: string };

  await untilTrue('the CLI to be running', () => fake.execs.length === 1);
  const cli = fake.execs[0]!;
  // Nothing is waiting for a code yet, and saying so beats writing into a
  // stream nobody is reading.
  const early = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/credentials/claude/login/${loginId}/code`,
    payload: { code: 'x' },
  });
  assert.equal(early.statusCode, 409);

  cli.output.write('Visit: https://claude.ai/oauth/authorize\nPaste code here if prompted > ');
  await untilTrue('the prompt', async () => {
    const res = await orchestrator.app.inject({
      url: `/api/credentials/claude/login/${loginId}`,
    });
    return (res.json() as { state: string }).state === 'awaiting_code';
  });

  const posted = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/credentials/claude/login/${loginId}/code`,
    payload: { code: 'from-the-page' },
  });
  assert.equal(posted.statusCode, 204);
  await untilTrue('the code to be entered', () => cli.input.endsWith('\r'));
  // A carriage return: the Enter key's own byte, which is what the raw
  // terminal the UI reads needs to see.
  assert.equal(cli.input, 'from-the-page\r');

  const missing = await orchestrator.app.inject({
    method: 'POST',
    url: `/api/credentials/claude/login/${loginId}/code`,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
});

test('GitHub has no login flow, and neither has anything else unknown', async () => {
  const fake = fakeLogins();
  const github = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/github/login',
  });
  assert.equal(github.statusCode, 400);
  assert.match((github.json() as { error: string }).error, /no login flow/);

  const unknown = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/credentials/gitlab/login',
  });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(fake.removed, []);
});

test('an account credential is reported, and says why it cannot run a box yet', async () => {
  const document = JSON.stringify({
    tokens: { access_token: 'a.b.c', refresh_token: 'r' },
    last_refresh: '2026-09-12T10:00:00Z',
  });
  orchestrator.credentials.put('openai', 'oauth', document, { account: 'someone@example.com' });

  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{
      id: string;
      runnable: boolean;
      credential: { account: string; status: string; lastError: string | null } | null;
    }>;
  };
  const codex = health.harnesses.find((h) => h.id === 'codex');
  assert.equal(codex?.credential?.account, 'someone@example.com');
  assert.equal(codex?.credential?.status, 'ok');
  // Stored, refreshed, and still not something a box can be handed: the proxy
  // swaps a header and this authenticates traffic nobody intercepts.
  assert.equal(codex?.runnable, false);
  assert.match(codex?.credential?.lastError ?? '', /cannot hand a subscription login to a box/);
});

test('the git identity round-trips, and defaults where nobody has set it', async () => {
  const initial = await orchestrator.app.inject({ url: '/api/settings' });
  assert.deepEqual(initial.json(), {
    gitName: 'boxes-bot',
    gitEmail: 'boxes-bot@users.noreply.github.com',
    dialogs: {},
  });

  const patched = await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { gitEmail: 'bot@example.com' },
  });
  assert.deepEqual(patched.json(), {
    gitName: 'boxes-bot',
    gitEmail: 'bot@example.com',
    dialogs: {},
  });
  assert.equal(
    ((await orchestrator.app.inject({ url: '/api/settings' })).json() as { gitEmail: string })
      .gitEmail,
    'bot@example.com',
  );

  const bad = await orchestrator.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { gitName: 42 },
  });
  assert.equal(bad.statusCode, 400);
});

test('the health probe says which harness can run, and on what', async () => {
  const before = await orchestrator.app.inject({ url: '/healthz' });
  const empty = before.json() as {
    harnesses: Array<{ id: string; runnable: boolean; credential: unknown }>;
    credentials: unknown[];
  };
  // Both harnesses, because a box can be handed a placeholder for either
  // credential. Neither runs yet: nothing is stored.
  assert.deepEqual(
    empty.harnesses.map((h) => [h.id, h.runnable]),
    [
      ['claude', false],
      ['codex', false],
    ],
  );
  assert.equal(empty.harnesses[0]!.credential, null);
  assert.equal(empty.harnesses[1]!.credential, null);
  assert.deepEqual(empty.credentials, []);

  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcdefgh1234' },
  });

  const after = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ id: string; runnable: boolean; credential: { account: string } | null }>;
    credentials: Array<{ id: string }>;
  };
  assert.equal(after.harnesses[0]!.runnable, true);
  assert.equal(after.harnesses[0]!.credential?.account, '1234');
  // One credential is one harness: Codex is still waiting for its own.
  assert.equal(after.harnesses[1]!.runnable, false);
  // Every stored credential is reported, GitHub included, because the
  // settings page reads them from here.
  assert.deepEqual(
    after.credentials.map((c) => c.id),
    ['claude'],
  );
});

test('an OpenAI key entered on the settings page is what makes Codex runnable', async () => {
  const put = await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/openai',
    payload: { method: 'api_key', secret: 'sk-proj-abcdefgh5678' },
  });
  assert.equal(put.statusCode, 200);
  // Write-only: the page is told which key this is and never the key.
  assert.deepEqual(put.json(), {
    id: 'openai',
    method: 'api_key',
    account: '5678',
    status: 'ok',
    lastError: null,
    expiresAt: null,
    refreshedAt: null,
    updatedAt: (put.json() as { updatedAt: number }).updatedAt,
  });

  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ id: string; runnable: boolean }>;
  };
  assert.deepEqual(
    health.harnesses.map((h) => [h.id, h.runnable]),
    [
      ['claude', false],
      ['codex', true],
    ],
  );

  const harnesses = (await orchestrator.app.inject({ url: '/api/harnesses' })).json() as Array<{
    id: string;
    runnable: boolean;
  }>;
  assert.equal(harnesses.find((h) => h.id === 'codex')?.runnable, true);
});

test('a credential that is failing is still offered, and says it is not runnable', async () => {
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcdefgh1234' },
  });
  orchestrator.credentials.markStatus('claude', 'expired', 'a year is up');

  const health = (await orchestrator.app.inject({ url: '/healthz' })).json() as {
    harnesses: Array<{ runnable: boolean; credential: { status: string; lastError: string } }>;
  };
  assert.equal(health.harnesses[0]!.runnable, false);
  assert.equal(health.harnesses[0]!.credential.status, 'expired');
  assert.equal(health.harnesses[0]!.credential.lastError, 'a year is up');
});

// --- harnesses, and the thread bodies that name one ---------------------------

test('the harness list carries the registry, the catalogue and the health', async () => {
  const res = await orchestrator.app.inject({ url: '/api/harnesses' });
  assert.equal(res.statusCode, 200);
  const fresh = res.json() as Array<{
    id: string;
    runnable: boolean;
    defaultModeId: string;
    forkModeId: string;
    defaultConfig: Record<string, string>;
    catalog: unknown;
  }>;
  // Both, on the same rule the health probe uses: a harness this deployment
  // can carry a credential to is offered whether or not one is stored.
  assert.deepEqual(
    fresh.map((h) => h.id),
    ['claude', 'codex'],
  );
  assert.equal(fresh[0]!.defaultModeId, 'auto');
  assert.equal(fresh[0]!.forkModeId, 'plan');
  assert.deepEqual(fresh[0]!.defaultConfig, { model: 'opus' });
  // Codex's own defaults, which the dialog prefills from: the container is the
  // boundary, so a fresh thread is in full access, and the model is left to
  // the adapter.
  assert.equal(fresh[1]!.defaultModeId, 'agent-full-access');
  assert.equal(fresh[1]!.forkModeId, 'read-only');
  assert.deepEqual(fresh[1]!.defaultConfig, {});
  assert.equal(fresh[1]!.catalog, null);
  // Nothing has run an adapter here, so there is nothing cached and no box is
  // started to find out: the dialog shows the agent choice alone.
  assert.equal(fresh[0]!.catalog, null);
  assert.equal(fresh[0]!.runnable, false);

  // What an adapter last advertised, cached by the gateway and read back here.
  upsertHarnessCatalog(
    db,
    'claude',
    { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'plan' }] },
    [{ id: 'model', category: 'model', currentValue: 'opus' }],
  );
  await orchestrator.app.inject({
    method: 'PUT',
    url: '/api/credentials/claude',
    payload: { method: 'token', secret: 'sk-ant-oat01-abcd1234' },
  });

  const after = (await orchestrator.app.inject({ url: '/api/harnesses' })).json() as Array<{
    runnable: boolean;
    catalog: { modes: { availableModes: Array<{ id: string }> } } | null;
  }>;
  assert.equal(after[0]!.runnable, true);
  assert.deepEqual(after[0]!.catalog?.modes.availableModes, [{ id: 'auto' }, { id: 'plan' }]);
});

test('a thread reports the agent it runs and what it is configured with', async () => {
  insertBox('harn01');
  db.prepare(
    `UPDATE threads SET mode_id = 'plan', config = '{"model":"opus"}' WHERE id = ?`,
  ).run('harn01-t1');

  const res = await orchestrator.app.inject({ url: '/api/boxes/harn01/threads' });
  assert.deepEqual(res.json(), [
    {
      id: 'harn01-t1',
      // Claude, which is what a row written before harnesses existed is and
      // what a request naming none asks for.
      harness: 'claude',
      acpSessionId: null,
      title: null,
      ordinal: 1,
      turnActive: false,
      speaking: false,
      backgroundBusy: false,
      pendingCount: 0,
      modeId: 'plan',
      config: { model: 'opus' },
      // No adapter has been reached, so nothing is claimed about forking.
      canFork: false,
      done: false,
      createdAt: (res.json() as Array<{ createdAt: number }>)[0]!.createdAt,
      lastActiveAt: (res.json() as Array<{ lastActiveAt: number }>)[0]!.lastActiveAt,
    },
  ]);
});

test('a thread for an agent nobody has is refused before anything is started', async () => {
  insertBox('harn02');
  const res = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes/harn02/threads',
    payload: { options: { harness: 'gemini' } },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown harness/);
  // Nothing was created on the way to the refusal: the box still has the one
  // thread it was seeded with.
  const threads = (
    await orchestrator.app.inject({ url: '/api/boxes/harn02/threads' })
  ).json() as unknown[];
  assert.equal(threads.length, 1);

  // Same answer when a box is asked for on an agent nobody has, and before
  // anything is allocated for it — no image pull, no network, no container.
  const created = await orchestrator.app.inject({
    method: 'POST',
    url: '/api/boxes',
    payload: { name: 'a box on nothing', thread: { harness: 'gemini' } },
  });
  assert.equal(created.statusCode, 400);
  assert.match((created.json() as { error: string }).error, /Unknown harness/);
});
