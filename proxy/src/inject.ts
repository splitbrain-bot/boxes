/** The TLS interception engine, the one place a real credential goes onto the wire. */

import type { CompletedRequest, Headers } from 'mockttp';
import * as mockttp from 'mockttp';
import type { EgressPolicy } from '../../shared/types.ts';
import { type DenialCategory, PLAINTEXT_CREDENTIAL_REASON } from './forward.ts';
import { credentialsForHost, decideCredentials, injectionPatterns } from './policy.ts';

/** Callbacks of the interceptor. */
export interface InterceptorOptions {
  /** Returns the live policy. */
  policy: () => EgressPolicy;
  /**
   * Returns the loopback URL of the tunnel that every upstream connection goes
   * through, so the address vetting also covers what the engine forwards.
   */
  upstreamProxyUrl: () => string;
  /** Counts one denial under its category. */
  denied: (category: DenialCategory) => void;
  /** Writes one structured log line. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Checks if a peer address is loopback.
 *
 * @param address The remote address of the peer.
 * @returns True for 127.0.0.1, ::1 and ::ffff:127.0.0.1.
 */
function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Headers that decide leaves out of a new header set, so the engine derives them from the request URL. */
const URL_LINKED_HEADERS = ['host', ':authority'];

/**
 * Result of the beforeRequest callback of the engine. It is undefined to
 * forward the request unchanged, a new header set, or a response that refuses
 * the request.
 */
type RequestDecision =
  | undefined
  | { headers: Headers }
  | {
      response: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
      };
    };

/** Result of the checks in screen. */
type Screening =
  /** Forward the request unchanged. */
  | { action: 'pass' }
  /** Forward the request with the values in headers. credentialIds names the credentials that were swapped in. */
  | { action: 'swap'; headers: Record<string, string>; credentialIds: string[] }
  /** Refuse the request. category is the counted category, and reason says why. */
  | { action: 'refuse'; category: DenialCategory; reason: string };

/**
 * Controller of the interception engine. It starts, restarts and stops the
 * engine to match the policy.
 */
export class Interceptor {
  /** The running engine, or null when nothing is intercepted. */
  private server: mockttp.Mockttp | null = null;

  /** The CA certificate the running server was started with. */
  private runningCert: string | null = null;

  /**
   * The last queued call. enqueue chains each new call to it, so starts and
   * stops never overlap.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Creates a controller with no running engine.
   *
   * @param opts The callbacks of the interceptor.
   */
  constructor(private readonly opts: InterceptorOptions) {}

  /**
   * Runs work once everything queued before it has finished, or failed.
   *
   * @param work The call to run.
   * @returns The result of the work.
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    // A failure belongs to the caller that asked, not to the calls behind it.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Gives the loopback port of the running engine. The front door hands
   * intercepted connections to it.
   *
   * @returns The port, or null when no engine runs.
   */
  port(): number | null {
    return this.server?.port ?? null;
  }

  /**
   * Makes the engine match the current policy.
   *
   * A policy without a CA or without credentials stops the engine. A changed CA
   * restarts the engine, because the engine signs its certificates with the CA.
   * A changed credential needs no restart, because the rule reads the policy
   * for each request.
   *
   * Calls run one after another. A new server listens before the old server
   * stops, so port() never returns null while the policy asks for interception.
   */
  apply(): Promise<void> {
    return this.enqueue(() => this.applyNow());
  }

  /** Stops the engine. */
  stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  /** The body of apply, run with no other call in flight. */
  private async applyNow(): Promise<void> {
    const policy = this.opts.policy();
    const wanted = policy.ca !== null && policy.credentials.length > 0 ? policy.ca : null;

    if (wanted === null) {
      await this.stopNow();
      return;
    }
    if (this.server && this.runningCert === wanted.cert) return;

    const server = mockttp.getLocal({
      https: { key: wanted.key, cert: wanted.cert },
      http2: true,
      // A long-lived proxy must not accumulate every request it has seen.
      recordTraffic: false,
      suggestChanges: false,
      cors: false,
    });

    await server.start();
    try {
      await server.forAnyRequest().thenPassThrough({
        beforeRequest: (req) => this.decide(req),
        proxyConfig: { proxyUrl: this.opts.upstreamProxyUrl() },
      });

      // The first rule forwards the upgrades that upgradeAllowed accepts. The
      // second refuses all others with a 403 and a reason.
      await server
        .forAnyWebSocket()
        .always()
        .matching((req) => this.upgradeAllowed(req))
        .thenPassThrough({ proxyConfig: { proxyUrl: this.opts.upstreamProxyUrl() } });
      await server
        .forAnyWebSocket()
        .always()
        .thenRejectConnection(403, 'protocol upgrade refused by the egress policy');

      await server.on('tls-client-error', (failure) => {
        // A client that does not trust the deployment CA rejects the certificate,
        // for example a tool that ignores the CA environment variables.
        this.opts.log('TLS handshake rejected by the client', {
          host: failure.tlsMetadata?.sniHostname ?? null,
          reason: failure.failureCause,
        });
      });
    } catch (err) {
      // A partly configured engine must not keep listening.
      await server.stop().catch(() => undefined);
      throw err;
    }

    const previous = this.server;
    this.server = server;
    this.runningCert = wanted.cert;
    if (previous) await this.stopServer(previous);
    this.opts.log('interception engine started', {
      port: server.port,
      hosts: injectionPatterns(policy),
    });
  }

