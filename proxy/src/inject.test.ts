import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EgressPolicy } from '../../shared/types.ts';
import { Interceptor } from './inject.ts';

/**
 * The swap and the refusal, driven through the real interception engine.
 *
 * A session reaches a credential host over TLS, so that is how these tests
 * reach the engine. The engine's own upstream is pointed at a stand-in for the
 * vetting tunnel, so they need no network: what is under test is what the
 * proxy adds — that a placeholder becomes the real credential, that anything
 * else is refused here rather than forwarded, and that the certificate a
 * session sees is the deployment's.
 */

const PLACEHOLDER = 'ghp_PLACEHOLDERPLACEHOLDER';
const SECRET = 'ghp_therealsecretvalue';

let ca: { key: string; cert: string };

/** Records what actually arrived upstream. */
let received: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

/** A TLS origin standing in for the host being protected. */
let origin: https.Server;
let originPort = 0;

/**
 * A stand-in for the upstream tunnel: it forwards to the origin instead of
 * vetting and resolving, so no test here touches DNS or the network.
 */
let tunnel: http.Server;
let tunnelPort = 0;

let interceptor: Interceptor;
let policy: EgressPolicy;

/** How many times the engine has reported that it started. */
let starts = 0;

/** The unwrapped TLS client, for the connections these tests make themselves. */
const connectTls = tls.connect;

/** An answer read back from the engine. */
interface Answer {
  status: number;
  body: string;
}

const listen = (server: http.Server | https.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });

/**
 * Lets the engine reach the stand-in origin over TLS.
 *
 * The engine checks the certificate of the host it forwards to against the
 * system trust store, which a test cannot add a CA to, and the stand-in origin
 * serves a certificate of its own. Wrapping the TLS client is the way in: a
 * connection that names no CA is the engine's and skips the check, while the
 * connections these tests make call the unwrapped client above.
 */
function trustTheStandInOrigin(): void {
  const relaxed = (options: tls.ConnectionOptions, onSecure?: () => void): tls.TLSSocket =>
    connectTls(options.ca ? options : { ...options, rejectUnauthorized: false }, onSecure);
  tls.connect = relaxed as typeof tls.connect;
}

beforeAll(async () => {
  ca = await generateCACertificate({ subject: { commonName: 'Boxes test CA' } });
  trustTheStandInOrigin();

  origin = https.createServer({ key: ca.key, cert: ca.cert }, (req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin reached\n');
  });
  originPort = await listen(origin);

  // The engine reaches its proxy by CONNECT, whatever the target scheme.
  tunnel = http.createServer();
  tunnel.on('connect', (_req, client, head) => {
    const upstream = net.connect({ host: '127.0.0.1', port: originPort }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  tunnelPort = await listen(tunnel);

  interceptor = new Interceptor({
    policy: () => policy,
    upstreamProxyUrl: () => `http://127.0.0.1:${tunnelPort}`,
    denied: () => {},
    log: (msg) => {
      if (msg === 'interception engine started') starts += 1;
    },
  });
}, 30_000);

afterEach(() => {
  received = [];
});

afterAll(async () => {
  await interceptor.stop();
  origin.close();
  tunnel.close();
  tls.connect = connectTls;
});

/** The policy under test, with one credential on one host. */
function githubPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    allowedHosts: [],
    ca,
    credentials: [
      {
        id: 'github',
        hosts: ['api.github.com'],
        headers: ['authorization'],
        placeholder: PLACEHOLDER,
        secret: SECRET,
      },
    ],
    ...over,
  };
}

/** Opens a tunnel through the engine to one host, as a session's client does. */
function tunnelThroughEngine(
  port: number,
  authority: string,
  host = '127.0.0.1',
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      socket.once('data', () => resolve(socket));
    });
    socket.on('error', reject);
  });
}

/** Sends a request through the engine over TLS and reads the answer. */
async function throughEngine(
  port: number,
  headers: http.OutgoingHttpHeaders,
  host = 'api.github.com',
  path = '/user',
  engineHost = '127.0.0.1',
): Promise<Answer> {
  const socket = await tunnelThroughEngine(port, `${host}:443`, engineHost);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        // With no agent, the request goes down this connection and closes it.
        createConnection: () => connectTls({ socket, servername: host, ca: ca.cert }),
        host,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}


/**
 * Asks the engine to upgrade a connection, and answers with the status it
 * refused with. A rejection arrives as a response rather than as an upgrade,
 * so the status line is the whole of what this needs.
 */
async function upgradeThroughEngine(
  port: number,
  host = 'api.github.com',
  path = '/v1/responses',
): Promise<Answer> {
  const socket = await tunnelThroughEngine(port, `${host}:443`, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const req = https.request({
      createConnection: () => connectTls({ socket, servername: host, ca: ca.cert }),
      host,
      path,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'uay0UrT0EHqIs+QoxwgNtQ==',
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, body: res.statusMessage ?? '' });
    });
    req.on('upgrade', () => resolve({ status: 101, body: '' }));
    req.on('error', reject);
    req.end();
  });
}

