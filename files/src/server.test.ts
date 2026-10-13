import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, duplexPair } from 'node:stream';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, test } from 'vitest';
import {
  FILE_ROUTES,
  FILES_PROTOCOL_VERSION,
  HASH_BYTES,
  MAX_DIR_ENTRIES,
  VERSION_HEADER,
} from '../../shared/files.ts';
import { serveFiles } from './server.ts';

let dir: string;
let workspace: string;
let session: ClientHttp2Session;

/** A reply, with its body as bytes. */
interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Sends one request over the test session and collects the reply. */
function request(
  method: string,
  path: string,
  body?: string | Buffer,
  headers: OutgoingHttpHeaders = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':method': method, ':path': path, ...headers });
    const chunks: Buffer[] = [];
    let status = 0;
    let replyHeaders: Reply['headers'] = {};
    stream.on('response', (h) => {
      status = Number(h[':status']);
      replyHeaders = h;
    });
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve({ status, headers: replyHeaders, body: Buffer.concat(chunks) }));
    stream.on('error', reject);
    stream.end(body);
  });
}

/** The JSON body of a reply. */
function json(reply: Reply): unknown {
  return JSON.parse(reply.body.toString('utf8'));
}

/** A request path with a `path` query and any further query values. */
function at(route: string, path: string, extra: Record<string, string> = {}): string {
  return `${route}?${new URLSearchParams({ path, ...extra }).toString()}`;
}

/** Writes a file under the workspace, creating the directories above it. */
function put(rel: string, content: string | Buffer): void {
  const full = join(workspace, rel);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-files-'));
  workspace = join(dir, 'workspace');
  for (const d of ['workspace', 'home', 'nix']) mkdirSync(join(dir, d));
  const [server, client] = duplexPair();
  serveFiles(server, { workspace, home: join(dir, 'home'), nix: join(dir, 'nix') });
  session = connect('http://boxes-files', { createConnection: () => client });
});

