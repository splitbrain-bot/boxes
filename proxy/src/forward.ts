import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import type { EgressPolicy } from '../../shared/types.ts';
import { allAddressesAllowed, isBlockedAddress } from './cidr.ts';
import { hostAllowed, isInjectionHost } from './policy.ts';

/**
 * The forwarding half of the proxy: allowlist, address vetting, and the pinned
 * connection out.
 *
 * The proxy runs two of these. The front door faces the box networks and
 * may hand an intercepted host to the TLS engine; the upstream tunnel listens
 * on loopback and vets every connection the TLS engine makes, so decrypting a
 * host buys no way around the checks below.
 */

/** Destination ports an agent may reach. */
export const ALLOWED_PORTS = new Set([80, 443]);

/** How long a CONNECT may take to establish, in milliseconds. */
const CONNECT_TIMEOUT_MS = 15_000;

/** How long an established connection may sit idle, in milliseconds. */
const IDLE_TIMEOUT_MS = 120_000;

/** How long the TLS engine has to accept a replayed CONNECT, in milliseconds. */
const INTERCEPT_HANDSHAKE_MS = 10_000;

/** Why a request was denied, as a fixed set the proxy counts and reports. */
export type DenialCategory =
  | 'port'
  | 'allowlist'
  | 'blocked-address'
  | 'dns'
  | 'foreign-credential'
  | 'plaintext-credential-host'
  | 'no-policy';

/** The reason given for reaching a credential host in the clear. */
export const PLAINTEXT_CREDENTIAL_REASON = 'a credential host may only be reached over https';

/** The reason given while the proxy is still waiting for its first policy. */
const NO_POLICY_REASON = 'the proxy has no policy yet';

/** Where a request wants to go. */
export interface Target {
  host: string;
  port: number;
}

