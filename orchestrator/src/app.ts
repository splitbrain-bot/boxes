import compress from '@fastify/compress';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CredentialSummary,
  HarnessHealth,
  HarnessInfo,
  HealthResponse,
  LoginState,
  PushKeyResponse,
  ReadyResponse,
  ReviewAnnotationsResponse,
  Settings,
  StoredAttachment,
} from '../../shared/types.ts';
import { AgentStore } from './agents.ts';
import { ATTACHMENTS_DIR, servedTypeFor, storeAttachment } from './attachments.ts';
import {
  agentItemBody,
  backgroundStopBody,
  createAgentSetBody,
  createSessionBody,
  createThreadBody,
  loginCodeBody,
  parseBody,
  patchSettingsBody,
  pushSubscribeBody,
  pushUnsubscribeBody,
  putCredentialBody,
  reviewAnnotationBody,
  reviewBaseBody,
  reviewFileBody,
  threadDoneBody,
  updateAgentSetBody,
} from './bodies.ts';
import { CREDENTIAL_SET, type Config } from './config.ts';
import {
  CredentialStore,
  isCredentialId,
  undeliverableReason,
  type CredentialId,
} from './credentials.ts';
import {
  countLiveSessions,
  countPushSubscriptions,
  deletePushSubscription,
  readHarnessCatalog,
  upsertPushSubscription,
  type Db,
} from './db.ts';
import * as dk from './docker.ts';
import { EgressManager } from './egress.ts';
import { HARNESSES } from './harness.ts';
import { HttpError } from './http-error.ts';
import { deploymentImages } from './images.ts';
import { dockerLoginRuntime, LoginManager } from './login.ts';
import { log } from './log.ts';
import { Notifier } from './notify.ts';
import { MAX_FILE_BYTES, resolveInRoot } from './review/fs.ts';
import { ReviewService } from './review/service.ts';
import { SessionManager } from './sessions.ts';
import { patchSettings, readSettings } from './settings.ts';
import { setSessionOwner } from './workspaces.ts';

/** The HTTP surface: the REST API and the static bundle. */

/** Version reported by the health endpoint. */
const VERSION = '1.0.0';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Dashboard bundle, copied into the image by the Dockerfile's build stage.
 *
 * A caller may name another one: the browser suite serves the bundle it just
 * built, rather than putting a copy where the image would have.
 */
const DASHBOARD_DIR = resolve(here, '../dashboard');

/**
 * The bundle directory whose filenames carry a content hash, which is Vite's
 * `build.assetsDir`.
 */
const HASHED_ASSETS = '/assets/';

/** How long a content-hashed asset may be held, in seconds. A year. */
const ASSET_MAX_AGE = 31_536_000;

/**
 * How long one file of the bundle may be held.
 *
 * A name under the hashed-asset directory is derived from the bytes under it,
 * so a build that changes a file changes its name and this copy can never be
 * the wrong one. Every other name in the bundle — index.html above all, which
 * is the file that says which assets are current — stays the same across
 * builds and is therefore revalidated on every load.
 */
function cacheControlFor(path: string): string {
  return path.startsWith(HASHED_ASSETS)
    ? `public, max-age=${ASSET_MAX_AGE}, immutable`
    : 'no-cache';
}

/**
 * SHA-256 of the one inline script of index.html, base64.
 *
 * The theme switch that runs before first paint. It is the page's only inline
 * script and it is stated here rather than allowed wholesale, so the policy
 * still refuses every script it does not know. Editing that script means
 * editing this.
 */
const THEME_SCRIPT_HASH = "'sha256-4AdoNi/wvSpHLY3qRCPU3bCPtiW7L8VuMIcRP0Slv5s='";

/** A Host header worth putting in a header this process writes. */
const SAFE_HOST = /^[A-Za-z0-9.\-[\]]+(:\d+)?$/;

/**
 * The content security policy the dashboard document is served under.
 *
 * The thread renders markdown the agent wrote, and a remote `<img>` in it
 * would carry whatever it names out through the reader's browser instead of
 * through the egress proxy. So every fetch the page can make is pinned to
 * this origin: its own scripts and styles, images from here plus the `data:`
 * and `blob:` URLs an attachment preview is built from, and the gateway
 * socket on this same host.
 *
 * `'unsafe-inline'` for styles and not for scripts: the overlay primitives
 * position themselves and the code pane colours every token through the style
 * attribute, and a style attribute cannot be hashed.
 *
 * The socket is spelled out as well as covered by `'self'`, because not every
 * browser reads `'self'` as including the ws and wss forms of its origin. A
 * Host header that is not a plain host is dropped instead, which leaves the
 * page working everywhere that does.
 */
