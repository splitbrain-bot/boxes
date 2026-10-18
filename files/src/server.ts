import {
  constants,
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BINARY_HEADER,
  FILE_ROUTES,
  FILES_PROTOCOL_VERSION,
  type FindReposRequest,
  SIZE_HEADER,
  TRUNCATED_HEADER,
  VERSION_HEADER,
} from '../../shared/files.ts';
import { installAgentSet } from './agentset.ts';
import {
  createUnderFreeName,
  FileError,
  findRepos,
  listDir,
  makeDir,
  openRaw,
  readFile,
  removeFile,
  statPath,
  totalSize,
  type WriteCondition,
  writeFile,
} from './ops.ts';
import { installSetupFiles } from './setupfiles.ts';

/** The directories the file service works on. */
export interface Roots {
  /** The workspace. Every path in a request is relative to it. */
  workspace: string;
  /** The home of the agent. The size covers it, and the setup files and the agent set go into it. */
  home: string;
  /** The Nix directory. Only the size covers it. */
  nix: string;
  /** The directory with the skills of the box image, or undefined for none. Each agent set install copies them. */
  imageSkills?: string;
}

/** The maximum size of a JSON request body, in bytes. */
const MAX_JSON_BODY = 64 * 1024;

/**
 * Serves the file operations over one connection. The server accepts no other connection.
 *
 * @param io The connection, any byte stream, for example the standard input and output of the process.
 * @param roots The directories of the operations.
 * @returns The server.
 */
export function serveFiles(io: Duplex, roots: Roots): Http2Server {
  const server = createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    // When the orchestrator cancels a request, it resets the stream. The operation then fails, and the stream error
    // must not end the process.
    stream.on('error', () => {});
    handle(stream, headers, roots).catch((err: unknown) => {
      const status = err instanceof FileError ? err.status : 500;
      reply(stream, status, { error: (err as Error).message });
    });
  });
  server.emit('connection', io);
  return server;
}

/**
 * Answers one request.
 *
 * @param stream The stream of the request.
 * @param headers The request headers.
 * @param roots The directories of the operations.
 * @throws {FileError} A 400 for an invalid cap, a 404 for an unknown operation, and the refusal of the operation.
 */
async function handle(
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  roots: Roots,
): Promise<void> {
  const method = headers[constants.HTTP2_HEADER_METHOD];
  const url = new URL(String(headers[constants.HTTP2_HEADER_PATH] ?? '/'), 'http://boxes-files');
  const path = url.searchParams.get('path') ?? '';
  const route = `${method} ${url.pathname}`;

  switch (route) {
    case `GET ${FILE_ROUTES.list}`:
      return reply(stream, 200, listDir(roots.workspace, path));

    case `POST ${FILE_ROUTES.findRepos}`:
      return reply(stream, 200, findRepos(roots.workspace, await findReposBody(stream)));

    case `GET ${FILE_ROUTES.stat}`:
      return reply(stream, 200, statPath(roots.workspace, path));

    case `GET ${FILE_ROUTES.read}`: {
      const cap = Number(url.searchParams.get('cap'));
      if (!Number.isSafeInteger(cap) || cap < 0) throw new FileError(400, 'invalid cap');
      const read = readFile(roots.workspace, path, cap);
      stream.respond(
        withVersion({
          ':status': 200,
          'content-type': 'application/octet-stream',
          etag: read.hash,
          [SIZE_HEADER]: String(read.size),
          [TRUNCATED_HEADER]: read.truncated ? '1' : '0',
          [BINARY_HEADER]: read.binary ? '1' : '0',
        }),
      );
      stream.end(read.content);
      return;
    }

    case `GET ${FILE_ROUTES.raw}`: {
      const raw = openRaw(roots.workspace, path);
      stream.respond(
        withVersion({
          ':status': 200,
          'content-type': 'application/octet-stream',
          'content-length': String(raw.size),
        }),
      );
      await pipeline(raw.stream, stream).catch(() => raw.stream.destroy());
      return;
    }

    case `PUT ${FILE_ROUTES.file}`: {
      const hash = await writeFile(roots.workspace, path, stream, writeCondition(headers));
      return reply(stream, 204, null, { etag: hash });
    }

    case `DELETE ${FILE_ROUTES.file}`:
      removeFile(roots.workspace, path);
      return reply(stream, 204, null);

    case `POST ${FILE_ROUTES.mkdir}`:
      makeDir(roots.workspace, path);
      return reply(stream, 204, null);

    case `POST ${FILE_ROUTES.create}`: {
      const name = url.searchParams.get('name') ?? '';
      return reply(stream, 201, {
        name: await createUnderFreeName(roots.workspace, path, name, stream),
      });
    }

    case `GET ${FILE_ROUTES.size}`:
      return reply(stream, 200, {
        bytes: await totalSize([roots.workspace, roots.home, roots.nix]),
      });

    case `POST ${FILE_ROUTES.setupFiles}`:
      await installSetupFiles(roots.home, stream);
      return reply(stream, 204, null);

    case `POST ${FILE_ROUTES.agentSet}`:
      await installAgentSet(roots.home, roots.imageSkills, stream);
      return reply(stream, 204, null);

    default:
      throw new FileError(404, `unknown operation: ${route}`);
  }
}

/**
 * Reads the condition of a write from its `If-Match` or `If-None-Match` header.
 *
 * @param headers The request headers.
 * @returns The condition.
 * @throws {FileError} A 428 when the request has no condition.
 */
function writeCondition(headers: IncomingHttpHeaders): WriteCondition {
  if (headers['if-none-match'] === '*') return { absent: true };
  const hash = headers['if-match'];
  if (typeof hash !== 'string' || hash === '') {
    throw new FileError(428, 'a write needs If-Match or If-None-Match: *');
  }
  return { hash };
}

/**
 * Reads and checks the limits of a repository walk from the request body.
 *
 * @param stream The stream of the request.
 * @returns The limits.
 * @throws {FileError} A 413 when the body is too large, and a 400 when the body is not valid limits.
 */
async function findReposBody(stream: ServerHttp2Stream): Promise<FindReposRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY) throw new FileError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new FileError(400, 'invalid JSON');
  }
  const b = body as Partial<FindReposRequest> | null;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (
    !b ||
    !count(b.maxDepth) ||
    !count(b.maxScanned) ||
    !count(b.maxRepos) ||
    !Array.isArray(b.pruned) ||
    !b.pruned.every((name) => typeof name === 'string')
  ) {
    throw new FileError(400, 'invalid limits');
  }
  return b as FindReposRequest;
}

/**
 * Adds the protocol version to response headers.
 *
 * @param headers The response headers.
 * @returns A copy of the headers with the protocol version.
 */
function withVersion(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  return { ...headers, [VERSION_HEADER]: String(FILES_PROTOCOL_VERSION) };
}

/**
 * Sends a complete reply. A closed stream gets nothing. When the stream has already sent its headers, the function
 * resets the stream.
 *
 * @param stream The stream of the request.
 * @param status The HTTP status.
 * @param body The JSON body, or null for no body.
 * @param headers More response headers.
 */
function reply(
  stream: ServerHttp2Stream,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  if (stream.destroyed || stream.closed) return;
  if (stream.headersSent) {
    stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    return;
  }
  if (body === null) {
    stream.respond(withVersion({ ':status': status, ...headers }), { endStream: true });
    return;
  }
  stream.respond(
    withVersion({ ':status': status, 'content-type': 'application/json', ...headers }),
  );
  stream.end(JSON.stringify(body));
}
