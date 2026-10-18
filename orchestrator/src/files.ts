/**
 * The client side of the file service in a box, `boxes-files`.
 *
 * The orchestrator reads and writes the files of a box through this service. The
 * service runs in the box as the agent, and speaks HTTP/2 over the standard input and
 * output of its exec. The agent can replace it, so the client checks every reply
 * before it uses it, and the client applies the caps.
 */

import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  connect,
  constants,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http2';
import { Duplex, PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  BINARY_HEADER,
  type DirChild,
  FILE_ROUTES,
  FILES_COMMAND,
  FILES_PROTOCOL_VERSION,
  type FindReposRequest,
  MAX_DIR_ENTRIES,
  SIZE_HEADER,
  type StatReply,
  TRUNCATED_HEADER,
  VERSION_HEADER,
  validRelativePath,
} from '../../shared/files.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import { RUN_TIMEOUT_MS, runtime } from './runtime/runtime.ts';

/** How long a request may wait for its reply, or for its next bytes, in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long the walk for the disk usage may take, in milliseconds. It matches a short command in the box. */
const SIZE_TIMEOUT_MS = RUN_TIMEOUT_MS;

/** The most bytes of a JSON reply. A full directory listing fits. */
const MAX_JSON_REPLY = 4 * 1024 * 1024;

/** The most bytes of an error reply. */
const MAX_ERROR_REPLY = 64 * 1024;

/** The exit codes of an exec whose command is not in the image. */
export const NOT_IN_IMAGE = new Set([126, 127]);

/** How long a lost connection waits for the exit code of the file service, in milliseconds. */
const EXIT_WAIT_MS = 2_000;

