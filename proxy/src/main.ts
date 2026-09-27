import type { Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { EgressPolicy, EgressStatus } from '../../shared/types.ts';
import { createControlServer, resolveControlAddress } from './control.ts';
import { ALLOWED_PORTS, createForwardServer, type DenialCategory } from './forward.ts';
import { Interceptor } from './inject.ts';
import { EMPTY_POLICY, injectionPatterns, policyHash } from './policy.ts';

/**
 * Entry point of the egress proxy, the only way out of every box network.
 *
 * Box networks are internal, so this process, attached to each of them, is
 * the only thing an agent can reach. It keeps its whole state in memory and
 * holds no secret at rest.
 */

/** Writes one JSON line to stderr. */
function log(msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), msg, ...fields })}\n`,
  );
}

/** Reports a setting the proxy cannot start with, and stops. */
function fatalConfig(message: string): never {
  log('fatal config error', { error: message });
  process.exit(1);
}

/**
 * Reads a port from the environment. Anything that is not a port number stops
 * the proxy, because a silently wrong port binds somewhere nobody is looking.
 */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fatalConfig(`${name} must be a whole number between 1 and 65535, not ${raw}`);
  }
  return value;
}

/** Port the proxy listens on, facing the boxes. */
const PORT = portFromEnv('PORT', 3128);

/** Port the control channel listens on, facing the orchestrator. */
const CONTROL_PORT = portFromEnv('CONTROL_PORT', 3129);

/**
 * Address the control channel binds to. Left unset it is derived from the
 * default route, which is the compose network and not any box's.
 */
const CONTROL_BIND = process.env['CONTROL_BIND']?.trim() ?? '';
if (CONTROL_BIND !== '' && net.isIP(CONTROL_BIND) === 0) {
  fatalConfig(`CONTROL_BIND must be an IP address, not ${CONTROL_BIND}`);
}

// --- state --------------------------------------------------------------------

/** The live policy. Empty until the orchestrator pushes one. */
let policy: EgressPolicy = EMPTY_POLICY;

/** False until a policy has been pushed, however empty that policy is. */
let applied = false;

/**
 * Denials since boot, by category, reported on the control channel. The
 * categories are a fixed set, so a box cannot grow this map or put a
 * hostname of its choice into the status.
 */
const denials = new Map<DenialCategory, number>();

/** When this process started, for the uptime it reports. */
const bootedAt = Date.now();

/** Counts one denial under its category. */
function denied(category: DenialCategory): void {
  denials.set(category, (denials.get(category) ?? 0) + 1);
}

/** What the proxy reports on the control channel. */
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
 * The upstream tunnel, on loopback. The engine sends every connection through
 * it, so decrypted traffic gets the same checks. It never intercepts, so the
 * engine's connections do not loop back into the engine.
 */
const upstream = createForwardServer({
  policy: () => policy,
  interceptPort: () => null,
  applied: () => applied,
  denied,
  log: (msg, fields) => log(msg, { via: 'upstream', ...fields }),
});

/** Port the upstream tunnel listens on, known once it is bound. */
let upstreamPort = 0;

/**
 * The interception engine. It terminates TLS for the hosts that have a
 * credential, under the deployment CA, and swaps the box's placeholder for
 * the real credential.
 */
const interceptor = new Interceptor({
  policy: () => policy,
  upstreamProxyUrl: () => `http://127.0.0.1:${upstreamPort}`,
  denied,
  log,
});

/**
 * The front door, facing the boxes. It vets every destination, then either
 * tunnels it opaquely or hands it to the interception engine.
 */
const front = createForwardServer({
  policy: () => policy,
  interceptPort: () => interceptor.port(),
  applied: () => applied,
  denied,
  log,
});

/** The push in flight, so no two of them are swapping the policy at once. */
let pushes: Promise<void> = Promise.resolve();

/**
 * Runs one policy push once the push before it has finished, or failed.
 *
 * A push that the engine refuses puts the previous policy back. Without the
 * queue, that rollback could discard a policy another push had just applied.
 */
function queuePush(work: () => Promise<void>): Promise<void> {
  const next = pushes.then(work, work);
  // A failure belongs to the push that asked, not to the pushes behind it.
  pushes = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** The control channel, facing the orchestrator. */
const control = createControlServer({
  apply: (pushed) =>
    queuePush(async () => {
      const previous = policy;
      policy = pushed;
      try {
        await interceptor.apply();
      } catch (err) {
        // A policy the engine cannot run is rolled back whole, so no
        // credential is left configured that nothing can swap in.
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
    }),
  status,
  log,
});

// --- boot --------------------------------------------------------------------

/** Starts a server listening and resolves with the port it is bound to. */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Starts the three listeners, resolving the control bind address last. */
async function main(): Promise<void> {
  upstreamPort = await listen(upstream, 0, '127.0.0.1');
  log('upstream tunnel listening', { port: upstreamPort });

  await listen(front, PORT, '0.0.0.0');
  log('egress proxy listening', { port: PORT, allowedPorts: [...ALLOWED_PORTS] });

  const bind = CONTROL_BIND || (await resolveControlAddress());
  if (bind === null) {
    // Binding wide would publish a secret-bearing endpoint to every box
    // network. Loopback keeps it unreachable, and the orchestrator's failed
    // pushes show up in /healthz.
    log('WARNING: could not resolve the control interface; binding to loopback only');
  }
  await listen(control.server, CONTROL_PORT, bind ?? '127.0.0.1');
  log('control channel listening', { port: CONTROL_PORT, address: bind ?? '127.0.0.1' });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('shutting down', { signal });
    // Closing the front door waits for every tunnel through it, and a busy one
    // must not keep the process alive.
    setTimeout(() => process.exit(0), 5_000).unref();
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
