import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { ACP_SUBPROTOCOL } from '../../shared/acp.ts';
import { TERMINAL_SUBPROTOCOL } from '../../shared/terminal.ts';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { openDb, boxesWithActiveTurns } from './db.ts';
import { checkUpgrade, attachDownstream } from './gateway/downstream.ts';
import { attachTerminal } from './gateway/terminal.ts';
import { claimDataDir } from './lock.ts';
import { log, setLogLevel } from './log.ts';
import {
  startCredentialRefresh,
  startImageRefresher,
  startProxyReconciler,
  startReaper,
} from './reaper.ts';

// --- the app and its database ----------------------------------------------

/**
 * Claims DATA_DIR, or says who has it and stops.
 *
 * Taken before the database is opened, which is the first thing under this
 * directory two processes cannot share, and given up as this process exits.
 */
function lockDataDir(dataDir: string): void {
  const claim = claimDataDir(dataDir);
  if (claim.held) {
    log.error('another orchestrator is already running on this data directory', {
      dataDir,
      quietForMs: claim.quietFor,
    });
    process.exit(1);
  }
  if (claim.tookOver !== null) {
    // Worth saying: a deployment that takes over on every boot is one being
    // killed rather than stopped.
    log.warn('took over a claim nothing was holding', { dataDir, stampedAt: claim.tookOver });
  }
  process.on('exit', claim.release);
}

const cfg = config();
setLogLevel(cfg.LOG_LEVEL);
lockDataDir(cfg.DATA_DIR);
const db = openDb(cfg.DATA_DIR);
const { app, manager, credentials, egress, logins, setProxyWarnings } = buildApp(cfg, db);

// --- WebSocket gateway: token-authed on the upgrade itself ------------------

/**
 * Largest ACP frame the gateway accepts from a browser, in bytes.
 *
 * The gateway is an ACP endpoint any client may speak to, and an ACP prompt
 * can carry an image inline as base64, so a ceiling is worth stating: ws
 * defaults to 100 MiB. A frame over it closes the connection with 1009 rather
 * than failing the request, so the number is one nothing legitimate reaches.
 */
const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_FRAME_BYTES,
  // The client offers [ACP_SUBPROTOCOL, 'bearer.<token>']. The bearer entry
  // is credentials, not a protocol, so the subprotocol is negotiated
  // explicitly rather than relying on the client to list it first.
  handleProtocols: (protocols) =>
    protocols.has(ACP_SUBPROTOCOL) ? ACP_SUBPROTOCOL : false,
});
/**
 * The upgrade paths the gateway answers.
 *
 * The long shape names a thread, and is a connection to that conversation.
 * The short one names none and means whichever thread the box has
 * current, which is what an external ACP client uses.
 */
const WS_PATH =
  /^\/ws\/boxes\/([A-Za-z0-9_-]{1,64})(?:\/threads\/([A-Za-z0-9_-]{1,64}))?\/acp$/;

/**
 * A terminal server of its own, because the two endpoints negotiate different
 * subprotocols and `handleProtocols` is answered before the path is in hand.
 */
const terminals = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) =>
    protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false,
});

/** The upgrade path a terminal connects on. It names a box, never a thread. */
const TERMINAL_PATH = /^\/ws\/boxes\/([A-Za-z0-9_-]{1,64})\/terminal$/;

/**
 * How many terminals one box may have open at once.
 *
 * Each one is a pty and a tmux client in a container whose processes are
 * already capped, and they all show the same shell. More than a handful is a
 * browser reconnecting in a loop.
 */
const MAX_TERMINALS_PER_BOX = 4;

app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? '';
  const match = WS_PATH.exec(path);
  const terminal = match ? null : TERMINAL_PATH.exec(path);
  if (!match && !terminal) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const boxId = (match ?? terminal!)[1]!;
  const threadId = match?.[2] ?? null;

  // The upgrade is checked against the token of the box the path names,
  // so a token opens that box and no other one. A box that is not
  // there, or one that is deleted, has no token, and the upgrade is then
  // refused the way a wrong token is: the handshake never says which boxes
  // exist. Both endpoints are the same box seen two ways, so both are opened
  // by the same token, and each is offered the name of its own protocol.
  const row = manager.getRow(boxId);
  const live = row && row.status !== 'deleted' ? row : null;

  const check = checkUpgrade(
    req.headers['sec-websocket-protocol'],
    live?.ws_token ?? null,
    terminal ? TERMINAL_SUBPROTOCOL : ACP_SUBPROTOCOL,
  );
  if (!check.ok) {
    log.warn('rejected WS upgrade', { boxId, reason: check.reason });
    // The handshake fails before a WebSocket exists, so the refusal is an
    // HTTP status rather than a close code.
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (terminal) {
    if (manager.terminalCount(boxId) >= MAX_TERMINALS_PER_BOX) {
      log.warn('rejected a terminal upgrade for a box that has enough', { boxId });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    terminals.handleUpgrade(req, socket, head, (ws) => {
      attachTerminal(ws, boxId, manager);
    });
    return;
  }

  // A thread that is not this box's is refused here, before a WebSocket
  // exists. Whoever asks has the box's token, so a 404 tells them only
  // about their own box. A connection is pinned for its whole life, so
  // there is no later point at which to find this out.
  if (threadId !== null && !manager.hasThread(boxId, threadId)) {
    log.warn('rejected WS upgrade for an unknown thread', { boxId, threadId });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    attachDownstream(ws, boxId, threadId, manager);
  });
});