afterEach(() => {
  session.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('every reply', () => {
  test('carries the protocol version, an error too', async () => {
    const ok = await request('GET', at(FILE_ROUTES.list, ''));
    assert.equal(ok.headers[VERSION_HEADER], String(FILES_PROTOCOL_VERSION));
    const missing = await request('GET', at(FILE_ROUTES.stat, 'nope'));
    assert.equal(missing.status, 404);
    assert.equal(missing.headers[VERSION_HEADER], String(FILES_PROTOCOL_VERSION));
  });

  test('an unknown operation is a 404', async () => {
    assert.equal((await request('GET', '/nothing')).status, 404);
  });
});

describe('paths', () => {
  test('a malformed path is a 400', async () => {
    assert.equal((await request('GET', at(FILE_ROUTES.stat, '../etc/passwd'))).status, 400);
    assert.equal((await request('GET', at(FILE_ROUTES.stat, '/etc/passwd'))).status, 400);
  });

  test('a link out of the workspace is a 403', async () => {
    writeFileSync(join(dir, 'secret'), 'x');
    symlinkSync(dir, join(workspace, 'out'));
    symlinkSync(join(dir, 'secret'), join(workspace, 'link'));
    assert.equal((await request('GET', at(FILE_ROUTES.read, 'out/secret', { cap: '10' }))).status, 403);
    assert.equal((await request('GET', at(FILE_ROUTES.read, 'link', { cap: '10' }))).status, 403);
    assert.equal((await request('GET', at(FILE_ROUTES.raw, 'link'))).status, 403);
  });
});

describe('list', () => {
  test('gives plain files and directories, and leaves out links', async () => {
    put('a.txt', 'a');
    mkdirSync(join(workspace, 'sub'));
    symlinkSync(join(workspace, 'a.txt'), join(workspace, 'l'));
    const reply = json(await request('GET', at(FILE_ROUTES.list, ''))) as {
      entries: Array<{ name: string; isDir: boolean }>;
      truncated: boolean;
    };
    const sorted = [...reply.entries].sort((x, y) => x.name.localeCompare(y.name));
    assert.deepEqual(sorted, [
      { name: 'a.txt', isDir: false },
      { name: 'sub', isDir: true },
    ]);
    assert.equal(reply.truncated, false);
  });

  test('stops at the cap and says so', async () => {
    mkdirSync(join(workspace, 'big'));
    for (let i = 0; i <= MAX_DIR_ENTRIES; i++) writeFileSync(join(workspace, 'big', `f${i}`), '');
    const reply = json(await request('GET', at(FILE_ROUTES.list, 'big'))) as {
      entries: unknown[];
      truncated: boolean;
    };
    assert.equal(reply.entries.length, MAX_DIR_ENTRIES);
    assert.equal(reply.truncated, true);
  });

  test('a missing directory is a 404', async () => {
    assert.equal((await request('GET', at(FILE_ROUTES.list, 'gone'))).status, 404);
  });
});

describe('find-repos', () => {
  test('finds directories with a .git, breadth first, and skips pruned names', async () => {
    mkdirSync(join(workspace, '.git'));
    mkdirSync(join(workspace, 'a/b/.git'), { recursive: true });
    put('wt/.git', 'gitdir: elsewhere\n');
    mkdirSync(join(workspace, 'node_modules/dep/.git'), { recursive: true });
    const limits = { maxDepth: 6, maxScanned: 100, maxRepos: 10, pruned: ['node_modules', '.git'] };
    const reply = json(await request('POST', FILE_ROUTES.findRepos, JSON.stringify(limits)));
    assert.deepEqual(reply, { paths: ['', 'wt', 'a/b'] });
  });

  test('stops at the depth', async () => {
    mkdirSync(join(workspace, 'a/b/.git'), { recursive: true });
    const limits = { maxDepth: 1, maxScanned: 100, maxRepos: 10, pruned: [] };
    const reply = json(await request('POST', FILE_ROUTES.findRepos, JSON.stringify(limits)));
    assert.deepEqual(reply, { paths: [] });
  });

  test('refuses limits of the wrong shape', async () => {
    const reply = await request('POST', FILE_ROUTES.findRepos, JSON.stringify({ maxDepth: -1 }));
    assert.equal(reply.status, 400);
  });
});

describe('stat', () => {
  test('gives the type and the size', async () => {
    put('a.txt', 'abc');
    assert.deepEqual(json(await request('GET', at(FILE_ROUTES.stat, 'a.txt'))), {
      type: 'file',
      size: 3,
    });
    mkdirSync(join(workspace, 'd'));
    assert.equal(
      (json(await request('GET', at(FILE_ROUTES.stat, 'd'))) as { type: string }).type,
      'dir',
    );
  });
});

describe('read', () => {
  test('gives the bytes, the size and a hash', async () => {
    put('a.txt', 'hello\n');
    const reply = await request('GET', at(FILE_ROUTES.read, 'a.txt', { cap: '100' }));
    assert.equal(reply.status, 200);
    assert.equal(reply.body.toString(), 'hello\n');
    assert.equal(reply.headers['boxes-files-size'], '6');
    assert.equal(reply.headers['boxes-files-truncated'], '0');
    assert.equal(reply.headers['boxes-files-binary'], '0');
    assert.match(String(reply.headers.etag), /^[0-9a-f]{32}$/);
  });

  test('stops at the cap', async () => {
    put('a.txt', 'abcdef');
    const reply = await request('GET', at(FILE_ROUTES.read, 'a.txt', { cap: '4' }));
    assert.equal(reply.body.toString(), 'abcd');
    assert.equal(reply.headers['boxes-files-truncated'], '1');
    assert.equal(reply.headers['boxes-files-size'], '6');
  });

  test('marks a file with a NUL byte as binary and sends no bytes', async () => {
    put('b.bin', Buffer.from([1, 0, 2]));
    const reply = await request('GET', at(FILE_ROUTES.read, 'b.bin', { cap: '100' }));
    assert.equal(reply.headers['boxes-files-binary'], '1');
    assert.equal(reply.body.length, 0);
  });

  test('hashes the same bytes the same at any cap, and ignores bytes past the hash limit', async () => {
    const big = Buffer.alloc(HASH_BYTES + 10, 'a');
    put('big.txt', big);
    const small = await request('GET', at(FILE_ROUTES.read, 'big.txt', { cap: '10' }));
    big[HASH_BYTES + 5] = 'b'.charCodeAt(0);
    put('big.txt', big);
    const large = await request('GET', at(FILE_ROUTES.read, 'big.txt', { cap: String(HASH_BYTES) }));
    assert.equal(small.headers.etag, large.headers.etag);
  });

  test('a directory is a 409', async () => {
    mkdirSync(join(workspace, 'd'));
    assert.equal((await request('GET', at(FILE_ROUTES.read, 'd', { cap: '10' }))).status, 409);
  });
});

describe('raw', () => {
  test('streams the whole file with its length', async () => {
    const content = Buffer.alloc(3 * 1024 * 1024, 'x');
    put('big.bin', content);
    const reply = await request('GET', at(FILE_ROUTES.raw, 'big.bin'));
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['content-length'], String(content.length));
    assert.ok(reply.body.equals(content));
  });

  test('a directory is a 404', async () => {
    mkdirSync(join(workspace, 'd'));
    assert.equal((await request('GET', at(FILE_ROUTES.raw, 'd'))).status, 404);
  });
});

describe('write', () => {
  /** The hash the service reports for a file now. */
  async function hashOf(rel: string): Promise<string> {
    return String((await request('GET', at(FILE_ROUTES.read, rel, { cap: '0' }))).headers.etag);
  }

  test('replaces a file whose hash matches, keeps its mode, and gives the new hash', async () => {
    put('run.sh', 'old');
    chmodSync(join(workspace, 'run.sh'), 0o755);
    const reply = await request('PUT', at(FILE_ROUTES.file, 'run.sh'), 'new', {
      'if-match': await hashOf('run.sh'),
    });
    assert.equal(reply.status, 204);
    assert.equal(readFileSync(join(workspace, 'run.sh'), 'utf8'), 'new');
    assert.equal(statSync(join(workspace, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(reply.headers.etag, await hashOf('run.sh'));
    assert.deepEqual(readdirSync(workspace), ['run.sh']);
  });

  test('refuses a file whose hash does not match, and leaves no temp file', async () => {
    put('a.txt', 'old');
    const reply = await request('PUT', at(FILE_ROUTES.file, 'a.txt'), 'new', { 'if-match': 'x' });
    assert.equal(reply.status, 412);
    assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'old');
    assert.deepEqual(readdirSync(workspace), ['a.txt']);
  });

  test('creates a file that must be absent, and refuses when it exists', async () => {
    const first = await request('PUT', at(FILE_ROUTES.file, 'n.txt'), 'one', { 'if-none-match': '*' });
    assert.equal(first.status, 204);
    const second = await request('PUT', at(FILE_ROUTES.file, 'n.txt'), 'two', { 'if-none-match': '*' });
    assert.equal(second.status, 412);
    assert.equal(readFileSync(join(workspace, 'n.txt'), 'utf8'), 'one');
    assert.deepEqual(readdirSync(workspace), ['n.txt']);
  });

  test('needs a condition', async () => {
    assert.equal((await request('PUT', at(FILE_ROUTES.file, 'a.txt'), 'x')).status, 428);
  });

  test('refuses a link and a directory', async () => {
    put('a.txt', 'a');
    symlinkSync(join(workspace, 'a.txt'), join(workspace, 'l'));
    mkdirSync(join(workspace, 'd'));
    const headers = { 'if-none-match': '*' };
    assert.equal((await request('PUT', at(FILE_ROUTES.file, 'l'), 'x', headers)).status, 403);
    assert.equal((await request('PUT', at(FILE_ROUTES.file, 'd'), 'x', headers)).status, 409);
  });
});

describe('remove', () => {
  test('removes a file, and a missing one is a 404', async () => {
    put('a.txt', 'a');
    assert.equal((await request('DELETE', at(FILE_ROUTES.file, 'a.txt'))).status, 204);
    assert.deepEqual(readdirSync(workspace), []);
    assert.equal((await request('DELETE', at(FILE_ROUTES.file, 'a.txt'))).status, 404);
  });
});

describe('mkdir', () => {
  test('creates one level, accepts one that is there, and refuses a file', async () => {
    assert.equal((await request('POST', at(FILE_ROUTES.mkdir, 'd'))).status, 204);
    assert.ok(statSync(join(workspace, 'd')).isDirectory());
    assert.equal((await request('POST', at(FILE_ROUTES.mkdir, 'd'))).status, 204);
    assert.equal((await request('POST', at(FILE_ROUTES.mkdir, 'x/y'))).status, 404);
    put('f', '');
    assert.equal((await request('POST', at(FILE_ROUTES.mkdir, 'f'))).status, 409);
  });

  test('refuses a link', async () => {
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(workspace, 'd'));
    assert.equal((await request('POST', at(FILE_ROUTES.mkdir, 'd'))).status, 403);
  });
});

describe('create', () => {
  test('writes under the first free name', async () => {
    mkdirSync(join(workspace, 'att'));
    const names: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const reply = await request('POST', at(FILE_ROUTES.create, 'att', { name: 'a.png' }), `n${i}`);
      assert.equal(reply.status, 201);
      names.push((json(reply) as { name: string }).name);
    }
    assert.deepEqual(names, ['a.png', 'a-2.png', 'a-3.png']);
    assert.equal(readFileSync(join(workspace, 'att', 'a-2.png'), 'utf8'), 'n1');
    assert.deepEqual(readdirSync(join(workspace, 'att')).sort(), ['a-2.png', 'a-3.png', 'a.png']);
  });

  test('refuses a name with a separator', async () => {
    mkdirSync(join(workspace, 'att'));
    const reply = await request('POST', at(FILE_ROUTES.create, 'att', { name: '../x' }), 'x');
    assert.equal(reply.status, 400);
  });
});

describe('size', () => {
  test('sums the files of the three roots and ignores links', async () => {
    put('a', 'abc');
    writeFileSync(join(dir, 'home', 'h'), 'hh');
    mkdirSync(join(dir, 'nix', 'store'));
    writeFileSync(join(dir, 'nix', 'store', 'n'), 'n');
    symlinkSync(join(dir, 'home', 'h'), join(workspace, 'l'));
    assert.deepEqual(json(await request('GET', FILE_ROUTES.size)), { bytes: 6 });
  });
});

describe('setup files', () => {
  test('writes the body into the home', async () => {
    const reply = await request('POST', FILE_ROUTES.setupFiles, await tarOf('.config/git/config', '[user]\n'));
    assert.equal(reply.status, 204);
    assert.equal(readFileSync(join(dir, 'home', '.config/git/config'), 'utf8'), '[user]\n');
  });
});

/** A tar with one file, relative to the home. */
function tarOf(name: string, content: string): Promise<Buffer> {
  const p = pack();
  p.entry({ name, size: content.length }, content);
  p.finalize();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    p.on('data', (c) => chunks.push(c as Buffer));
    p.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

describe('agent set', () => {
  test('installs the body into the home', async () => {
    const reply = await request('POST', FILE_ROUTES.agentSet, await tarOf('.claude/CLAUDE.md', 'rules'));
    assert.equal(reply.status, 204);
    assert.equal(readFileSync(join(dir, 'home', '.claude/CLAUDE.md'), 'utf8'), 'rules');
  });

  test('refuses an entry outside the layouts with a 400', async () => {
    const reply = await request('POST', FILE_ROUTES.agentSet, await tarOf('.bashrc', 'rm -rf /'));
    assert.equal(reply.status, 400);
    assert.equal(existsSync(join(dir, 'home', '.bashrc')), false);
  });
});

describe('the process', () => {
  test('serves over its standard input and output, and ends when they close', async () => {
    put('a.txt', 'hello');
    const child = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
      env: { ...process.env, BOXES_FILES_WORKSPACE: workspace },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const io = Duplex.from({ readable: child.stdout, writable: child.stdin } as never);
    session.destroy();
    session = connect('http://boxes-files', { createConnection: () => io });
    const reply = await request('GET', at(FILE_ROUTES.read, 'a.txt', { cap: '100' }));
    assert.equal(reply.body.toString(), 'hello');
    const exited = new Promise((resolve) => child.on('exit', resolve));
    session.close();
    child.stdin.end();
    assert.equal(await exited, 0);
  });
});