/** A reply of the file service that is not a success. */
export class FileServiceError extends Error {
  /**
   * @param status The HTTP status of the reply.
   * @param message The error message.
   */
  constructor(
    /** The HTTP status of the reply. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FileServiceError';
  }
}

/**
 * An error for a box that runs an image without the current file service or
 * setup. The box needs a restart on the current image.
 */
export class OutdatedImageError extends HttpError {
  /**
   * @param message The error message, which tells the user to restart the box on the current image.
   */
  constructor(message: string) {
    super(409, message);
    this.name = 'OutdatedImageError';
  }
}

/** The connection to the file service ended before the reply arrived. */
class ConnectionLost extends Error {
  constructor() {
    super('the connection to the file service ended');
    this.name = 'ConnectionLost';
  }
}

/** A request that got no reply, or no further bytes, in time. */
class TimedOut extends Error {
  constructor() {
    super('the file service did not answer in time');
    this.name = 'TimedOut';
  }
}

/**
 * Checks if an error is the file service reporting that a path does not exist.
 *
 * @param err The error.
 * @returns True for a FileServiceError with status 404.
 */
export function isMissing(err: unknown): boolean {
  return err instanceof FileServiceError && err.status === 404;
}

/**
 * Checks if an error is the file service refusing a path because it
 * is malformed, outside the workspace, a link, or missing.
 *
 * @param err The error.
 * @returns True for a FileServiceError with status 400, 403 or 404.
 */
export function isRefusedPath(err: unknown): boolean {
  return err instanceof FileServiceError && [400, 403, 404].includes(err.status);
}

/** A running file service: a byte stream to it, and how it ends. */
export interface FileServiceProcess {
  /** Its standard output as the readable side, its standard input as the writable side. */
  io: Duplex;
  /** Resolves with the exit code when the process has ended, or null when it is unknown. */
  exited: Promise<number | null>;
  /** Ends the process. */
  kill(): void;
}

/**
 * A function that starts the file service in a box. Tests replace the
 * default with one that needs no runtime.
 *
 * @param boxId The id of the box.
 * @returns The running file service.
 */
export type FileServiceSpawner = (boxId: string) => Promise<FileServiceProcess>;

/**
 * The spawner this module ships with: one exec in the box, as the agent.
 *
 * The file service starts before the box setup writes the CA bundle that
 * NODE_EXTRA_CA_CERTS names, and Node warns about a missing file. The file
 * service makes no TLS connections, so the spawner empties the variable, which makes
 * Node skip it.
 *
 * @param boxId The id of the box.
 * @returns The running file service.
 */
const inBoxContainer: FileServiceSpawner = async (boxId) => {
  const exec = await runtime().spawn(boxId, [FILES_COMMAND], { env: { NODE_EXTRA_CA_CERTS: '' } });
  exec.stderr.on('data', (chunk: Buffer) => {
    log.box(boxId).warn('file service', { stderr: chunk.toString('utf8').trim() });
  });
  // Node accepts a pair of Node streams here. Its type declarations know only
  // the web stream pair.
  const io = Duplex.from({
    readable: exec.stdout,
    writable: exec.stdin,
  } as unknown as Parameters<typeof Duplex.from>[0]);
  return { io, exited: exec.exited, kill: exec.kill };
};

/** The spawner in use. Only tests replace it. */
let spawner: FileServiceSpawner = inBoxContainer;

/**
 * Replaces the spawner of the file service, and closes the open file services.
 *
 * @param next The new spawner, or null to put the shipped one back.
 */
export function setFileServiceSpawnerForTests(next: FileServiceSpawner | null): void {
  spawner = next ?? inBoxContainer;
  for (const service of services.values()) service.close();
  services.clear();
}

/** The file service of each box, by box id. */
const services = new Map<string, FileService>();

/**
 * Returns the file service of a running box.
 *
 * The first request starts it, and it stays for the next requests. After the
 * connection ended, for example because the box stopped, the next request
 * starts it again.
 *
 * @param boxId The id of the box.
 * @returns The file service of the box.
 */
export function fileService(boxId: string): FileService {
  let service = services.get(boxId);
  if (!service) {
    service = new FileService(boxId);
    services.set(boxId, service);
  }
  return service;
}

/** One reply: its status, its headers and its body. */
interface Reply {
  /** The HTTP status. */
  status: number;
  /** The response headers. */
  headers: IncomingHttpHeaders;
  /** The HTTP/2 stream of the request. */
  stream: ClientHttp2Stream;
  /**
   * The body. It fails with ConnectionLost when the stream closes before
   * its end, and with TimedOut when the stream waits too long.
   */
  body: PassThrough;
}

/** One request to the file service. */
interface Request {
  /** The HTTP method. */
  method: string;
  /** The path of the route, without the query. */
  route: string;
  /** The query parameters. */
  query?: Record<string, string>;
  /** Extra request headers. */
  headers?: OutgoingHttpHeaders;
  /** The body. A stream is piped, so it is never held in memory as a whole. */
  body?: string | Buffer | Readable;
  /** The timeout in milliseconds. REQUEST_TIMEOUT_MS applies when it is absent. */
  timeoutMs?: number;
}

/** A read of one file. */
export interface FileRead {
  /** The text read, up to the cap. Empty for a binary file. */
  content: string;
  /** True when the file was longer than the cap and the rest was dropped. */
  truncated: boolean;
  /** True when the file holds a NUL byte before the cap. */
  binary: boolean;
  /** The file's real size in bytes. */
  size: number;
  /** The hash of the file, which a write expects back. */
  hash: string;
}

/** The whole content of one file, as a stream. */
export interface FileStream {
  /** The size in bytes, as the file service reported it. */
  size: number;
  /** The content. */
  stream: Readable;
}

/** What a write expects of the file it replaces: its hash, or that there is none. */
export type WriteCondition = { hash: string } | { absent: true };

/** One plain path component: no separator, and not `.` or `..`. */
const component = z
  .string()
  .max(4096)
  .refine((name) => validRelativePath(name) && !/[/\\]/.test(name) && name !== '.');

/** The shape of a directory listing. */
const listReply = z.object({
  entries: z.array(z.object({ name: component, isDir: z.boolean() })).max(MAX_DIR_ENTRIES),
  truncated: z.boolean(),
});

/** The shape of a repository walk. */
const findReposReply = z.object({ paths: z.array(z.string().max(4096)) });

/** The shape of a stat. */
const statReply = z.object({
  type: z.enum(['file', 'dir', 'other']),
  size: z.number().int().nonnegative(),
});

/** The shape of a create. */
const createReply = z.object({ name: component });

/** The shape of a size. */
const sizeReply = z.object({ bytes: z.number().int().nonnegative() });

/** The file service of one box, and its connection while it lasts. */
export class FileService {
  /** The connection, while it is open. */
  private session: ClientHttp2Session | null = null;
  /** The connection being made, so two requests at once make one. */
  private connecting: Promise<ClientHttp2Session> | null = null;
  /** The process of the last connection. */
  private process: FileServiceProcess | null = null;

  /**
   * @param boxId The id of the box that the file service runs in.
   */
  constructor(
    /** The box the file service runs in. */
    private readonly boxId: string,
  ) {}

  /**
   * Returns the plain files and directories in one directory of the workspace.
   *
   * @param relDir The directory, relative to the workspace.
   * @returns The entries, and true in truncated when the service left entries out.
   */
  async list(relDir: string): Promise<{ entries: DirChild[]; truncated: boolean }> {
    return this.retried(async () =>
      this.json(
        await this.send({ method: 'GET', route: FILE_ROUTES.list, query: { path: relDir } }),
        listReply,
      ),
    );
  }

  /**
   * Returns the directories of the workspace that hold a `.git`, breadth first.
   *
   * @param limits The limits of the walk.
   * @returns The paths relative to the workspace, with the empty string for the workspace itself.
   */
  async findRepos(limits: FindReposRequest): Promise<string[]> {
    const reply = await this.retried(async () =>
      this.json(
        await this.send({
          method: 'POST',
          route: FILE_ROUTES.findRepos,
          body: JSON.stringify(limits),
        }),
        findReposReply,
      ),
    );
    return reply.paths
      .filter((path) => path === '' || validRelativePath(path))
      .slice(0, limits.maxRepos);
  }

  /**
   * Returns the type and the size of one path of the workspace.
   *
   * @param relPath The path, relative to the workspace.
   * @returns The type and the size.
   */
  async stat(relPath: string): Promise<StatReply> {
    return this.retried(async () =>
      this.json(
        await this.send({ method: 'GET', route: FILE_ROUTES.stat, query: { path: relPath } }),
        statReply,
      ),
    );
  }

  /**
   * Reads one file of the workspace, up to `cap` bytes.
   *
   * @param relPath The path, relative to the workspace.
   * @param cap The most bytes to read.
   * @returns The read.
   * @throws Error when the service sends more than `cap` bytes, or no size or hash.
   */
  async read(relPath: string, cap: number): Promise<FileRead> {
    return this.retried(async () => {
      const reply = await this.send({
        method: 'GET',
        route: FILE_ROUTES.read,
        query: { path: relPath, cap: String(cap) },
      });
      if (reply.status !== 200) await this.fail(reply);
      const body = await this.body(reply, cap);
      const size = Number(reply.headers[SIZE_HEADER]);
      const hash = reply.headers.etag;
      if (!Number.isSafeInteger(size) || size < 0 || typeof hash !== 'string') {
        throw new Error('the file service sent a read without its size or hash');
      }
      return {
        content: body.toString('utf8'),
        truncated: reply.headers[TRUNCATED_HEADER] === '1',
        binary: reply.headers[BINARY_HEADER] === '1',
        size,
        hash,
      };
    });
  }

  /**
   * Returns the whole content of one file of the workspace, as a stream. The stream
   * has no cap and no timeout, because the caller pipes it to a reader that
   * sets the pace.
   *
   * @param relPath The path, relative to the workspace.
   * @returns The size and the content.
   * @throws Error when the service sends no length.
   */
  async readStream(relPath: string): Promise<FileStream> {
    return this.retried(async () => {
      const reply = await this.send({
        method: 'GET',
        route: FILE_ROUTES.raw,
        query: { path: relPath },
      });
      if (reply.status !== 200) await this.fail(reply);
      const size = Number(reply.headers['content-length']);
      if (!Number.isSafeInteger(size) || size < 0) {
        reply.body.destroy();
        throw new Error('the file service sent a file without its length');
      }
      reply.stream.setTimeout(0);
      return { size, stream: reply.body };
    });
  }

  /**
   * Replaces one file of the workspace atomically.
   *
   * A write is not retried. When the first attempt arrived, a retry finds a
   * changed hash and reports a conflict that is not real.
   *
   * @param relPath The path, relative to the workspace.
   * @param content The new content.
   * @param condition The hash that the old file must have, or that there must be no file.
   * @returns The new hash, or the empty string when the service sends none.
   * @throws FileServiceError with status 412 when the file does not meet the condition.
   */
  async write(
    relPath: string,
    content: string | Buffer,
    condition: WriteCondition,
  ): Promise<string> {
    const reply = await this.send({
      method: 'PUT',
      route: FILE_ROUTES.file,
      query: { path: relPath },
      headers: 'absent' in condition ? { 'if-none-match': '*' } : { 'if-match': condition.hash },
      body: content,
    });
    if (reply.status !== 204) await this.fail(reply);
    reply.body.resume();
    const hash = reply.headers.etag;
    return typeof hash === 'string' ? hash : '';
  }

  /**
   * Removes one file of the workspace.
   *
   * @param relPath The path, relative to the workspace.
   * @throws FileServiceError with status 404 when the file is missing.
   */
  async remove(relPath: string): Promise<void> {
    await this.empty(
      await this.send({ method: 'DELETE', route: FILE_ROUTES.file, query: { path: relPath } }),
    );
  }

  /**
   * Creates one directory of the workspace, or accepts one that is there.
   *
   * @param relPath The path, relative to the workspace.
   */
  async mkdir(relPath: string): Promise<void> {
    await this.empty(
      await this.send({ method: 'POST', route: FILE_ROUTES.mkdir, query: { path: relPath } }),
    );
  }

  /**
   * Writes bytes under the first free name in a directory of the workspace.
   *
   * @param relDir The directory, relative to the workspace.
   * @param name The name to try first.
   * @param bytes The content.
   * @returns The name used.
   */
  async create(relDir: string, name: string, bytes: Buffer): Promise<string> {
    const reply = await this.json(
      await this.send({
        method: 'POST',
        route: FILE_ROUTES.create,
        query: { path: relDir, name },
        body: bytes,
      }),
      createReply,
    );
    return reply.name;
  }

  /**
   * Writes the setup files of the orchestrator into the home.
   *
   * @param tar The files, as a tar stream of files relative to the home.
   */
  async installSetupFiles(tar: Readable): Promise<void> {
    await this.empty(await this.send({ method: 'POST', route: FILE_ROUTES.setupFiles, body: tar }));
  }

  /**
   * Installs an agent set into the home, and removes what the last install put there.
   *
   * @param tar The agent set, as a tar stream of files relative to the home.
   */
  async installAgentSet(tar: Readable): Promise<void> {
    await this.empty(await this.send({ method: 'POST', route: FILE_ROUTES.agentSet, body: tar }));
  }

  /**
   * Returns the apparent size of the workspace, the home and the Nix store.
   *
   * @returns The size in bytes.
   */
  async size(): Promise<number> {
    const reply = await this.send({
      method: 'GET',
      route: FILE_ROUTES.size,
      timeoutMs: SIZE_TIMEOUT_MS,
    });
    return (await this.json(reply, sizeReply)).bytes;
  }

  /** Closes the connection. The next request opens a new one. */
  close(): void {
    this.session?.close();
    this.process?.kill();
  }

  /**
   * Runs a request that only reads, and runs it again when the connection ended during it.
   *
   * @param fn The request.
   * @returns The result of the request.
   */
  private async retried<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ConnectionLost)) throw err;
      return fn();
    }
  }

  /**
   * Returns the open connection, or a new one.
   *
   * @returns The HTTP/2 session.
   */
  private async connection(): Promise<ClientHttp2Session> {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Starts the file service and connects to it.
   *
   * @returns The HTTP/2 session.
   */
  private async open(): Promise<ClientHttp2Session> {
    const spawned = await spawner(this.boxId);
    const session = connect('http://boxes-files', { createConnection: () => spawned.io });
    session.on('error', (err: Error) => {
      log.box(this.boxId).debug('file service connection failed', { error: err.message });
    });
    session.on('close', () => {
      spawned.kill();
      if (this.session === session) this.session = null;
      if (services.get(this.boxId) === this) services.delete(this.boxId);
    });
    this.session = session;
    this.process = spawned;
    return session;
  }

  /**
   * Sends one request and waits for the head of its reply.
   *
   * @param req The request.
   * @returns The reply.
   * @throws OutdatedImageError when the reply has another protocol version, or the image has no file service.
   * @throws ConnectionLost when the connection ends before the reply.
   * @throws TimedOut when the reply does not arrive in time.
   */
  private async send(req: Request): Promise<Reply> {
    const session = await this.connection();
    const query = req.query ? `?${new URLSearchParams(req.query).toString()}` : '';
    let reply: Reply;
    try {
      reply = await new Promise<Reply>((resolve, reject) => {
        const stream = session.request({
          ':method': req.method,
          ':path': `${req.route}${query}`,
          ...req.headers,
        });
        stream.setTimeout(req.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
          stream.destroy(new TimedOut());
        });
        stream.on('response', (headers) => {
          resolve({ status: Number(headers[':status']), headers, stream, body: bodyOf(stream) });
        });
        stream.on('error', (err) => reject(err instanceof TimedOut ? err : new ConnectionLost()));
        stream.on('close', () => reject(new ConnectionLost()));
        if (req.body instanceof Readable) {
          pipeline(req.body, stream).catch(() => {});
        } else {
          stream.end(req.body);
        }
      });
    } catch (err) {
      if (err instanceof ConnectionLost) await this.refuseMissingCommand();
      throw err;
    }

    const version = reply.headers[VERSION_HEADER];
    if (version !== String(FILES_PROTOCOL_VERSION)) {
      reply.body.destroy();
      throw versionError(typeof version === 'string' ? version : 'unknown');
    }
    return reply;
  }

  /**
   * Throws the version error when the file service could not start because
   * the box image does not have it. The exit code comes a moment after the
   * connection ended, so the method waits a short time for it.
   *
   * @throws OutdatedImageError when the exit code shows that the image has no file service.
   */
  private async refuseMissingCommand(): Promise<void> {
    if (!this.process) return;
    const code = await Promise.race([
      this.process.exited,
      delay(EXIT_WAIT_MS, undefined, { ref: false }),
    ]);
    if (code !== undefined && code !== null && NOT_IN_IMAGE.has(code)) throw versionError('none');
  }

  /**
   * Returns the body of a reply.
   *
   * @param reply The reply.
   * @param cap The most bytes of the body.
   * @returns The body.
   * @throws Error when the body is longer than `cap` bytes.
   */
  private async body(reply: Reply, cap: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of reply.body) {
      size += (chunk as Buffer).length;
      if (size > cap) {
        reply.body.destroy();
        throw new Error('the file service sent more than was asked for');
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Returns the JSON body of a reply, checked against its shape.
   *
   * @param reply The reply.
   * @param schema The shape of the body.
   * @returns The parsed body.
   * @throws FileServiceError when the status is not 200 or 201.
   * @throws Error when the body does not match the shape.
   */
  private async json<S extends z.ZodTypeAny>(reply: Reply, schema: S): Promise<z.infer<S>> {
    if (reply.status !== 200 && reply.status !== 201) await this.fail(reply);
    const body = await this.body(reply, MAX_JSON_REPLY);
    const parsed = schema.safeParse(JSON.parse(body.toString('utf8')));
    if (!parsed.success) throw new Error('the file service sent a reply of the wrong shape');
    return parsed.data;
  }

  /**
   * Accepts a reply without a body.
   *
   * @param reply The reply.
   * @throws FileServiceError when the status is not 204.
   */
  private async empty(reply: Reply): Promise<void> {
    if (reply.status !== 204) await this.fail(reply);
    reply.body.resume();
  }

  /**
   * Throws the error that a reply reports.
   *
   * @param reply The reply.
   * @throws FileServiceError always, with the status and the error text of the reply.
   */
  private async fail(reply: Reply): Promise<never> {
    let message = `the file service answered ${reply.status}`;
    try {
      const body = await this.body(reply, MAX_ERROR_REPLY);
      const error = (JSON.parse(body.toString('utf8')) as { error?: unknown }).error;
      if (typeof error === 'string') message = `${message}: ${error.slice(0, 500)}`;
    } catch {
      // the status alone says enough
    }
    throw new FileServiceError(reply.status, message);
  }
}

/**
 * Returns the body of a reply stream, as a stream of its own.
 *
 * It is attached as the reply arrives. A reader that comes later would miss
 * the end of a short body, and an async iterator reports a stream that closed
 * before it was read as closed too early, even with its whole body buffered.
 * A stream that closes before its end fails the body, so a cut body is not
 * read as a short one. A reader that stops early cancels the stream.
 *
 * @param stream The HTTP/2 stream of the request.
 * @returns The body.
 */
function bodyOf(stream: ClientHttp2Stream): PassThrough {
  const body = new PassThrough();
  let ended = false;
  stream.on('end', () => {
    ended = true;
  });
  stream.on('error', (err) => body.destroy(err instanceof TimedOut ? err : new ConnectionLost()));
  stream.on('close', () => {
    if (!ended) body.destroy(new ConnectionLost());
  });
  body.on('close', () => {
    if (!ended) stream.close(constants.NGHTTP2_CANCEL);
  });
  stream.pipe(body);
  return body;
}

/**
 * Returns the error for a file service that speaks another version of the protocol,
 * or for an image that has none.
 *
 * @param found The version that the file service reported, or a word for no version.
 * @returns The error.
 */
function versionError(found: string): OutdatedImageError {
  return new OutdatedImageError(
    `This box has file service version ${found}, but the orchestrator needs version ` +
      `${FILES_PROTOCOL_VERSION}. The box needs an image with the current file service.`,
  );
}
