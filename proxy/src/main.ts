import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EgressPolicy, EgressStatus } from '../../shared/types.ts';
import { createControlServer, resolveControlAddress } from './control.ts';
import { ALLOWED_PORTS, createForwardServer } from './forward.ts';
import { Interceptor } from './inject.ts';
import { EMPTY_POLICY, injectionPatterns, policyHash } from './policy.ts';

/**
 * The sole egress path out of every session network.
 *
 * Session networks are internal Docker networks with no NAT and no default
 * route. This process is attached to each of them under the alias proxy, so it
 * is the only thing an agent can reach and the boundary between a session, the
 * LAN, and every other session.
 *
 * It runs three listeners:
 *
 *   - the front door, facing the sessions. It vets every destination and then
 *     either tunnels it opaquely or, for a host with a credential configured,
 *     hands it to the interception engine.
 *   - the interception engine, on loopback. It terminates TLS for those hosts
 *     under the deployment CA and swaps the session's placeholder for the real
 *     credential, refusing anything else.
 *   - the upstream tunnel, on loopback. Every connection the engine makes
 *     leaves through it, so one vetting path covers both routes out.
 *
 * It holds no secret at rest: no config file, no database, no CA on disk. It
 * boots with no policy at all and is given one over the control channel.
 */

/** Port the proxy listens on, facing the sessions. */
const PORT = Number(process.env['PORT'] ?? 3128);

/** Port the control channel listens on, facing the orchestrator. */
const CONTROL_PORT = Number(process.env['CONTROL_PORT'] ?? 3129);

/**
 * Address the control channel binds to. Left unset it is derived from the
 * default route, which is the compose network and not any session's.
 */
const CONTROL_BIND = process.env['CONTROL_BIND'] ?? '';

/** Writes one JSON line to stderr. */
function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`,
  );
}

// --- state: the whole of it, in memory ---------------------------------------

/** Empty until the orchestrator pushes, which is today's behavior. */
let policy: EgressPolicy = EMPTY_POLICY;

/** False until a policy has been pushed, however empty that policy is. */
let applied = false;

/** Denials since boot, by reason, reported back on the control channel. */
const denials = new Map<string, number>();

const bootedAt = Date.now();

function denied(reason: string): void {
  denials.set(reason, (denials.get(reason) ?? 0) + 1);
}

function status(): EgressStatus {
  return {
    applied,
    policyHash: policyHash(policy),
    allowedHostCount: policy.allowedHosts.length,
    credentialIds: policy.credentials.map((c) => c.id),
    denials: Object.fromEntries(denials),
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
  };
}

// --- the three listeners -----------------------------------------------------

/**
 * The upstream tunnel. It never intercepts, which is what stops the engine's
 * own connections from arriving back at the engine.
 */
const upstream = createForwardServer({
  policy: () => policy,
  interceptPort: () => null,
  denied,
  log: (msg, fields) => log(msg, { via: 'upstream', ...fields }),
});

let upstreamPort = 0;

const interceptor = new Interceptor({
  policy: () => policy,
  upstreamProxyUrl: () => `http://127.0.0.1:${upstreamPort}`,
  denied,
  log,
});

const front = createForwardServer({
  policy: () => policy,
  interceptPort: () => interceptor.port(),
  denied,
  log,
});

const control = createControlServer({
  apply: async (pushed) => {
    const previous = policy;
    policy = pushed;
    try {
      await interceptor.apply();
    } catch (err) {
      // A policy the engine cannot run is not applied at all, rather than
      // half-applied with credentials nothing can swap in.
      policy = previous;
      await interceptor.apply().catch(() => undefined);
      throw new Error(`could not apply policy: ${(err as Error).message}`);
    }
    applied = true;
    log('applied policy', {
      hash: policyHash(policy),
      allowedHosts: policy.allowedHosts.length,
      credentials: policy.credentials.map((c) => c.id),
      intercepting: injectionPatterns(policy),
    });
  },
  status,
  log,
});

// --- boot --------------------------------------------------------------------

/** Listens on a server and resolves with the port it actually got. */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function main(): Promise<void> {
  upstreamPort = await listen(upstream, 0, '127.0.0.1');
  log('upstream tunnel listening', { port: upstreamPort });

  await listen(front, PORT, '0.0.0.0');
  log('egress proxy listening', { port: PORT, allowedPorts: [...ALLOWED_PORTS] });

  const bind = CONTROL_BIND || (await resolveControlAddress());
  if (bind === null) {
    // Binding wide would publish a secret-bearing endpoint to every session
    // network. Loopback keeps it unreachable, and the orchestrator's failed
    // pushes say so loudly in /healthz.
    log('WARNING: could not resolve the control interface; binding to loopback only');
  }
  await listen(control.server, CONTROL_PORT, bind ?? '127.0.0.1');
  log('control channel listening', { port: CONTROL_PORT, address: bind ?? '127.0.0.1' });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutting down', { signal });
    void interceptor.stop().finally(() => {
      control.server.close();
      upstream.close();
      front.close(() => process.exit(0));
    });
  });
}

main().catch((err: Error) => {
  log('fatal boot error', { error: err.message });
  process.exit(1);
});