  /** The body of stop, run with no other call in flight. */
  private async stopNow(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.runningCert = null;
    await this.stopServer(server);
  }

  /**
   * Stops one server. A failure to stop is logged and not thrown.
   *
   * @param server The server to stop.
   */
  private async stopServer(server: mockttp.Mockttp): Promise<void> {
    try {
      await server.stop();
    } catch (err) {
      this.opts.log('interception engine failed to stop cleanly', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * True when an intercepted protocol upgrade may go on unchanged. The upgrade
   * must pass the checks in screen and must need no swap.
   *
   * The engine forwards an upgrade with its headers unchanged. An upgrade that
   * needs a swap would send the placeholder, so the method refuses it. The
   * method logs and counts each refusal.
   *
   * @param req The upgrade request.
   * @returns True when the engine may forward the upgrade.
   */
  private upgradeAllowed(req: CompletedRequest): boolean {
    const { host, verdict } = this.screen(req);
    if (verdict.action === 'pass') return true;
    const category = verdict.action === 'refuse' ? verdict.category : 'foreign-credential';
    const reason =
      verdict.action === 'refuse'
        ? verdict.reason
        : 'a credential cannot be swapped into a protocol upgrade';
    this.opts.denied(category);
    this.opts.log('denied intercepted upgrade', { host, reason });
    return false;
  }

  /**
   * Runs the checks that requests and upgrades share. The request must come
   * from the front door over loopback, must use TLS to a credential host, and
   * must pass decideCredentials.
   *
   * @param req The intercepted request or upgrade.
   * @returns The hostname of the request and the result of the checks.
   */
  private screen(req: CompletedRequest): { host: string; verdict: Screening } {
    const policy = this.opts.policy();
    let host: string;
    let protocol = '';
    try {
      const url = new URL(req.url);
      host = url.hostname;
      protocol = url.protocol;
    } catch {
      host = req.destination?.hostname ?? '';
    }

    // The engine listens on every interface, and the proxy sits on every box
    // network. Only the front door, over loopback, may reach it, so an agent
    // cannot skip the checks of the front door.
    if (!isLoopback(req.remoteIpAddress)) {
      return {
        host,
        verdict: {
          action: 'refuse',
          category: 'blocked-address',
          reason: 'the interception engine is reachable from the proxy only',
        },
      };
    }

    const encrypted = protocol === 'https:' || protocol === 'wss:';
    if (!encrypted && credentialsForHost(host, policy).length > 0) {
      // In the clear a swap would put the real credential on the wire as
      // plaintext, and forwarding unswapped would hand over the placeholder.
      return {
        host,
        verdict: {
          action: 'refuse',
          category: 'plaintext-credential-host',
          reason: PLAINTEXT_CREDENTIAL_REASON,
        },
      };
    }

    const verdict = decideCredentials(host, req.headers, policy);
    if (verdict.action === 'deny') {
      return {
        host,
        verdict: { action: 'refuse', category: 'foreign-credential', reason: verdict.reason },
      };
    }
    return { host, verdict };
  }

  /**
   * Decides one intercepted request. The engine forwards it as it stands,
   * forwards it with the real credential in place of the placeholder, or refuses it.
   *
   * @param req The intercepted request.
   * @returns The result for the beforeRequest callback of the engine.
   */
  private decide(req: CompletedRequest): RequestDecision {
    const { host, verdict } = this.screen(req);
    if (verdict.action === 'pass') return;

    if (verdict.action === 'refuse') {
      this.opts.denied(verdict.category);
      this.opts.log('denied intercepted request', { host, reason: verdict.reason });
      return {
        response: {
          statusCode: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: `egress denied: ${verdict.reason}\n`,
        },
      };
    }

    // The callback can only replace the full header set, so the originals are
    // copied. The engine takes a URL-linked header in the new set as an
    // explicit override, so the copy leaves those headers out.
    const headers: Headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (URL_LINKED_HEADERS.includes(name.toLowerCase())) continue;
      headers[name] = value;
    }
    for (const [name, value] of Object.entries(verdict.headers)) headers[name] = value;

    return { headers };
  }
}
