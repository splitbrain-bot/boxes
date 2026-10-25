/** Tests for the control channel and for the policy push queue of the entry point. */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EgressDenial,
  EgressPolicy,
  EgressRefusedToken,
  EgressStatus,
} from '../../shared/types.ts';
import { createControlServer } from './control.ts';
import { policyHash } from './policy.ts';

/** A stand-in CA, which parsePolicy needs for a policy with credentials. */
const CA = { key: 'KEY', cert: 'CERT' };

/** Status of a proxy that has applied nothing. */
const emptyStatus: EgressStatus = {
  applied: false,
  policyHash: 'hash',
  boxCount: 0,
  credentialIds: [],
  denials: {},
  uptimeSeconds: 0,
};

/** Servers the current test started, closed after it. */
let servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

/** The refused targets that the stand-in denials callback returns for the box box-1. */
const refusedTargets: EgressDenial[] = [
  { host: 'evil.com', port: 443, category: 'allowlist', count: 2, lastAt: 2000 },
  { host: 'example.com', port: 22, category: 'port', count: 1, lastAt: 1000 },
];

/**
 * Starts a control server on loopback.
 *
 * @param reject When set, every push fails with this message.
 * @returns The port, the accepted policies, the claim state, the box ids that the denials callback got, and the
 *   list of refused tokens that the next push takes.
 */
async function start(reject?: string): Promise<{
  port: number;
  applied: EgressPolicy[];
  claimed: () => boolean;
  asked: string[];
  refused: EgressRefusedToken[];
}> {
  const applied: EgressPolicy[] = [];
  const asked: string[] = [];
  const refused: EgressRefusedToken[] = [];
  const control = createControlServer({
    apply: async (policy) => {
      if (reject) throw new Error(reject);
      applied.push(policy);
    },
    status: () => ({ ...emptyStatus, applied: applied.length > 0 }),
    takeRefusedTokens: () => refused.splice(0),
    denials: (box) => {
      asked.push(box);
      return box === 'box-1' ? refusedTargets : [];
    },
    log: () => {},
  });
  servers.push(control.server);
  const port = await new Promise<number>((resolve) => {
    control.server.listen(0, '127.0.0.1', () =>
      resolve((control.server.address() as AddressInfo).port),
    );
  });
  return { port, applied, claimed: control.claimed, asked, refused };
}

/**
 * Sends one request to the control channel and reads the answer.
 *
 * @param port The port of the control server.
 * @param method The HTTP method.
 * @param path The request path.
 * @param token The bearer token, or null to send no Authorization header.
 * @param body The request body, sent as JSON when set.
 * @returns The status code and the body of the answer.
 */
