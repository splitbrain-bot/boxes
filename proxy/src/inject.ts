import * as mockttp from 'mockttp';
import type { CompletedRequest, Headers } from 'mockttp';
import type { EgressPolicy } from '../../shared/types.ts';
import { PLAINTEXT_CREDENTIAL_REASON, type DenialCategory } from './forward.ts';
import { credentialsForHost, decideCredentials, injectionPatterns } from './policy.ts';

/** The TLS interception engine, the one place a real credential goes onto the wire. */

/** What the interceptor needs from the process around it. */
export interface InterceptorOptions {
  /** The live policy. */
  policy: () => EgressPolicy;
  /**
   * Loopback URL of the tunnel every upstream connection goes through, so the
   * address vetting also covers what the engine forwards.
   */
  upstreamProxyUrl: () => string;
  /** Records a denial, by category. */
  denied: (category: DenialCategory) => void;
  /** Structured logging. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Whether a peer address is loopback, in its IPv4, IPv6 or IPv4-mapped form.
 */
function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Headers the engine derives from the request URL, so a copied set leaves them out. */
const URL_LINKED_HEADERS = ['host', ':authority'];

/**
 * What this proxy tells the engine to do with a request: leave it alone,
 * forward it with a rewritten header set, or answer it with a refusal. Written
 * out here because the engine does not export its callback result type.
 */
type RequestDecision =
  | void
  | { headers: Headers }
  | {
      response: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
      };
    };

/**
 * Controller of the interception engine: starts, restarts and stops it as the
 * policy requires.
 */
export class Interceptor {
  /** The running engine, or null when nothing is intercepted. */
  private server: mockttp.Mockttp | null = null;

  /** The CA certificate the running server was started with. */
  private runningCert: string | null = null;

  /** The call in flight, so starts and stops never overlap. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: InterceptorOptions) {}

  /** Runs work once everything queued before it has finished, or failed. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    // A failure belongs to the caller that asked, not to the calls behind it.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Loopback port the front door hands intercepted connections to, if any. */
  port(): number | null {
    return this.server?.port ?? null;
  }

  /**
   * Brings the engine in line with the current policy.
   *
   * A policy with no CA or no credential stops it, so nothing is decrypted. A
   * changed CA restarts it, because it mints certificates from that key. A
   * changed credential needs neither, because the rule reads the policy per
   * request.
   *
   * Calls run one after another. A replacement listens before the server it
   * replaces stops, so port() never returns null while a policy asks for
   * interception.
   */
  apply(): Promise<void> {
    return this.enqueue(() => this.applyNow());
  }

  /** Stops the engine, leaving nothing decrypting. */
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
      await server
        .forAnyRequest()
        .thenPassThrough({
          beforeRequest: (req) => this.decide(req),
          proxyConfig: { proxyUrl: this.opts.upstreamProxyUrl() },
        });

      // The websocket passthrough cannot rewrite headers, so a forwarded
      // upgrade would carry the placeholder to the host. This rule gives the
      // same 501 as the front door, in place of the engine's "no rules matched".
      await server.forAnyWebSocket().thenRejectConnection(501, 'protocol upgrades are not forwarded');

      await server.on('tls-client-error', (failure) => {
        // The shape of a tool that ignores the CA env vars: it reaches an
        // intercepted host and refuses the certificate.
        this.opts.log('TLS handshake rejected by the client', {
          host: failure.tlsMetadata?.sniHostname ?? null,
          reason: failure.failureCause,
        });
      });
    } catch (err) {
      // A listening engine with no rule would forward without deciding.
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

  /** Stops one server, logging rather than throwing when it will not go. */
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
   * Decides one intercepted request: forward it as it stands, forward it with
   * the real credential in place of the placeholder, or refuse it here.
   */
  private decide(req: CompletedRequest): RequestDecision {
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

    /** Answers the request here with a 403, and counts the denial. */
    const refuse = (category: DenialCategory, reason: string): RequestDecision => {
      this.opts.denied(category);
      this.opts.log('denied intercepted request', { host, reason });
      return {
        response: {
          statusCode: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: `egress denied: ${reason}\n`,
        },
      };
    };

    // The engine listens on every interface, and the proxy sits on every box
    // network. Only the front door, over loopback, may reach it, so a box
    // cannot skip the front door's checks.
    if (!isLoopback(req.remoteIpAddress)) {
      return refuse('blocked-address', 'the interception engine is reachable from the proxy only');
    }

    if (protocol !== 'https:' && credentialsForHost(host, policy).length > 0) {
      // In the clear a swap would put the real credential on the wire as
      // plaintext, and forwarding unswapped would hand over the placeholder.
      return refuse('plaintext-credential-host', PLAINTEXT_CREDENTIAL_REASON);
    }

    const verdict = decideCredentials(host, req.headers, policy);
    if (verdict.action === 'pass') return;

    if (verdict.action === 'deny') {
      return refuse('foreign-credential', verdict.reason);
    }

    // Replacing the header set wholesale is the callback's only option, so the
    // originals are copied. The URL-linked headers are dropped: the engine
    // derives them from the request URL, and reads a copy as a rewrite.
    const headers: Headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (URL_LINKED_HEADERS.includes(name.toLowerCase())) continue;
      headers[name] = value;
    }
    for (const [name, value] of Object.entries(verdict.headers)) headers[name] = value;

    return { headers };
  }
}
