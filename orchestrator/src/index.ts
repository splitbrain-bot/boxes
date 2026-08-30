import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { buildApp } from './app.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { ACP_SUBPROTOCOL, checkUpgrade, attachDownstream } from './gateway/downstream.ts';
import { log } from './log.ts';
import { startProxyReconciler, startReaper } from './reaper.ts';

// --- boot ------------------------------------------------------------------

const cfg = config();
const db = openDb(cfg.DATA_DIR);
const { app, manager, setProxyWarnings } = buildApp(cfg, db);

// --- WebSocket gateway: token-authed on the upgrade itself ------------------

const wss = new WebSocketServer({
  noServer: true,
  // The client offers ['acp.v1', 'bearer.<token>']. The bearer entry is
  // credentials, not a protocol, so acp.v1 is negotiated explicitly rather
  // than relying on the client to list it first.
  handleProtocols: (protocols) =>
    protocols.has(ACP_SUBPROTOCOL) ? ACP_SUBPROTOCOL : false,
});
/** The only upgrade path the gateway answers, capturing the session id. */
const WS_PATH = /^\/ws\/sessions\/([A-Za-z0-9_-]{1,64})\/acp$/;

app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = req.url ?? '';
  const match = WS_PATH.exec(url.split('?')[0] ?? '');
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const sessionId = match[1]!;

  const check = checkUpgrade(req.headers['sec-websocket-protocol'], cfg);
  if (!check.ok) {
    log.warn('rejected WS upgrade', { sessionId, reason: check.reason });
    // The handshake fails before a WebSocket exists, so the refusal is an
    // HTTP status rather than a close code.
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const row = manager.getRow(sessionId);
  if (!row || row.status === 'deleted') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    attachDownstream(ws, sessionId, manager);
  });
});

// --- boot -------------------------------------------------------------------

/** Reconciles against Docker, starts the background loops, and listens. */
async function main(): Promise<void> {
  await manager.reconcile();
  startReaper(db, cfg, manager);
  startProxyReconciler(manager, setProxyWarnings);

  await app.listen({ host: '0.0.0.0', port: cfg.PORT });
  log.info('orchestrator listening', { port: cfg.PORT });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    manager.closeAll();
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

main().catch((err: Error) => {
  log.error('fatal boot error', { error: err.message });
  process.exit(1);
});
