import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EgressPolicy } from '../../shared/types.ts';
import { Interceptor } from './inject.ts';

/**
 * The swap and the refusal, driven through the real interception engine.
 *
 * The engine's own upstream is pointed at a stand-in for the vetting tunnel,
 * so these tests need no network: what is under test is what the proxy adds —
 * that a placeholder becomes the real credential, that anything else is
 * refused here rather than forwarded, and that the certificate a session sees
 * is the deployment's.
 */

const PLACEHOLDER = 'ghp_PLACEHOLDERPLACEHOLDER';
const SECRET = 'ghp_therealsecretvalue';

let ca: { key: string; cert: string };

/** Records what actually arrived upstream. */
let received: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

/** A plain origin standing in for the host being protected. */
let origin: http.Server;
let originPort = 0;

/**
 * A stand-in for the upstream tunnel: it forwards to the origin instead of
 * vetting and resolving, so no test here touches DNS or the network.
 */
let tunnel: http.Server;
let tunnelPort = 0;

let interceptor: Interceptor;
let policy: EgressPolicy;

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });

beforeAll(async () => {
  ca = await generateCACertificate({ subject: { commonName: 'Boxes test CA' } });

  origin = http.createServer((req, res) => {
    received.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('origin reached\n');
  });
  originPort = await listen(origin);

  tunnel = http.createServer((req, res) => {
    const url = new URL(req.url ?? '');
    const upstream = http.request(
      { host: '127.0.0.1', port: originPort, method: req.method, path: url.pathname, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  // The engine reaches its proxy by CONNECT, whatever the target scheme.
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
    log: () => {},
  });
}, 30_000);

afterEach(() => {
  received = [];
});

afterAll(async () => {
  await interceptor.stop();
  origin.close();
  tunnel.close();
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

/** Sends a plain proxy request straight at the engine and reads the answer. */
function throughEngine(
  port: number,
  headers: http.OutgoingHttpHeaders,
  url = 'http://api.github.com/user',
): Promise<{ status: number; body: string }> {
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

  it('does not touch a host that has no credential configured', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    const res = await throughEngine(
      interceptor.port()!,
      { authorization: 'Bearer whatever', host: 'example.com' },
      'http://example.com/',
    );

    expect(res.status).toBe(200);
    expect(received[0]?.headers.authorization).toBe('Bearer whatever');
  }, 30_000);

  it('presents the deployment CA to an intercepted TLS client, and still refuses', async () => {
    policy = githubPolicy();
    await interceptor.apply();

    // The shape of a real session: CONNECT, then TLS under the deployment CA.
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: interceptor.port()! }, () => {
        s.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n');
        s.once('data', () => resolve(s));
      });
      s.on('error', reject);
    });

    const secure = tls.connect({ socket, servername: 'api.github.com', ca: ca.cert });
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
});