function documentCsp(host: string | undefined): string {
  const origin = host !== undefined && SAFE_HOST.test(host) ? host : null;
  return [
    "default-src 'none'",
    `script-src 'self' ${THEME_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${origin ? ` ws://${origin} wss://${origin}` : ''}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Smallest body that is compressed, in bytes. Below it the encoding headers
 * cost more than the saving.
 */
const COMPRESS_THRESHOLD_BYTES = 1024;

/** Whether the database answers a query, for the readiness probe. */
function databaseAnswers(db: Db): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch (err) {
    log.warn('the database did not answer', { error: (err as Error).message });
    return false;
  }
}

/** Whether the Docker daemon answers, for the readiness probe. */
async function dockerAnswers(): Promise<boolean> {
  try {
    await dk.docker().ping();
    return true;
  } catch (err) {
    log.warn('the Docker daemon did not answer', { error: (err as Error).message });
    return false;
  }
}

/** What a caller may put in place of a default when it builds the app. */
export interface BuildOptions {
  /** Where the dashboard bundle is, for a caller serving one it built itself. */
  bundleDir?: string;
}

/** What one orchestrator process hands its boot and its tests, wired together. */
export interface Orchestrator {
  app: ReturnType<typeof Fastify>;
  manager: SessionManager;
  cfg: Config;
  /** Owns the egress policy and keeps the proxy holding it. */
  egress: EgressManager;
  /** The deployment's credentials, as the settings page manages them. */
  credentials: CredentialStore;
  /** The logins in flight, one per credential at most. */
  logins: LoginManager;
  /** Session ids whose network is missing the egress proxy. */
  setProxyWarnings(warnings: string[]): void;
}

/**
 * Builds the HTTP app and the objects behind it, without listening or
 * touching Docker.
 *
 * Boot lives in main(); this is separate so a test can drive the real routes
 * over a real database without a Docker socket or an open port.
 */
export function buildApp(cfg: Config, db: Db, opts: BuildOptions = {}): Orchestrator {
  const bundleDir = opts.bundleDir ?? DASHBOARD_DIR;
  // Before anything creates a workspace directory or a container: everything
  // that writes files for the agent, or runs a process as it, reads this.
  setSessionOwner(cfg.SESSION_UID, cfg.SESSION_GID);

  // The store and the manager each need the other: the policy is composed
  // from the store's rows, and every write to the store re-pushes it. The
  // hoisted function below is what lets them be built in this order.
  const credentials = new CredentialStore(db, () => repushPolicy());
  const egress = new EgressManager(cfg, credentials);
  const notifier = new Notifier(db, cfg);

  /**
   * Pushes the policy again because a credential changed.
   *
   * Best effort and never awaited: the write that caused it has already
   * happened, the settings page should not fail because the proxy is
   * restarting, and the reconciler re-pushes every minute regardless.
   */
  function repushPolicy(): void {
    void egress.sync().catch((err: Error) => {
      log.warn('could not push the egress policy after a credential changed; will retry', {
        error: err.message,
      });
    });
  }
  // A login runs the harness's own CLI in a throwaway container built from
  // the session image, so the one thing it needs from the deployment is which
  // image that is.
  const logins = new LoginManager(credentials, dockerLoginRuntime(cfg.SESSION_IMAGE));
  const agents = new AgentStore(db, cfg.DATA_DIR);
  const manager = new SessionManager(db, cfg, egress, notifier, agents);
  // The review surface reaches the files and the box through the manager,
  // which is the one thing that knows whether a session is directory-backed
  // yet and how to get a container of it running.
  const review = new ReviewService(db, {
    workspacePath: (id) => manager.workspacePathOf(id),
    execTarget: (id) => manager.execTarget(id),
  });

  let proxyWarnings: string[] = [];

  const app = Fastify({ logger: false });

  /**
   * Attachment uploads arrive as raw bytes, which Fastify has no parser for
   * until it is given one. `parseAs: 'buffer'` is the whole of it: the route
   * sets the size limit, and what the bytes are is the client's business.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  /**
   * One line per response, which is the whole request log: Fastify's own
   * logger is off and everything here goes through the structured one.
   *
   * The path is taken without its query string, which can carry a filename or
   * a path the reader typed. A refusal is the caller's problem and a failure
   * is the deployment's, so the two get different levels.
   */
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    log[level]('request', {
      method: req.method,
      path: req.url.split('?')[0],
      status,
      ms: Math.round(reply.elapsedTime),
    });
  });

  // --- REST: unauthenticated here, the deployment puts auth in front ----------

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    // Fastify's own refusals — a body over the route's limit, a content type
    // with no parser — already carry both the status and the sentence worth
    // showing, so they are passed through as they are.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    log.error('unhandled request error', { error: (err as Error).message });
    return reply.code(500).send({ error: 'Internal error' });
  });

  /**
   * Liveness: this process is serving requests. Always 200 while it answers
   * at all, so a probe reading the status code restarts nothing that is
   * merely misconfigured. What is wrong with the deployment is in the body.
   */
  app.get('/healthz', async (): Promise<HealthResponse> => {
    const sessions = countLiveSessions(db);
    return {
      ok: true,
      version: VERSION,
      sessions,
      proxyWarnings,
      egress: egress.status(),
      harnesses: harnessHealth(),
      credentials: credentials.list().map((row) => credentials.summarize(row)),
      pushSubscriptions: countPushSubscriptions(db),
      // The one thing here that asks the daemon anything. Cached for a minute
      // and null on every failure, so the probe answers at the same speed and
      // stays green on a host whose Docker socket is not there.
      images: await deploymentImages(cfg),
    };
  });

  /**
   * Readiness: whether this deployment can serve sessions, as a status code.
   *
   * Three things decide it, because a session cannot be created or started
   * without all three: the database answers, the proxy holds the egress
   * policy this orchestrator composed, and the Docker daemon is reachable. An
   * egress policy that is not in sync counts because a session started
   * against a stale one reaches hosts the deployment has stopped allowing.
   *
   * What /healthz also reports stays out of this. A harness with no
   * credential is a deployment that serves sessions nobody has given a
   * credential, and a proxy warning names one session's network rather than
   * the instance — a probe that took the instance out of service for either
   * would be answering about the wrong thing.
   */
  app.get('/readyz', async (_req, reply): Promise<ReadyResponse> => {
    const checks = {
      database: databaseAnswers(db),
      egress: egress.status()?.inSync === true,
      docker: await dockerAnswers(),
    };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ ready, version: VERSION, checks });
  });

  /**
   * What each harness needs, and whether it has it.
   *
   * Only the harnesses this deployment can carry a credential to: a box holds
   * one placeholder per entry of CREDENTIAL_SET, so a harness whose
   * credential is not in that set could not be given one whatever the store
   * held. Both harnesses qualify now that the OpenAI credential is in the set,
   * and a third would the moment its own credential joined it.
   */
  function harnessHealth(): HarnessHealth[] {
    const deliverable = new Set(CREDENTIAL_SET.map((spec) => spec.id));
    return Object.values(HARNESSES)
      .filter((h) => deliverable.has(h.credentialId))
      .map((h) => {
        const row = credentials.get(h.credentialId);
        // A credential can be perfectly good and still not reach a box: a
        // subscription obtained by logging in is a document rather than a
        // header value, and Boxes has no way to hand one to a container yet.
        // See credentials.ts's deliverableSecret(), and PLAN.md section 3,
        // verify step 10. The reason travels in the field the dashboard
        // already shows beside a harness it cannot offer.
        const blocked = row ? undeliverableReason(row) : null;
        const summary = row ? credentials.summarize(row) : null;
        return {
          id: h.id,
          label: h.label,
          credential:
            summary && blocked ? { ...summary, lastError: summary.lastError ?? blocked } : summary,
          // A stored credential that is expired or failing is still stored:
          // the dashboard offers the harness and says what is wrong with it,
          // rather than having it disappear.
          runnable: row?.status === 'ok' && blocked === null,
        };
      });
  }

  /**
   * Every harness this deployment can run: what the registry says about it,
   * what its adapter last advertised, and whether it can run right now.
   *
   * What the dialogs are built from. The catalogue half is a cache written by
   * whichever adapter last answered a `session/new`, `session/load` or
   * `session/fork`, and it is null on a deployment that has never run one —
   * such a dialog offers the agent choice alone rather than starting a box to
   * find out what it would have offered.
   */
  app.get('/api/harnesses', async (): Promise<HarnessInfo[]> =>
    harnessHealth().map((health) => {
      const entry = HARNESSES[health.id];
      return {
        ...health,
        defaultModeId: entry.defaultModeId,
        forkModeId: entry.forkModeId,
        defaultConfig: { ...entry.defaultConfig },
        catalog: readHarnessCatalog(db, health.id),
      };
    }),
  );

  app.get('/api/sessions', async () => manager.list());

  app.post('/api/sessions', async (req, reply) => {
    const created = await manager.create(parseBody(createSessionBody, req.body));
    return reply.code(201).send(created);
  });

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    return manager.detail(id);
  });

  app.post('/api/sessions/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    return manager.start(id);
  });

  app.post('/api/sessions/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    return manager.stop(id);
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await manager.remove(id);
    // The review service caches per session; a deleted one has nothing to cache.
    review.forget(id);
    return reply.code(204).send();
  });

  /**
   * The conversations a session owns. A session shares its container, its
   * volumes and its egress policy across all of them, so an extra one costs
   * nothing but its own transcript.
   */
  app.get('/api/sessions/:id/threads', async (req) => {
    const { id } = req.params as { id: string };
    return manager.threads(id);
  });

  /**
   * Adds a conversation and makes it current: empty, or carrying the context of
   * the thread named by `from`.
   */
  app.post('/api/sessions/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    const created = await manager.createThread(id, parseBody(createThreadBody, req.body));
    return reply.code(201).send(created);
  });

  /**
   * Makes one of a session's threads current: what a connection naming no
   * thread gets. An ordinary write — every live connection is pinned to its
   * own thread, so nobody is dropped and nothing reconnects.
   */
  app.post('/api/sessions/:id/threads/:threadId/select', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    return manager.selectThread(id, threadId);
  });

  /**
   * Marks a conversation done, or takes the mark off again.
   *
   * A note the reader keeps about which of a box's conversations they are
   * finished with. It changes how the thread is drawn in a list, and the
   * thread still runs, still answers, and can be marked undone.
   */
  app.post('/api/sessions/:id/threads/:threadId/done', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const { done } = parseBody(threadDoneBody, req.body);
    return manager.setThreadDone(id, threadId, done);
  });

  /**
   * Stops one task that conversation left running, or every task it has.
   *
   * A stop and not a cancel: a background command outlives the turn which
   * started it, and interrupting the conversation does not reach it. The
   * adapter running the task is asked to stop it by name. The `processId` is
   * the id the thread state carried, which is the adapter's own id for the
   * task; without one, everything that thread is running stops.
   *
   * The answer says how many tasks the adapter stopped, and zero is an
   * ordinary one — a task that had already finished answers that it had, and
   * the thread's state is re-sent either way so the bar catches up.
   */
  app.post('/api/sessions/:id/threads/:threadId/background/stop', async (req) => {
    const { id, threadId } = req.params as { id: string; threadId: string };
    const { processId } = parseBody(backgroundStopBody, req.body);
    return manager.stopBackgroundWork(id, threadId, processId);
  });

  /**
   * Kills everything running in a box, whoever left it there.
   *
   * The per-thread stop reaches what an adapter is still holding; this reaches
   * what no adapter can name any more. Neither adapter re-announces the tasks
   * of a process that has died, so after a restart the bars are empty and the
   * box is still compiling something — and a signal is all that is left.
   *
   * The answer says how many processes were signalled.
   */
  app.post('/api/sessions/:id/background/stop', async (req) => {
    const { id } = req.params as { id: string };
    return manager.stopBoxWork(id);
  });

  /**
   * Stores one file the user attached to a prompt, in the session's own
   * workspace.
   *
   * Raw bytes rather than a multipart form: there is one file per request and
   * its name is in the query, and octet-stream is a body Fastify hands over
   * as a Buffer without a dependency that parses envelopes.
   *
   * The upload happens before the prompt that mentions it, and is what makes
   * the mention true. It needs no container: a workspace is a directory this
   * process owns, so a session that is stopped — or has never been started —
   * takes attachments the same way a running one does.
   */
  app.post(
    '/api/sessions/:id/attachments',
    { bodyLimit: cfg.MAX_ATTACHMENT_MB * 1024 * 1024 },
    async (req): Promise<StoredAttachment> => {
      const { id } = req.params as { id: string };
      const { name } = req.query as { name?: string };
      if (!name) throw new HttpError(400, 'name is required');

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new HttpError(400, 'an attachment body is required');
      }

      const workspace = manager.workspacePathOf(id);
      if (!workspace) throw new HttpError(404, 'Session not found');

      const stored = await storeAttachment(workspace, name, body);
      // The same touch every other thing a user does to a session makes: an
      // upload is somebody working here, and the reaper counts idleness.
      manager.touch(id);
      // And the one way a workspace grows with nothing running in it, which
      // is the case the size cache stops measuring.
      manager.workspaceChanged(id);
      log.session(id).info('attachment stored', { path: stored.path, size: stored.size });
      return stored;
    },
  );

  /**
   * Serves one stored attachment back, which is how the thread shows the
   * picture the user attached.
   *
   * This reads out of a tree the agent controls, so a link planted in the
   * attachments directory could otherwise serve whatever the orchestrator's
   * own uid can read. `resolveInRoot` holds the containment.
   *
   * What a browser can show — images, SVG, PDF — is served as itself, and
   * everything else as a download of unknown type. `sandbox` and
   * `default-src 'none'` leave an SVG opened as a document with no script and
   * no origin, and an SVG behind an `<img>` is inert. A PDF is served
   * unsandboxed so the browser's viewer takes it.
   */
  app.get('/api/sessions/:id/attachments/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    // Stored names are a single path component by construction, so anything
    // shaped otherwise is not looked for.
    if (name.includes('/') || name.includes('\\')) {
      throw new HttpError(404, 'Attachment not found');
    }

    const workspace = manager.workspacePathOf(id);
    if (!workspace) throw new HttpError(404, 'Session not found');

    const resolved = resolveInRoot(join(workspace, ATTACHMENTS_DIR), name);
    if (!resolved.ok) throw new HttpError(404, 'Attachment not found');
    const stat = statSync(resolved.path);
    if (!stat.isFile()) throw new HttpError(404, 'Attachment not found');

    const served = servedTypeFor(name);
    void reply.headers({
      'Content-Type': served.contentType,
      'Content-Length': String(stat.size),
      // The name is percent-encoded: it comes from a directory the agent
      // writes to, and a quote or a newline in it must not reach the header.
      'Content-Disposition': `${served.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      // The type is decided here rather than sniffed from the bytes, so a
      // download is never treated as a document.
      'X-Content-Type-Options': 'nosniff',
      // What lets an SVG be served as an SVG: nothing in one may run or
      // fetch anything.
      'Content-Security-Policy': served.sandbox ? "default-src 'none'; sandbox" : "default-src 'none'",
      // Short, rather than immutable: the name is stable but the file under
      // it belongs to a workspace the agent can rewrite.
      'Cache-Control': 'private, max-age=60',
    });
    return createReadStream(resolved.path);
  });

  // --- Code review over a session's workspace ---------------------------------

  /**
   * The review surface. Files come off the workspace directory this process
   * can read; git runs in the session's own container, over repositories the
   * agent controls. So a route that asks git something starts a stopped box,
   * and reviewing keeps it running.
   *
   * The responses are batched so a client gets one round trip per screen: the
   * directory endpoint carries a folder and everything the left panel needs
   * around it, the file endpoint the whole file view.
   *
   * A route that asks git something marks the session active, the same way a
   * local command does: running git in the box is use of the box, and the
   * reaper stopping one under an open review would only be followed by the
   * next request starting it again.
   *
   * Every one reads the filesystem on the spot and there is nothing to poll, so
   * a fetch is the freshness. Git is the exception: its answer for the whole
   * workspace is held for as long as a review is being browsed, and the browser
   * asks for a new one when it arrives.
   */

  /**
   * One directory of the review, with the facts the whole view needs.
   *
   * `path` is workspace-relative and empty for the root. `fresh` is the browser
   * saying it has arrived rather than opened a folder: it takes git's answer
   * for the workspace again and runs the drift check.
   */
  app.get('/api/sessions/:id/review/dir', async (req) => {
    const { id } = req.params as { id: string };
    const { path, fresh } = req.query as { path?: string; fresh?: string };
    return review.dir(id, path ?? '', fresh === '1');
  });

  app.get('/api/sessions/:id/review/file', async (req) => {
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path) throw new HttpError(400, 'path is required');
    return review.file(id, path);
  });

  /**
   * Saves one file of the workspace, as edited in the review.
   *
   * The whole file and the hash it was read at, so a save over an edit the
   * agent made in the meantime is refused instead of made. The answer is the
   * file endpoint's, so the view repaints from one round trip.
   */
  app.put(
    '/api/sessions/:id/review/file',
    // Above the display limit the service enforces, because a file that size
    // grows when it is JSON-encoded, and a save must not fail before that
    // check is reached.
    { bodyLimit: 2 * MAX_FILE_BYTES },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = parseBody(reviewFileBody, req.body);
      return review.writeFile(id, body.path, body.content, body.hash ?? '');
    },
  );

  /**
   * Creates or replaces the comment on one line. The same route for both,
   * because REVIEW.md holds at most one comment per line and the reviewer
   * editing one is not a different operation from writing it.
   */
  app.put('/api/sessions/:id/review/annotations', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(reviewAnnotationBody, req.body);
    const annotations = await review.setAnnotation(id, body.path, body.line, body.comment);
    return { path: body.path, annotations } satisfies ReviewAnnotationsResponse;
  });

  app.delete('/api/sessions/:id/review/annotations', async (req) => {
    const { id } = req.params as { id: string };
    const { path, line } = req.query as { path?: string; line?: string };
    if (!path) throw new HttpError(400, 'path is required');
    const annotations = await review.deleteAnnotation(id, path, Number(line));
    return { path, annotations } satisfies ReviewAnnotationsResponse;
  });

  /**
   * Sets the revision the whole review is compared against, or clears it back
   * to each repository's working tree. The answer says where it landed, since
   * one expression resolves separately in every repository.
   */
  app.put('/api/sessions/:id/review/base', async (req) => {
    const { id } = req.params as { id: string };
    const { rev } = parseBody(reviewBaseBody, req.body);
    return review.setBase(id, rev ?? null);
  });

  /** Deletes REVIEW.md — the "New review" button. The file is the review. */
  app.delete('/api/sessions/:id/review', async (req, reply) => {
    const { id } = req.params as { id: string };
    await review.deleteReview(id);
    return reply.code(204).send();
  });

  // --- Agent configuration ----------------------------------------------------

  /**
   * The AGENTS.md, skills and slash commands a session is given.
   *
   * `global` is applied to every session and always exists; any other set is
   * chosen when a session is created and merged over it. Every mutation
   * answers with the whole set rather than the piece that changed.
   *
   * What is written here reaches a box when that box next starts.
   */

  app.get('/api/agent-sets', async () => agents.listSets());

  app.post('/api/agent-sets', async (req, reply) => {
    const body = parseBody(createAgentSetBody, req.body);
    return reply.code(201).send(agents.createSet(body.name));
  });

  app.get('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.getSet(setId);
  });

  app.patch('/api/agent-sets/:setId', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.updateSet(setId, parseBody(updateAgentSetBody, req.body));
  });

  app.delete('/api/agent-sets/:setId', async (req, reply) => {
    const { setId } = req.params as { setId: string };
    agents.deleteSet(setId);
    return reply.code(204).send();
  });

  /** Creates a skill or command, or replaces the one already under that name. */
  app.put('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    return agents.putItem(setId, parseBody(agentItemBody, req.body));
  });

  app.delete('/api/agent-sets/:setId/items', async (req) => {
    const { setId } = req.params as { setId: string };
    const { kind, name } = req.query as { kind?: string; name?: string };
    return agents.deleteItem(setId, kind, name);
  });

  /**
   * What a session selecting this set gets, global set included.
   *
   * A merge of two sets is not obvious from either half, so the editor shows
   * the result.
   */
  app.get('/api/agent-sets/:setId/preview', async (req) => {
    const { setId } = req.params as { setId: string };
    agents.getSet(setId);
    return agents.bundle(setId);
  });

  // --- Credentials and settings ------------------------------------------------

  /**
   * The deployment's credentials and the plain settings beside them.
   *
   * Secrets are write-only: they go in through PUT and come back out only as
   * an account and a status. Every write starts a recompose and a push of the
   * egress policy through the store's own change hook, so a pasted token
   * reaches the proxy in the same second rather than at the reconciler's next
   * minute.
   */

  app.get('/api/credentials', async (): Promise<CredentialSummary[]> =>
    credentials.list().map((row) => credentials.summarize(row)),
  );

  app.put('/api/credentials/:id', async (req) => {
    const id = credentialId(req.params as { id: string });
    const { method, secret } = parseBody(putCredentialBody, req.body);
    return credentials.summarize(credentials.put(id, method, secret));
  });

  app.delete('/api/credentials/:id', async (req, reply) => {
    credentials.remove(credentialId(req.params as { id: string }));
    return reply.code(204).send();
  });

  /**
   * Logging in, for a credential that cannot be pasted.
   *
   * A ChatGPT or Claude subscription has no static form: the only thing that
   * can obtain one is the harness's own CLI, which Boxes runs in a throwaway
   * container and drives from here. Four calls, because the flow is a state
   * machine a page polls rather than a request that blocks for the minutes a
   * person takes in a browser: start it, ask where it is, answer the one
   * question Claude's CLI asks, and give up.
   *
   * `github` has no flow — a personal access token is a string somebody
   * pastes — and says so rather than starting a container that would print
   * nothing.
   */

  app.post('/api/credentials/:id/login', async (req) => {
    const id = credentialId(req.params as { id: string });
    return { loginId: logins.start(id) };
  });

  app.get('/api/credentials/:id/login/:loginId', async (req): Promise<LoginState> => {
    const { loginId } = req.params as { loginId: string };
    return logins.state(credentialId(req.params as { id: string }), loginId);
  });

  app.post('/api/credentials/:id/login/:loginId/code', async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    const { code } = parseBody(loginCodeBody, req.body);
    logins.submitCode(credentialId(req.params as { id: string }), loginId, code);
    // Nothing to answer with: where the login goes next is what the poll
    // above says, and it may not have moved yet.
    return reply.code(204).send();
  });

  app.delete('/api/credentials/:id/login/:loginId', async (req, reply) => {
    const { loginId } = req.params as { loginId: string };
    logins.cancel(credentialId(req.params as { id: string }), loginId);
    return reply.code(204).send();
  });

  /** The credential a route names, or a 400 rather than a row nobody can use. */
  function credentialId(params: { id: string }): CredentialId {
    if (!isCredentialId(params.id)) {
      throw new HttpError(400, `Unknown credential: ${params.id}`);
    }
    return params.id;
  }

  app.get('/api/settings', async (): Promise<Settings> => readSettings(db));

  /**
   * Writes the settings a body names and answers with the whole of them.
   *
   * A patch rather than a put: the git identity and a dialog's last choice are
   * written by different screens, and neither should carry the other's values
   * to be able to save.
   */
  app.patch('/api/settings', async (req): Promise<Settings> =>
    patchSettings(db, parseBody(patchSettingsBody, req.body)),
  );

  // --- Web Push --------------------------------------------------------------

  /**
   * The deployment's VAPID public key, which a browser needs before it can
   * subscribe at all.
   *
   * Not a secret: it is the identity a push service checks the signature
   * against, and it is meant to be handed to every browser.
   */
  app.get('/api/push/key', async (): Promise<PushKeyResponse> => ({
    publicKey: notifier.publicKey,
  }));

  /**
   * Checks a push endpoint before the orchestrator will ever POST to it.
   *
   * https only, and never an address literal: a push service is always a named
   * host, and accepting a literal would turn this route into a way to aim the
   * orchestrator at the LAN it can see. A hostname that resolves into private
   * space is not caught here — the API is root-equivalent either way, and
   * whatever authenticates it is the real boundary.
   */
  function validEndpoint(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2000) {
      throw new HttpError(400, 'endpoint is required');
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HttpError(400, 'endpoint must be a URL');
    }
    if (url.protocol !== 'https:') throw new HttpError(400, 'endpoint must be https');
    if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === 'localhost') {
      throw new HttpError(400, 'endpoint must name a host, not an address');
    }
    return value;
  }

  /** Checks one base64url key from a subscription decodes to the expected size. */
  function validKey(value: unknown, bytes: number, name: string): string {
    if (typeof value !== 'string' || Buffer.from(value, 'base64url').length !== bytes) {
      throw new HttpError(400, `${name} must be ${bytes} base64url-encoded bytes`);
    }
    return value;
  }

  /**
   * Registers a browser for push, or refreshes what is stored for it.
   *
   * There is no user to attach this to, since Boxes has no accounts, so a
   * subscription is one more browser this deployment notifies and whatever
   * authenticates the rest of `/api` decides who may add one.
   */
  app.post('/api/push/subscribe', async (req, reply) => {
    const body = parseBody(pushSubscribeBody, req.body);
    const endpoint = validEndpoint(body.endpoint);
    const p256dh = validKey(body.keys.p256dh, 65, 'p256dh');
    const auth = validKey(body.keys.auth, 16, 'auth');
    const label = typeof body.label === 'string' ? body.label.slice(0, 100) : null;

    // Under the key this deployment holds now: a subscription outlives a key
    // rotation as a row that can never be delivered to again.
    upsertPushSubscription(db, endpoint, p256dh, auth, label, notifier.publicKey);
    log.info('registered a push subscription', { endpoint: new URL(endpoint).origin });
    return reply.code(204).send();
  });

  /** Forgets a browser's subscription, on its own way out. */
  app.delete('/api/push/subscribe', async (req, reply) => {
    const { endpoint } = parseBody(pushUnsubscribeBody, req.body);
    deletePushSubscription(db, endpoint);
    return reply.code(204).send();
  });

  // --- Static bundles with a single-page fallback -----------------------------

  /** Content types served from the bundles, by file extension. */
  const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.map': 'application/json',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  };

  /**
   * Serves the dashboard bundle: a real file when the path names one, else its
   * index.html so client-side routes survive a reload.
   *
   * The path is resolved under the bundle directory and has to stay there, with
   * the separator in the prefix check so a sibling directory whose name merely
   * starts the same way is not inside it.
   *
   * Every file is streamed rather than read in one piece: the entry chunk is
   * over a megabyte, and reading it synchronously would stop the event loop
   * on every request for it.
   */
  function sendBundle(reply: FastifyReply, path: string, host: string | undefined): FastifyReply {
    const candidate = resolve(bundleDir, `.${normalize(path)}`);
    if (
      candidate.startsWith(`${bundleDir}/`) &&
      path !== '/' &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const ext = candidate.slice(candidate.lastIndexOf('.'));
      return reply
        .type(CONTENT_TYPES[ext] ?? 'application/octet-stream')
        .header('Cache-Control', cacheControlFor(path))
        .send(createReadStream(candidate));
    }
    const index = join(bundleDir, 'index.html');
    if (!existsSync(index)) return reply.code(404).send({ error: 'Dashboard not built' });
    return reply
      .headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cacheControlFor('/index.html'),
        'Content-Security-Policy': documentCsp(host),
      })
      .send(createReadStream(index));
  }

  /**
   * The bundle, and the compression it is served with.
   *
   * The compression plugin wires itself into each route as that route is
   * declared, so it is loaded first and the route below is declared from
   * inside it. That is also why the bundle is a route rather than the
   * not-found handler: a handler Fastify never announces as a route is a
   * handler the plugin never sees.
   *
   * The entry chunk is over a megabyte of JavaScript and about a third of
   * that gzipped. The plugin picks whichever encoding the browser offered and
   * leaves a body it knows is already compressed — a PNG, a font — alone.
   */
  void app.register(async (bundle) => {
    await bundle.register(compress, { global: true, threshold: COMPRESS_THRESHOLD_BYTES });
    /**
     * Every GET that is not the API or the gateway is the dashboard: a file
     * of the bundle where the path names one, and index.html where it names a
     * client-side route.
     */
    bundle.get('/*', async (req, reply) => {
      const url = req.url.split('?')[0] ?? '/';
      if (url.startsWith('/api') || url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return sendBundle(reply, url, req.headers.host);
    });
  });

  /** Anything the routes above did not match, which is never the dashboard. */
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'Not found' }));

  return {
    app,
    manager,
    cfg,
    egress,
    credentials,
    logins,
    setProxyWarnings: (warnings) => {
      proxyWarnings = warnings;
    },
  };
}