// --- boot -------------------------------------------------------------------

/** The background loops, so shutdown can stop them before anything else. */
const loops: Array<{ stop: () => void }> = [];

/** Reconciles against Docker, starts the background loops, and listens. */
async function main(): Promise<void> {
  // The policy has to exist before the first box is created, because a
  // box's environment is built from it. Pushing it can fail — the proxy
  // may still be booting — and the reconciler retries every minute.
  await egress.prepare();
  try {
    await egress.sync();
  } catch (err) {
    log.warn('could not push the egress policy at boot; will retry', {
      error: (err as Error).message,
    });
  }

  // Before anything creates or starts a container: a workspace bind names a
  // host-side path, and this is what resolves it.
  await manager.resolveHostDataDir();

  // Before the first box is created, and best-effort: a deployment whose
  // registry is unreachable should still come up and serve what it has. The
  // create path pulls again, and reports properly when there is nothing to
  // create a box from.
  //
  // The refresh is what makes a restart a way to pick up a tag that has moved,
  // rather than waiting out the refresher's first tick. It is skipped where
  // the refresh is off, which says the image is built on this host and no
  // registry has it.
  try {
    if (cfg.BOX_IMAGE_PULL_MINUTES > 0) await manager.refreshBoxImage();
    await manager.ensureBoxImage();
  } catch (err) {
    log.warn('could not pull the box image at boot', {
      image: cfg.BOX_IMAGE,
      error: (err as Error).message,
    });
  }

  await manager.reconcile();
  loops.push(startReaper(db, cfg, manager));
  loops.push(startImageRefresher(cfg, manager));
  loops.push(startProxyReconciler(manager, egress, setProxyWarnings));
  loops.push(startCredentialRefresh(credentials));

  await app.listen({ host: '0.0.0.0', port: cfg.PORT });
  log.info('orchestrator listening', { port: cfg.PORT });
}

/**
 * How long a turn still in flight is given to finish before shutdown tears the
 * adapters down, in milliseconds.
 *
 * Tearing an upstream down kills the adapter exec, which ends whatever turn is
 * running in it, so a routine deploy cuts live work unless it waits first.
 * Eight seconds is the trade: long enough for a turn that is nearly done to
 * reach a settle point and have what it wrote stored, and short enough to
 * finish inside the ten seconds Docker gives a container between SIGTERM and
 * SIGKILL by default, with room left for the teardown and the database close.
 * Waiting past that point buys nothing, because the process is killed anyway.
 */
const TURN_DRAIN_MS = 8_000;

/** How often the drain looks again at what is still running. */
const TURN_DRAIN_POLL_MS = 250;

/**
 * Waits for the turns in flight to finish, up to TURN_DRAIN_MS.
 *
 * A turn that has not finished by then is cut when the adapters go, which
 * nothing here can avoid — so it is named in the log rather than left to look
 * like a clean shutdown.
 */
async function drainTurns(): Promise<void> {
  let busy = boxesWithActiveTurns(db);
  if (busy.size === 0) return;
  log.info('waiting for the turns in flight to finish', {
    boxes: [...busy],
    graceMs: TURN_DRAIN_MS,
  });
  const deadline = Date.now() + TURN_DRAIN_MS;
  while (busy.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TURN_DRAIN_POLL_MS));
    busy = boxesWithActiveTurns(db);
  }
  if (busy.size > 0) {
    log.warn('shutting down with turns still running; they are cut here', {
      boxes: [...busy],
    });
    return;
  }
  log.info('every turn in flight finished');
}

// Once: a second signal while the server is closing must not re-enter this.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info('shutting down', { signal });
    // No new work is taken on first: the background loops stop, and the server
    // stops listening while it finishes the requests it already has.
    for (const loop of loops) loop.stop();
    const closed = app
      .close()
      .catch((err: Error) => log.error('server close failed', { error: err.message }));
    // Then the turns get their grace, and only then are the adapters killed.
    void drainTurns()
      .then(() => {
        manager.closeAll();
        // A login in flight holds a container of its own, which nothing else
        // would remove until the sweep noticed it fifteen minutes later.
        logins.closeAll();
        return closed;
      })
      .finally(() => {
        db.close();
        process.exit(0);
      });
  });
}

main().catch((err: Error) => {
  log.error('fatal boot error', { error: err.message });
  process.exit(1);
});