/** Sends a plain proxy request straight at the engine and reads the answer. */
function plainThroughEngine(
  port: number,
  headers: http.OutgoingHttpHeaders,
  url = 'http://api.github.com/user',
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: 'api.github.com', ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Whether anything still answers on a loopback port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

describe('the interception engine', () => {
  it('starts only when there is both a CA and a credential to translate', async () => {
    policy = githubPolicy({ ca: null, credentials: [] });
    await interceptor.apply();
    expect(interceptor.port()).toBeNull();

    policy = githubPolicy({ credentials: [] });
    await interceptor.apply();
    expect(interceptor.port()).toBeNull();

    policy = githubPolicy();
    await interceptor.apply();
    expect(interceptor.port()).toBeGreaterThan(0);
  }, 30_000);

  it('swaps the placeholder for the real credential on the wire', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {
      authorization: `Bearer ${PLACEHOLDER}`,
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  }, 30_000);

  it('refuses a protocol upgrade rather than forwarding it unswapped', async () => {
    // The swap is a header rewrite and the engine's websocket passthrough
    // cannot do one, so a forwarded upgrade would carry the box's
    // placeholder to the far end. Refused here instead, and with a status of
    // its own: without a rule the engine answers its own "no rules matched",
    // which is the same refusal by accident and reads as a broken
    // deployment. A client that wanted one falls back to HTTPS, where the
    // swap works.
    policy = githubPolicy();
    await interceptor.apply();

    const res = await upgradeThroughEngine(interceptor.port()!);

    expect(res.status).toBe(501);
    // On the status line, which is what a rejected upgrade carries.
    expect(res.body).toContain('protocol upgrades are not forwarded');
    // Nothing reached the far end: the placeholder did not leave the box.
    expect(received).toHaveLength(0);
  }, 30_000);

  it('refuses a caller that did not come through the front door', async () => {
    // The engine's own listener takes every interface, and the proxy sits on
    // every session network, so a box can open this port directly. Reaching it
    // that way skips the front door's rules about which hosts and ports may be
    // intercepted at all, so the engine refuses anything not from loopback.
    const outward = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!outward) return; // nothing but loopback here; nothing to prove

    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: `Bearer ${PLACEHOLDER}` },
      'api.github.com',
      '/user',
      outward,
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatch(/front door|reachable from the proxy only/);
    expect(received).toHaveLength(0);
  }, 30_000);

  it('refuses a foreign credential here instead of forwarding it', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {
      authorization: 'Bearer ghp_someoneElsesToken',
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatch(/foreign credential/);
    // The point of denying here: nothing reached the host.
    expect(received).toHaveLength(0);
  }, 30_000);

  it('leaves an unauthenticated request alone', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(interceptor.port()!, {});

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBeUndefined();
  }, 30_000);

  it('refuses a credential host reached in the clear', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await plainThroughEngine(interceptor.port()!, {
      authorization: `Bearer ${PLACEHOLDER}`,
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatch(/a credential host may only be reached over https/);
    // Neither the placeholder nor the secret may travel as plaintext.
    expect(received).toHaveLength(0);
  }, 30_000);

  it('does not touch a host that has no credential configured', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: 'Bearer whatever' },
      'example.com',
      '/',
    );

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBe('Bearer whatever');
  }, 30_000);

  it('presents the deployment CA to an intercepted TLS client, and still refuses', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    // The shape of a real session: CONNECT, then TLS under the deployment CA.
    const socket = await tunnelThroughEngine(interceptor.port()!, 'api.github.com:443');
    const secure = connectTls({ socket, servername: 'api.github.com', ca: ca.cert });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    expect(secure.authorized).toBe(true);
    expect(secure.getPeerCertificate().subject.CN).toBe('api.github.com');

    secure.write(
      'GET /user HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer nope\r\nConnection: close\r\n\r\n',
    );
    const answer = await new Promise<string>((resolve) => {
      let body = '';
      secure.on('data', (c) => (body += c));
      secure.on('end', () => resolve(body));
    });
    expect(answer).toMatch(/^HTTP\/1\.1 403/);
    expect(received).toHaveLength(0);
    secure.destroy();
  }, 30_000);

  it('stops decrypting as soon as the policy drops its credentials', async () => {
    policy = githubPolicy();
    await interceptor.apply();
    expect(interceptor.port()).toBeGreaterThan(0);

    policy = githubPolicy({ credentials: [] });
    await interceptor.apply();
    expect(interceptor.port()).toBeNull();
  }, 30_000);

  it('runs overlapping applies one after another, with no port gap', async () => {
    policy = githubPolicy();
    await interceptor.apply();
    const before = interceptor.port();
    expect(before).toBeGreaterThan(0);

    // A changed CA is what makes an apply replace the running server.
    const other = await generateCACertificate({ subject: { commonName: 'Boxes other CA' } });
    policy = githubPolicy({ ca: other });
    starts = 0;
    const seen: Array<number | null> = [];
    const sampler = setInterval(() => seen.push(interceptor.port()), 1);
    await Promise.all([interceptor.apply(), interceptor.apply()]);
    clearInterval(sampler);

    // Two servers would mean one nobody can stop, and a gap would mean the
    // front door tunnelling a credential host past the engine.
    expect(starts).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(null);
    expect(interceptor.port()).toBeGreaterThan(0);
    expect(await listening(before!)).toBe(false);
  }, 30_000);
});
