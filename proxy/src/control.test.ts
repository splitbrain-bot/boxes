import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EgressPolicy, EgressStatus } from '../../shared/types.ts';
import { createControlServer } from './control.ts';

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

  it('answers anything else with a 404', async () => {
    const { port } = await start();
    expect((await call(port, 'GET', '/secrets', 'token')).status).toBe(404);
    expect((await call(port, 'POST', '/status', 'token', {})).status).toBe(404);
  });
});