/** Splits an authority into host and port, or null if it is malformed. */
export function parseHostPort(authority: string, defaultPort: number): Target | null {
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

/** The outcome of vetting a target. */
export type Verdict =
  | { ok: true; address: string; family: number }
  | { ok: false; category: DenialCategory; reason: string };

/**
 * Vets a target and returns the single address to pin the connection to. An IP
 * literal is checked as it stands; a hostname is resolved first and every
 * answer has to pass. The allowlist is checked first, so a denied host is
 * never looked up.
 */
export async function vetTarget(target: Target, policy: EgressPolicy): Promise<Verdict> {
  if (!ALLOWED_PORTS.has(target.port)) {
    return { ok: false, category: 'port', reason: `port ${target.port} not allowed` };
  }
  if (!hostAllowed(target.host, policy)) {
    return { ok: false, category: 'allowlist', reason: 'host is not on the egress allowlist' };
  }

  // An IP literal skips DNS but goes through the identical CIDR check.
  const literalFamily = net.isIP(target.host);
  if (literalFamily !== 0) {
    if (isBlockedAddress(target.host)) {
      return {
        ok: false,
        category: 'blocked-address',
        reason: 'target address is in a blocked range',
      };
    }
    return { ok: true, address: target.host, family: literalFamily };
  }

  let answers: dns.LookupAddress[];
  try {
    answers = await dns.promises.lookup(target.host, { all: true });
  } catch (err) {
    return {
      ok: false,
      category: 'dns',
      reason: `DNS lookup failed: ${(err as Error).message}`,
    };
  }

  const chosen = answers[0];
  if (!chosen) return { ok: false, category: 'dns', reason: 'no addresses resolved' };
  if (!allAddressesAllowed(answers.map((a) => a.address))) {
    // Rejecting when any answer is private closes DNS rebinding: a hostname
    // must not pass with a public record and connect with a private one.
    return {
      ok: false,
      category: 'blocked-address',
      reason: 'hostname resolves to a blocked address',
    };
  }
  return { ok: true, address: chosen.address, family: chosen.family };
}

/** What a forwarding server needs from the process around it. */
export interface ForwardOptions {
  /** The live policy, read per request so a push takes effect at once. */
  policy: () => EgressPolicy;
  /**
   * Loopback port of the TLS engine, or null when this server never
   * intercepts. The upstream tunnel passes null, which is what keeps the
   * engine's own connections from looping back into it.
   */
  interceptPort: () => number | null;
  /** Whether a policy has been pushed. Nothing is forwarded before it has. */
  applied: () => boolean;
  /** Records a denial, by category. */
  denied: (category: DenialCategory) => void;
  /** Structured logging. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Answers a forwarded request with a 403 and the reason. */
function deny(res: http.ServerResponse, reason: string): void {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`egress denied: ${reason}\n`);
}

/** Headers that describe one hop rather than the request, so are not passed on. */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Copies the headers that may go on to the origin. The Connection header names
 * further headers that end at this hop, and every name is compared in lower
 * case.
 */
export function forwardableHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const drop = new Set(HOP_BY_HOP_HEADERS);
  const connection = headers['connection'];
  const named = Array.isArray(connection) ? connection.join(',') : (connection ?? '');
  for (const name of named.split(',')) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed !== '') drop.add(trimmed);
  }

  const kept: http.IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (drop.has(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * Builds a forward proxy: absolute-URI HTTP on port 80, CONNECT for
 * everything else. The server is returned before it listens.
 */
export function createForwardServer(opts: ForwardOptions): http.Server {
  const server = http.createServer();

  // --- absolute-URI plain HTTP (port 80) ------------------------------------

  server.on('request', (req, res) => {
    if (!opts.applied()) {
      // An empty policy allows every public host, so nothing may pass before
      // the orchestrator has said what this proxy is for.
      opts.denied('no-policy');
      opts.log('denied http request', { reason: NO_POLICY_REASON });
      deny(res, NO_POLICY_REASON);
      return;
    }

    const rawUrl = req.url ?? '';
    if (!/^https?:\/\//i.test(rawUrl)) {
      // A non-absolute request URI addresses this process as an origin server.
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
      // https must arrive as CONNECT: plaintext forwarding never terminates TLS.
      deny(res, 'only http:// may be forwarded; use CONNECT for https');
      return;
    }

    const target = parseHostPort(url.host, 80);
    if (!target) {
      deny(res, 'malformed host');
      return;
    }

    if (req.headers['upgrade']) {
      // A forwarded upgrade would leave this proxy with a protocol it cannot
      // vet, and the request would never reach its response callback.
      res.writeHead(501, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('protocol upgrades are not forwarded\n');
      return;
    }

    const policy = opts.policy();
    if (opts.interceptPort() !== null && isInjectionHost(target.host, policy)) {
      // A credential host reached in the clear would leak the placeholder, or
      // invite injecting the real secret into plaintext. These hosts serve
      // https anyway.
      opts.denied('plaintext-credential-host');
      opts.log('denied http request', {
        host: target.host,
        reason: PLAINTEXT_CREDENTIAL_REASON,
      });
      deny(res, PLAINTEXT_CREDENTIAL_REASON);
      return;
    }

    void vetTarget(target, policy).then((verdict) => {
      if (!verdict.ok) {
        opts.denied(verdict.category);
        opts.log('denied http request', {
          host: target.host,
          port: target.port,
          reason: verdict.reason,
        });
        deny(res, verdict.reason);
        return;
      }
      // The client may be gone by the time the vetting lands.
      if (res.destroyed) return;

      const headers = forwardableHeaders(req.headers);
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
        opts.log('upstream http error', { host: target.host, error: err.message });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('upstream error\n');
      });
      // A client that hangs up must not leave the request to the origin running.
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
  });

  // --- CONNECT tunnel (port 443) --------------------------------------------

  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    const refuse = (code: number, reason: string): void => {
      try {
        clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
      } catch {
        // client already gone
      }
      clientSocket.destroy();
    };

    if (!opts.applied()) {
      // An empty policy allows every public host, so nothing may pass before
      // the orchestrator has said what this proxy is for.
      opts.denied('no-policy');
      opts.log('denied CONNECT', { reason: NO_POLICY_REASON });
      refuse(403, 'Forbidden');
      return;
    }

    const target = parseHostPort(req.url ?? '', 443);
    if (!target) {
      refuse(400, 'Bad Request');
      return;
    }

    const policy = opts.policy();
    void vetTarget(target, policy).then((verdict) => {
      if (!verdict.ok) {
        opts.denied(verdict.category);
        opts.log('denied CONNECT', {
          host: target.host,
          port: target.port,
          reason: verdict.reason,
        });
        refuse(403, 'Forbidden');
        return;
      }

      const enginePort = opts.interceptPort();
      if (enginePort !== null && isInjectionHost(target.host, policy)) {
        if (target.port !== 443) {
          // Whatever a tunnel to another port carries is not https, so the
          // engine would meet plaintext and swap the real credential into it.
          opts.denied('plaintext-credential-host');
          opts.log('denied CONNECT', {
            host: target.host,
            port: target.port,
            reason: PLAINTEXT_CREDENTIAL_REASON,
          });
          refuse(403, 'Forbidden');
          return;
        }
        connectToEngine(target, enginePort, clientSocket, head, opts);
        return;
      }

      // Once the tunnel is established the client may be speaking TLS, so a
      // later failure closes it rather than writing a status line into it.
      let established = false;
      const upstream = net.connect(
        { host: verdict.address, port: target.port, family: verdict.family },
        () => {
          established = true;
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
        opts.log('upstream CONNECT error', { host: target.host, error: err.message });
        if (established) clientSocket.destroy();
        else refuse(502, 'Bad Gateway');
        upstream.destroy();
      });
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
    });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/**
 * Hands an intercepted CONNECT to the TLS engine on loopback.
 *
 * The CONNECT is replayed rather than the socket spliced, so the engine
 * learns the destination and picks the certificate for the host the client
 * asked for.
 */
function connectToEngine(
  target: Target,
  enginePort: number,
  clientSocket: net.Socket,
  head: Buffer,
  opts: ForwardOptions,
): void {
  const authority = `${target.host}:${target.port}`;
  const engine = net.connect({ host: '127.0.0.1', port: enginePort }, () => {
    engine.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });

  // Once the tunnel is established the client is speaking TLS, so a late
  // failure has to close it rather than write a status line into the stream.
  let established = false;
  const failed = (reason: string): void => {
    clearTimeout(handshake);
    opts.log('interception failed', { host: target.host, reason });
    if (!established) {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        // client already gone
      }
    }
    clientSocket.destroy();
    engine.destroy();
  };

  const handshake = setTimeout(() => failed('engine did not answer the CONNECT'), INTERCEPT_HANDSHAKE_MS);
  handshake.unref?.();

  let banner = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    banner = Buffer.concat([banner, chunk]);
    const end = banner.indexOf('\r\n\r\n');
    if (end === -1) {
      if (banner.length > 8192) failed('engine sent an oversized CONNECT reply');
      return;
    }
    clearTimeout(handshake);
    engine.off('data', onData);

    const status = banner.subarray(0, banner.indexOf('\r\n')).toString('latin1');
    if (!/^HTTP\/1\.[01] 200/.test(status)) {
      failed(`engine refused the CONNECT: ${status}`);
      return;
    }

    established = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Anything the engine sent past its own reply belongs to the client.
    const rest = banner.subarray(end + 4);
    if (rest.length > 0) clientSocket.write(rest);
    if (head.length > 0) engine.write(head);
    engine.pipe(clientSocket);
    clientSocket.pipe(engine);
  };

  engine.on('data', onData);
  engine.setTimeout(IDLE_TIMEOUT_MS, () => engine.destroy());
  engine.on('error', (err) => failed(err.message));
  clientSocket.on('error', () => engine.destroy());
  clientSocket.on('close', () => engine.destroy());
}
