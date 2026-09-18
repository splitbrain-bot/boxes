import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EgressPolicy, EgressStatus } from '../../shared/types.ts';
import { createControlServer } from './control.ts';
import { policyHash } from './policy.ts';

/**
 * The control channel, which is how the proxy gets a policy without a file and
 * how it stays uninteresting to anything that cannot reach the orchestrator's
 * network.
 */

const CA = { key: 'KEY', cert: 'CERT' };

const emptyStatus: EgressStatus = {
  applied: false,
  policyHash: 'hash',
  allowedHostCount: 0,
  credentialIds: [],
  denials: {},
  uptimeSeconds: 0,
};

let servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

/** A control server listening on loopback, with the policies it accepted. */
async function start(
  reject?: string,
): Promise<{ port: number; applied: EgressPolicy[]; claimed: () => boolean }> {
  const applied: EgressPolicy[] = [];
  const control = createControlServer({
    apply: async (policy) => {
      if (reject) throw new Error(reject);
      applied.push(policy);
    },
    status: () => ({ ...emptyStatus, applied: applied.length > 0 }),
    log: () => {},
  });
  servers.push(control.server);
  const port = await new Promise<number>((resolve) => {
    control.server.listen(0, '127.0.0.1', () =>
      resolve((control.server.address() as AddressInfo).port),
    );
  });
  return { port, applied, claimed: control.claimed };
}

/** One control-channel call. */
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

const policy = {
  allowedHosts: ['github.com'],
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

  it('refuses a malformed policy without applying anything', async () => {
    const { port, applied } = await start();
    const res = await call(port, 'POST', '/policy', 'token', { allowedHosts: ['*'] });
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

  it('answers anything else with a 404, and is claimed by none of it', async () => {
    const { port, claimed } = await start();
    // Only a policy push may claim the channel, so every other path is
    // unauthorized until one has.
    expect((await call(port, 'GET', '/secrets', 'token')).status).toBe(401);
    expect(claimed()).toBe(false);

    expect((await call(port, 'POST', '/policy', 'token', policy)).status).toBe(200);
    expect((await call(port, 'GET', '/secrets', 'token')).status).toBe(404);
    expect((await call(port, 'POST', '/status', 'token', {})).status).toBe(404);
  });
});

/**
 * A listener that binds nothing, so importing the proxy's entry point starts
 * no server and takes no port.
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
 * How the proxy's entry point handles two pushes at once.
 *
 * The listeners and the interception engine are stood in for, so what is
 * under test is the entry point's own policy handling: everything else it
 * boots is a shell that binds nothing.
 */
describe('overlapping policy pushes', () => {
  it('leave the policy of the push that succeeded', async () => {
    let engineCalls = 0;
    let livePolicy: () => EgressPolicy = () => policy as EgressPolicy;
    let push: (pushed: EgressPolicy) => Promise<void> = async () => {};
    let liveStatus: () => EgressStatus = () => emptyStatus;

    vi.doMock('./forward.ts', () => ({
      ALLOWED_PORTS: new Set([443]),
      createForwardServer: () => fakeServer(),
    }));
    vi.doMock('./inject.ts', () => ({
      // The first call refuses, which is what makes the first push roll back,
      // and the delay is what makes the two pushes overlap.
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
    const wanted: EgressPolicy = { ...refused, allowedHosts: ['example.com'] };
    const first = push(refused).catch(() => undefined);
    const second = push(wanted);
    await Promise.all([first, second]);

    // The first push rolls its own policy back. Rolling back over the second
    // one would leave the proxy running a policy nobody pushed, and saying it
    // had applied one.
    expect(livePolicy()).toEqual(wanted);
    expect(liveStatus().policyHash).toBe(policyHash(wanted));
  });
});
