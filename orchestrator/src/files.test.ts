import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair, PassThrough, Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, test } from 'vitest';
import { FILES_PROTOCOL_VERSION, VERSION_HEADER } from '../../shared/files.ts';
import {
  FileServiceError,
  type FileServiceSpawner,
  fileService,
  setFileServiceSpawnerForTests,
} from './files.ts';
import { inProcessFileService } from './files-in-process.ts';
import { HttpError } from './http-error.ts';

/** The temporary workspace of the current test. */
let workspace: string;

/** The real file service on the test workspace. */
let real: FileServiceSpawner;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'boxes-files-client-'));
  real = inProcessFileService(() => ({ workspace, home: workspace, nix: workspace }));
});

afterEach(() => {
  setFileServiceSpawnerForTests(null);
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Returns a tar stream with one file.
 *
 * @param name The path of the file, relative to the home.
 * @param content The content of the file.
 * @returns The tar stream.
 */
function tarOf(name: string, content: string): Readable {
  const p = pack();
  p.entry({ name, size: content.length }, content);
  p.finalize();
  return Readable.from(p);
}

/**
 * Returns a spawner of a fake file service.
 *
 * @param answer The handler that answers every request.
 * @returns The spawner.
 */
function fake(
  answer: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void,
): FileServiceSpawner {
  return async () => {
    const [server, client] = duplexPair();
    const h2 = createServer();
    h2.on('stream', answer);
    h2.emit('connection', server);
    return { io: client, exited: new Promise(() => {}), kill: () => client.destroy() };
  };
}

/**
 * Returns the response headers with the current protocol version added.
 *
 * @param headers The response headers.
 * @returns The headers with the version header.
 */
function current(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  return { ...headers, [VERSION_HEADER]: String(FILES_PROTOCOL_VERSION) };
}

/**
 * Returns a spawner that counts its spawns.
 *
 * @param first The spawner for the first spawn.
 * @param then The spawner for every later spawn.
 * @returns The counter and the spawner.
 */
function counted(first: FileServiceSpawner, then: FileServiceSpawner) {
  const counter = { spawns: 0 };
  const spawner: FileServiceSpawner = async (id) => {
    counter.spawns++;
    return counter.spawns === 1 ? first(id) : then(id);
  };
  return { counter, spawner };
}

/** A file service whose connection ends at the first request. */
const dropping: FileServiceSpawner = async () => {
  const [server, client] = duplexPair();
  const h2 = createServer();
  h2.on('stream', () => server.end());
  h2.emit('connection', server);
  return { io: client, exited: Promise.resolve(null), kill: () => client.destroy() };
};

test('one connection serves every request', async () => {
  writeFileSync(join(workspace, 'a.txt'), 'hello');
  const { counter, spawner } = counted(real, real);
  setFileServiceSpawnerForTests(spawner);
  const files = fileService('c1');
  assert.equal((await files.read('a.txt', 100)).content, 'hello');
  assert.equal((await files.stat('a.txt')).size, 5);
  assert.equal(counter.spawns, 1);
});

test('a read is tried once more when the connection ended during it', async () => {
  writeFileSync(join(workspace, 'a.txt'), 'hello');
  const { counter, spawner } = counted(dropping, real);
  setFileServiceSpawnerForTests(spawner);
  assert.equal((await fileService('c1').read('a.txt', 100)).content, 'hello');
  assert.equal(counter.spawns, 2);
});

test('a write is not tried again', async () => {
  const { counter, spawner } = counted(dropping, real);
  setFileServiceSpawnerForTests(spawner);
  await assert.rejects(fileService('c1').write('a.txt', 'x', { absent: true }));
  assert.equal(counter.spawns, 1);
});

test('a refusal of the file service comes back with its status', async () => {
  setFileServiceSpawnerForTests(real);
  await assert.rejects(fileService('c1').stat('nope'), (err: unknown) => {
    assert.ok(err instanceof FileServiceError);
    assert.equal(err.status, 404);
    return true;
  });
});

test('a file service of another version is refused, naming both versions', async () => {
  setFileServiceSpawnerForTests(
    fake((stream) => {
      stream.respond({ ':status': 200, [VERSION_HEADER]: '0' });
      stream.end('{}');
    }),
  );
  await assert.rejects(fileService('c1').list(''), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /version 0, but the orchestrator needs version 1/);
    return true;
  });
});

test('an image without the file service is refused as one of no version', async () => {
  setFileServiceSpawnerForTests(async () => {
    const io = new PassThrough();
    // The exec ends at once with code 127, as for a command that is not in the image.
    queueMicrotask(() => io.destroy());
    return { io, exited: Promise.resolve(127), kill: () => io.destroy() };
  });
  await assert.rejects(fileService('c1').list(''), /version none/);
});

test('an agent set is installed from a stream, and a refused entry reports its path', async () => {
  setFileServiceSpawnerForTests(real);
  await fileService('c1').installAgentSet(tarOf('.claude/CLAUDE.md', 'rules'));
  assert.equal(readFileSync(join(workspace, '.claude/CLAUDE.md'), 'utf8'), 'rules');

  await assert.rejects(fileService('c1').installAgentSet(tarOf('.bashrc', 'x')), (err: unknown) => {
    assert.ok(err instanceof FileServiceError);
    assert.equal(err.status, 400);
    assert.match(err.message, /\.bashrc/);
    return true;
  });
});

test('a read that sends more than its cap is refused', async () => {
  setFileServiceSpawnerForTests(
    fake((stream) => {
      stream.respond(current({ ':status': 200, etag: 'h', 'boxes-files-size': '10' }));
      stream.end('0123456789');
    }),
  );
  await assert.rejects(fileService('c1').read('a.txt', 4), /more than was asked for/);
});

test('a listing that names a path rather than a child is refused', async () => {
  setFileServiceSpawnerForTests(
    fake((stream) => {
      stream.respond(current({ ':status': 200, 'content-type': 'application/json' }));
      stream.end(JSON.stringify({ entries: [{ name: '../etc', isDir: true }], truncated: false }));
    }),
  );
  await assert.rejects(fileService('c1').list(''), /wrong shape/);
});

test('a download streams the whole file, with its size', async () => {
  const content = Buffer.alloc(1024 * 1024, 'x');
  writeFileSync(join(workspace, 'big.bin'), content);
  setFileServiceSpawnerForTests(real);
  const file = await fileService('c1').readStream('big.bin');
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(chunk as Buffer);
  assert.equal(file.size, content.length);
  assert.ok(Buffer.concat(chunks).equals(content));
});

test('an empty file reads as empty', async () => {
  writeFileSync(join(workspace, 'empty.txt'), '');
  setFileServiceSpawnerForTests(real);
  const read = await fileService('c1').read('empty.txt', 100);
  assert.equal(read.content, '');
  assert.equal(read.size, 0);
});
