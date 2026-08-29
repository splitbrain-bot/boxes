import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { allAddressesAllowed, isBlockedAddress } from './cidr.ts';

/**
 * The sole egress path out of every session network.
 *
 * Session networks are internal Docker networks with no NAT and no default
 * route. This process is attached to each of them under the alias proxy, so it
 * is the only thing an agent can reach and the boundary between a session, the
 * LAN, and every other session.
 */

/** Port the proxy listens on. */
const PORT = Number(process.env['PORT'] ?? 3128);

/** Destination ports an agent may reach. */
const ALLOWED_PORTS = new Set([80, 443]);

/** How long a CONNECT may take to establish, in milliseconds. */
const CONNECT_TIMEOUT_MS = 15_000;

/** How long an established connection may sit idle, in milliseconds. */
const IDLE_TIMEOUT_MS = 120_000;

/** Writes one JSON line to stderr. */
function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`,
  );
}

/** Where a request wants to go. */
interface Target {
  host: string;
  port: number;
}

/** Splits an authority into host and port, or null if it is malformed. */
function parseHostPort(authority: string, defaultPort: number): Target | null {
  // IPv6 literals arrive bracketed: [::1]:443
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) return null;
    const host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { host: authority, port: defaultPort };
  const host = authority.slice(0, colon);
  const port = Number(authority.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (host === '') return null;
  return { host, port };
}

/**
 * Vets a target and returns the single address to pin the connection to. An IP
 * literal is checked as it stands; a hostname is resolved first and every
 * answer has to pass.
 */
async function vetTarget(
  target: Target,
): Promise<{ ok: true; address: string; family: number } | { ok: false; reason: string }> {
  if (!ALLOWED_PORTS.has(target.port)) {
    return { ok: false, reason: `port ${target.port} not allowed` };
  }

  // An IP literal skips DNS but goes through the identical CIDR check.
  const literalFamily = net.isIP(target.host);
  if (literalFamily !== 0) {
    if (isBlockedAddress(target.host)) {
      return { ok: false, reason: 'target address is in a blocked range' };
    }
    return { ok: true, address: target.host, family: literalFamily };
  }

  let answers: dns.LookupAddress[];
  try {
    answers = await dns.promises.lookup(target.host, { all: true });
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${(err as Error).message}` };
  }

  const addresses = answers.map((a) => a.address);
  if (!allAddressesAllowed(addresses)) {
    // Rejecting when any answer is private closes DNS rebinding: a hostname
    // must not pass with a public record and connect with a private one.
    return { ok: false, reason: 'hostname resolves to a blocked address' };
  }

  const chosen = answers[0];
  if (!chosen) return { ok: false, reason: 'no addresses resolved' };
  return { ok: true, address: chosen.address, family: chosen.family };
}

/** Answers a forwarded request with a 403 and the reason. */
function deny(res: http.ServerResponse, reason: string): void {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`egress denied: ${reason}\n`);
}

const server = http.createServer();

// --- absolute-URI plain HTTP (port 80) --------------------------------------

server.on('request', (req, res) => {
  const rawUrl = req.url ?? '';
  if (!/^https?:\/\//i.test(rawUrl)) {
    // A non-absolute request URI addresses this process as an origin server,
    // which it never is.
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('this is a forward proxy; use an absolute request URI\n');
    return;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    deny(res, 'malformed URL');
    return;
  }
  if (url.protocol !== 'http:') {
    // https must arrive as CONNECT: this proxy never terminates TLS.
    deny(res, 'only http:// may be forwarded; use CONNECT for https');
    return;
  }

  const target = parseHostPort(url.host, 80);
  if (!target) {
    deny(res, 'malformed host');
    return;
  }

  void vetTarget(target).then((verdict) => {
    if (!verdict.ok) {
      log('denied http request', { host: target.host, port: target.port, reason: verdict.reason });
      deny(res, verdict.reason);
      return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    headers['host'] = url.host;

    const upstream = http.request(
      {
        // Pinned to the vetted address. The Host header preserves virtual
        // hosting, and no second resolution can race the check.
        host: verdict.address,
        port: target.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', (err) => {
      log('upstream http error', { host: target.host, error: err.message });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('upstream error\n');
    });
    req.pipe(upstream);
  });
});

// --- CONNECT tunnel (port 443) ----------------------------------------------

server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
  const refuse = (code: number, reason: string): void => {
    try {
      clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
    } catch {
      // client already gone
    }
    clientSocket.destroy();
  };

  const target = parseHostPort(req.url ?? '', 443);
  if (!target) {
    refuse(400, 'Bad Request');
    return;
  }

  void vetTarget(target).then((verdict) => {
    if (!verdict.ok) {
      log('denied CONNECT', { host: target.host, port: target.port, reason: verdict.reason });
      refuse(403, 'Forbidden');
      return;
    }

    const upstream = net.connect(
      { host: verdict.address, port: target.port, family: verdict.family },
      () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );

    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      upstream.destroy();
      clientSocket.destroy();
    });
    upstream.on('connect', () => upstream.setTimeout(IDLE_TIMEOUT_MS));
    upstream.on('error', (err) => {
      log('upstream CONNECT error', { host: target.host, error: err.message });
      refuse(502, 'Bad Gateway');
      upstream.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });
});

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, '0.0.0.0', () => {
  log('egress proxy listening', { port: PORT, allowedPorts: [...ALLOWED_PORTS] });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutting down', { signal });
    server.close(() => process.exit(0));
  });
}