function call(
  port: number,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A valid policy with one box and one credential. */
const policy = {
  boxes: [{ box: 'box-1', token: 'a'.repeat(64), open: false, hosts: ['github.com'] }],
  ca: CA,
  credentials: [
    {
      id: 'github',
      hosts: ['github.com'],
      headers: ['authorization'],
      placeholder: 'ghp_PLACEHOLDER',
      secret: 'ghp_secret',
    },
  ],
};

describe('the control channel', () => {
  it('is claimed by its first caller and closed to every other token after', async () => {
    const { port, applied, claimed } = await start();
    expect(claimed()).toBe(false);

    expect((await call(port, 'POST', '/policy', 'first-token', policy)).status).toBe(200);
    expect(claimed()).toBe(true);
    expect(applied).toHaveLength(1);

    expect((await call(port, 'POST', '/policy', 'another-token', policy)).status).toBe(401);
    expect((await call(port, 'POST', '/policy', 'first-token', policy)).status).toBe(200);
    expect(applied).toHaveLength(2);
  });

  it('refuses a call with no bearer at all', async () => {
    const { port, claimed } = await start();
    expect((await call(port, 'GET', '/status', null)).status).toBe(401);
    // A refused call must not claim the channel.
    expect(claimed()).toBe(false);
  });

  it('reports status back on the same channel', async () => {
    const { port } = await start();
    await call(port, 'POST', '/policy', 'token', policy);
    const res = await call(port, 'GET', '/status', 'token');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ applied: true });
  });

  it('gives the refused tokens to the next push answer once', async () => {
    const { port, refused } = await start();
    const report = {
      credentialId: 'mcp/s1/docs/authorization',
      status: 401,
      error: null,
      scope: null,
    };
    refused.push(report);

    const first = await call(port, 'POST', '/policy', 'token', policy);
    expect(JSON.parse(first.body)).toMatchObject({ applied: true, refusedTokens: [report] });
    const second = await call(port, 'POST', '/policy', 'token', policy);
    expect(JSON.parse(second.body).refusedTokens).toEqual([]);
  });

  it('refuses a malformed policy without applying anything', async () => {
    const { port, applied } = await start();
    const res = await call(port, 'POST', '/policy', 'token', {
      boxes: [{ box: 'box-1', token: 'a'.repeat(64), open: false, hosts: ['*'] }],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/bare \*/);
    expect(applied).toHaveLength(0);
  });

  it('reports a policy the proxy could not run as a rejected push', async () => {
    const { port } = await start('engine would not start');
    const res = await call(port, 'POST', '/policy', 'token', policy);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/engine would not start/);
  });

  it('returns the refused targets of a box', async () => {
    const { port, asked } = await start();
    await call(port, 'POST', '/policy', 'token', policy);
    const res = await call(port, 'GET', '/denials?box=box-1', 'token');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(refusedTargets);
    const other = await call(port, 'GET', '/denials?box=box-2', 'token');
    expect(JSON.parse(other.body)).toEqual([]);
    expect(asked).toEqual(['box-1', 'box-2']);
  });

  it('answers a denials call without a box with a 400', async () => {
    const { port, asked } = await start();
    await call(port, 'POST', '/policy', 'token', policy);
    const res = await call(port, 'GET', '/denials', 'token');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/box/);
    expect((await call(port, 'GET', '/denials?box=', 'token')).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it('refuses a denials call without the token of the channel', async () => {
    const { port, asked } = await start();
    await call(port, 'POST', '/policy', 'token', policy);
    expect((await call(port, 'GET', '/denials?box=box-1', null)).status).toBe(401);
    expect((await call(port, 'GET', '/denials?box=box-1', 'another-token')).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it('answers anything else with a 404, and is claimed by none of it', async () => {
    const { port, claimed } = await start();
    // Only a policy push claims the channel, so any other path is a 401 until then.
    expect((await call(port, 'GET', '/secrets', 'token')).status).toBe(401);
    expect(claimed()).toBe(false);

    expect((await call(port, 'POST', '/policy', 'token', policy)).status).toBe(200);
    expect((await call(port, 'GET', '/secrets', 'token')).status).toBe(404);
    expect((await call(port, 'POST', '/status', 'token', {})).status).toBe(404);
  });
});

/**
 * Makes a fake listener that binds nothing, so importing the entry point of the
 * proxy starts no server and takes no port.
 *
 * @returns The fake server.
 */
function fakeServer(): http.Server {
  const server = new EventEmitter() as unknown as http.Server;
  server.listen = ((_port: number, _host: string, ready: () => void) => {
    ready();
    return server;
  }) as typeof server.listen;
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 1 });
  return server;
}

/**
 * Tests for two overlapping pushes into the entry point. The listeners, the
 * control server and the interception engine are mocked, so only the policy
 * handling runs.
 */
describe('overlapping policy pushes', () => {
  it('leave the policy of the push that succeeded', async () => {
    let engineCalls = 0;
    let livePolicy: () => EgressPolicy = () => policy as EgressPolicy;
    let push: (pushed: EgressPolicy) => Promise<void> = async () => {};
    let liveStatus: () => EgressStatus = () => emptyStatus;

    vi.doMock('./forward.ts', () => ({
      createForwardServer: () => fakeServer(),
    }));
    vi.doMock('./inject.ts', () => ({
      // The first call fails, so the first push rolls back. The delay makes the
      // two pushes overlap.
      Interceptor: class {
        constructor(opts: { policy: () => EgressPolicy }) {
          livePolicy = opts.policy;
        }
        apply(): Promise<void> {
          const refuses = ++engineCalls === 1;
          return new Promise((resolve, reject) => {
            setTimeout(() => (refuses ? reject(new Error('engine refused')) : resolve()), 5);
          });
        }
        port(): number | null {
          return null;
        }
        stop(): Promise<void> {
          return Promise.resolve();
        }
      },
    }));
    vi.doMock('./control.ts', () => ({
      createControlServer: (opts: { apply: typeof push; status: typeof liveStatus }) => {
        push = opts.apply;
        liveStatus = opts.status;
        return { server: fakeServer(), claimed: () => false };
      },
      resolveControlAddress: async () => '127.0.0.1',
    }));

    await import('./main.ts');

    const refused = policy as EgressPolicy;
    const wanted: EgressPolicy = {
      ...refused,
      boxes: [{ box: 'box-2', token: 'b'.repeat(64), open: true, hosts: [] }],
    };
    const first = push(refused).catch(() => undefined);
    const second = push(wanted);
    await Promise.all([first, second]);

    // The failed first push must not roll back over the second push's policy.
    expect(livePolicy()).toEqual(wanted);
    expect(liveStatus().policyHash).toBe(policyHash(wanted));
  });
});
