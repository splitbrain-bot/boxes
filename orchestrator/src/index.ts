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
  startTunnelReconciler,
  startImageRefresher,
  startProxyReconciler,
  startReaper,
} from './reaper.ts';

// --- the app and its database ----------------------------------------------

/**
 * Claims DATA_DIR, or logs that another orchestrator holds it and exits.
 *
 * The boot calls this before it opens the database. The claim is released
 * when this process exits.
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
    // A deployment that takes over on every boot is killed rather than stopped.
    log.warn('took over a claim nothing was holding', { dataDir, stampedAt: claim.tookOver });
  }
  process.on('exit', claim.release);
}

/** The parsed configuration. */
const cfg = config();
setLogLevel(cfg.LOG_LEVEL);
lockDataDir(cfg.DATA_DIR);

/** The database under DATA_DIR. */
const db = openDb(cfg.DATA_DIR);

/** The HTTP app and the services it built. */
const { app, manager, credentials, egress, logins, tunnels, setProxyWarnings } = buildApp(cfg, db);

// --- WebSocket gateway: token-authed on the upgrade itself ------------------

/**
 * Largest ACP frame the gateway accepts from a client, in bytes.
 *
 * An ACP prompt can carry an inline base64 image, so the limit leaves room for
 * that. A larger frame closes the connection with code 1009, so no legitimate
 * frame should reach the limit.
 */
const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;

/** The WebSocket server for ACP connections. */
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
 * The upgrade paths of the ACP gateway.
 *
 * The long form names a thread and connects to that conversation. The short
 * form names none and means the current thread of the box. External ACP
 * clients use the short form.
 */
const WS_PATH =
  /^\/ws\/boxes\/([A-Za-z0-9_-]{1,64})(?:\/threads\/([A-Za-z0-9_-]{1,64}))?\/acp$/;

/**
 * The WebSocket server for terminals. It is separate from the ACP one, because
 * the two negotiate different subprotocols and `handleProtocols` runs before
 * the path is known.
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
 * Each one is a pty and a tmux client, and all of them show the same shell.
 * More than a handful means a browser is reconnecting in a loop.
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

  // A token opens only the box the path names. A missing or deleted box has
  // no token and is refused like a wrong token, so the handshake does not
  // reveal which boxes exist. The ACP and terminal endpoints share the token.
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

  // A connection stays on its thread for its whole life, so an unknown thread
  // is refused now. The caller holds the box token, so the 404 reveals only
  // facts about their own box.
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

  // Best effort, so a deployment with an unreachable registry still boots.
  // Creating a box pulls again and reports the error. The refresh lets a
  // restart pick up a moved tag. It is skipped when the periodic refresh is
  // off, which means the image is built on this host.
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
  loops.push(startTunnelReconciler(tunnels));

  await app.listen({ host: '0.0.0.0', port: cfg.PORT });
  log.info('orchestrator listening', { port: cfg.PORT });
}

/**
 * How long shutdown waits for running turns before it kills the adapters, in
 * milliseconds.
 *
 * Killing an adapter ends the turn running in it. The wait fits inside the
 * default ten seconds Docker allows between SIGTERM and SIGKILL, with room
 * left for the teardown and the database close.
 */
const TURN_DRAIN_MS = 8_000;

/** How often the drain checks again which turns are still running, in milliseconds. */
const TURN_DRAIN_POLL_MS = 250;

/**
 * Waits for the running turns to finish, up to TURN_DRAIN_MS. Boxes with
 * turns still running after that are logged, as those turns are cut.
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
    // Stop new work first: the loops stop, and the server stops listening
    // while it finishes the requests it already has.
    for (const loop of loops) loop.stop();
    const closed = app
      .close()
      .catch((err: Error) => log.error('server close failed', { error: err.message }));
    // Then wait for the turns, and only then kill the adapters.
    void drainTurns()
      .then(() => {
        manager.closeAll();
        // A running login has its own container. Otherwise only the sweep
        // would remove it, once it is fifteen minutes old.
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
