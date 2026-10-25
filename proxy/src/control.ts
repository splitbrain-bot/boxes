/** The control channel, through which the orchestrator pushes the policy to the proxy and reads its status. */

import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import type { EgressDenial, EgressPolicy, EgressStatus } from '../../shared/types.ts';
import { parsePolicy, tokensMatch } from './policy.ts';

/**
 * Largest policy body accepted, in characters of the decoded UTF-8 text. The
 * policy holds the hosts of each box, so it grows with the number of boxes.
 */
const MAX_BODY = 1 << 24;

/** Time limit for one control request to arrive, in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Callbacks of the control server. */
export interface ControlOptions {
  /** Applies a pushed policy. A rejected promise makes the server answer the push with a 400. */
  apply: (policy: EgressPolicy) => Promise<void>;
  /** Returns the current status. */
  status: () => EgressStatus;
  /** Returns the targets that the egress profile of a box refused, the most recent first. */
  denials: (box: string) => EgressDenial[];
  /** Writes one structured log line. */
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Finds the address for the control channel. It is the address of this
 * container on the network with the default route.
 *
 * Box networks are internal and have no default route, so the default route
 * goes through the compose network of the orchestrator. A connected UDP socket
 * does the route lookup and sends no data.
 *
 * @returns The address, or null when the lookup fails or gives an address that this container does not hold.
 */
export async function resolveControlAddress(): Promise<string | null> {
  const address = await new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (value: string | null): void => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    socket.on('error', () => done(null));
    try {
      // A reserved documentation address (TEST-NET-1) outside every private
      // range, so the lookup picks the default route.
      socket.connect(53, '192.0.2.1', () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });

  if (address === null || address === '0.0.0.0') return null;
  const held = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .some((entry) => entry.address === address);
  return held ? address : null;
}

/** A control server and its claim state. */
export interface ControlServer {
  /** The HTTP server, not yet listening. */
  server: http.Server;
  /** Returns true once a push has claimed the channel. */
  claimed: () => boolean;
}

/**
 * Builds the control server. The caller starts it listening.
 *
 * The first policy push claims the channel with its bearer token, and every
 * later request must send the same token. Only the orchestrator can reach the
 * control address, so only the orchestrator can make the first push.
 *
 * @param opts The callbacks of the server.
 * @returns The server and its claim state.
 */
export function createControlServer(opts: ControlOptions): ControlServer {
  let token: string | null = null;

  /** Sends one JSON response with its Content-Length. */
  const send = (res: http.ServerResponse, code: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  /**
   * Checks the bearer token. On an unclaimed channel, a POST to /policy claims
   * the channel with its token, and all other requests fail.
   */
  const authorize = (req: http.IncomingMessage): boolean => {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const presented = /^bearer\s+(.+)$/i.exec(value ?? '')?.[1]?.trim();
    if (!presented) return false;
    if (token !== null) return tokensMatch(token, presented);

    if (req.method !== 'POST' || req.url !== '/policy') return false;
    token = presented;
    opts.log('control channel claimed by its first push');
    return true;
  };

  const server = http.createServer((req, res) => {
    if (!authorize(req)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      send(res, 200, opts.status());
      return;
    }

    const url = new URL(req.url ?? '/', 'http://control');
    if (req.method === 'GET' && url.pathname === '/denials') {
      const box = url.searchParams.get('box');
      if (!box) {
        send(res, 400, { error: 'box is missing' });
        return;
      }
      send(res, 200, opts.denials(box));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/policy') {
      send(res, 404, { error: 'not found' });
      return;
    }

    let body = '';
    let oversized = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (oversized) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        oversized = true;
        // The 413 must reach the caller before the socket closes.
        res.on('finish', () => req.destroy());
        send(res, 413, { error: 'policy too large' });
      }
    });
    req.on('end', () => {
      if (oversized) return;
      void (async () => {
        try {
          const policy = parsePolicy(JSON.parse(body));
          await opts.apply(policy);
          send(res, 200, opts.status());
        } catch (err) {
          const message = (err as Error).message;
          opts.log('rejected a pushed policy', { error: message });
          send(res, 400, { error: message });
        }
      })();
    });
  });

  // A push that stops halfway must not keep a connection open forever.
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  return { server, claimed: () => token !== null };
}
