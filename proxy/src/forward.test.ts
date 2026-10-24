/** Tests for host parsing and for vetting the port, host and address of a target. */

import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EgressPolicy } from '../../shared/types.ts';
import { createForwardServer, type DenialCategory, parseHostPort, vetTarget } from './forward.ts';
import { EMPTY_POLICY } from './policy.ts';

/**
 * Makes the DNS lookup answer with fixed addresses, so the test uses no network.
 *
 * @param addresses The addresses that the lookup returns.
 */
function resolvesTo(...addresses: string[]): void {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never,
  );
}

/**
 * Makes a policy that allows only the given hosts.
 *
 * @param hosts The allowlist patterns.
 * @returns A policy with no CA and no credentials.
 */
const allowing = (...hosts: string[]): EgressPolicy => ({
  allowedHosts: hosts,
  ca: null,
  credentials: [],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseHostPort', () => {
  it('splits names, defaults the port, and brackets IPv6', () => {
    expect(parseHostPort('example.com', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(parseHostPort('example.com:8443', 443)).toEqual({ host: 'example.com', port: 8443 });
    expect(parseHostPort('[::1]:443', 443)).toEqual({ host: '::1', port: 443 });
    expect(parseHostPort('[::1]', 443)).toEqual({ host: '::1', port: 443 });
  });

  it('refuses malformed authorities', () => {
    expect(parseHostPort(':443', 443)).toBeNull();
    expect(parseHostPort('example.com:0', 443)).toBeNull();
    expect(parseHostPort('example.com:99999', 443)).toBeNull();
    expect(parseHostPort('example.com:http', 443)).toBeNull();
    expect(parseHostPort('[::1', 443)).toBeNull();
    // Only a port may follow the brackets, and the brackets must hold an IPv6 address.
    expect(parseHostPort('[8.8.8.8]junk', 443)).toBeNull();
    expect(parseHostPort('[::ffff:8.8.8.8]x', 443)).toBeNull();
    expect(parseHostPort('[::1]443', 443)).toBeNull();
    expect(parseHostPort('[8.8.8.8]', 443)).toBeNull();
    expect(parseHostPort('[example.com]:443', 443)).toBeNull();
    expect(parseHostPort('[]', 443)).toBeNull();
    expect(parseHostPort('[]:443', 443)).toBeNull();
    // A host outside brackets cannot hold a colon.
    expect(parseHostPort('a:b:443', 443)).toBeNull();
    expect(parseHostPort('::1', 443)).toBeNull();
    expect(parseHostPort('[::ffff:8.8.8.8]:443', 443)).toEqual({
      host: '::ffff:8.8.8.8',
      port: 443,
    });
  });
});

describe('vetTarget', () => {
  it('allows only ports 80 and 443 when no pattern names a port', async () => {
    resolvesTo('93.184.216.34');
    await expect(
      vetTarget({ host: 'example.com', port: 443 }, EMPTY_POLICY),
    ).resolves.toMatchObject({ ok: true });
    await expect(vetTarget({ host: 'example.com', port: 22 }, EMPTY_POLICY)).resolves.toEqual({
      ok: false,
      category: 'port',
      reason: 'port 22 not allowed for this host',
    });
  });

  it('allows a port that a pattern names for the host', async () => {
    resolvesTo('93.184.216.34');
    const policy = allowing('mcp.example.com:8443');
    await expect(vetTarget({ host: 'mcp.example.com', port: 8443 }, policy)).resolves.toMatchObject(
      { ok: true },
    );
    await expect(vetTarget({ host: 'other.example.com', port: 8443 }, policy)).resolves.toEqual({
      ok: false,
      category: 'port',
      reason: 'port 8443 not allowed for this host',
    });
    await expect(vetTarget({ host: 'mcp.example.com', port: 443 }, policy)).resolves.toEqual({
      ok: false,
      category: 'allowlist',
      reason: 'host is not on the egress allowlist',
    });
  });

  it('checks the allowlist before resolving anything', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup');
    const verdict = await vetTarget({ host: 'evil.com', port: 443 }, allowing('example.com'));
    expect(verdict).toEqual({
      ok: false,
      category: 'allowlist',
      reason: 'host is not on the egress allowlist',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('pins the connection to a vetted address', async () => {
    resolvesTo('93.184.216.34', '93.184.216.35');
    await expect(
      vetTarget({ host: 'example.com', port: 443 }, allowing('example.com')),
    ).resolves.toEqual({ ok: true, address: '93.184.216.34', family: 4 });
  });

  it('refuses a name that resolves to any blocked address, closing DNS rebinding', async () => {
    resolvesTo('93.184.216.34', '192.168.1.5');
    await expect(vetTarget({ host: 'rebind.example', port: 443 }, EMPTY_POLICY)).resolves.toEqual({
      ok: false,
      category: 'blocked-address',
      reason: 'hostname resolves to a blocked address',
    });
  });

  it('refuses address literals in private space, including the v4-mapped form', async () => {
    for (const host of ['192.168.1.1', '10.0.0.1', '169.254.169.254', '127.0.0.1', '::1']) {
      await expect(vetTarget({ host, port: 443 }, EMPTY_POLICY)).resolves.toEqual({
        ok: false,
        category: 'blocked-address',
        reason: 'target address is in a blocked range',
      });
    }
    await expect(
      vetTarget({ host: '::ffff:192.168.1.1', port: 443 }, EMPTY_POLICY),
    ).resolves.toEqual({
      ok: false,
      category: 'blocked-address',
      reason: 'target address is in a blocked range',
    });
  });

  it('matches an address literal against the allowlist as a literal', async () => {
    await expect(vetTarget({ host: '1.1.1.1', port: 443 }, allowing('1.1.1.1'))).resolves.toEqual({
      ok: true,
      address: '1.1.1.1',
      family: 4,
    });
    await expect(
      vetTarget({ host: '1.1.1.1', port: 443 }, allowing('*.1.1.1')),
    ).resolves.toMatchObject({ ok: false });
  });

  it('fails closed when a name does not resolve', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    await expect(vetTarget({ host: 'nope.example', port: 443 }, EMPTY_POLICY)).resolves.toEqual({
      ok: false,
      category: 'dns',
      reason: 'DNS lookup failed: ENOTFOUND',
    });

    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([] as never);
    await expect(vetTarget({ host: 'nope.example', port: 443 }, EMPTY_POLICY)).resolves.toEqual({
      ok: false,
      category: 'dns',
      reason: 'no addresses resolved',
    });
  });
});

describe('the front door', () => {
  /** The servers that a test started. */
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /**
   * Starts a server on loopback.
   *
   * @param server The server to start.
   * @returns The port that the server listens on.
   */
  const listen = (server: net.Server): Promise<number> =>
    new Promise((resolve) => {
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

  /**
   * Sends a CONNECT to the front door and reads the status line of the answer.
   *
   * @param port The port of the front door.
   * @param authority The host and port to send in the CONNECT.
   * @returns The status line.
   */
  const connect = (port: number, authority: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      socket.once('data', (chunk) => {
        resolve(String(chunk).split('\r\n')[0] ?? '');
        socket.destroy();
      });
      socket.on('error', reject);
    });

  /**
   * Starts a front door for a policy with a credential for mcp.example.com on
   * port 8443, and a stand-in engine that records each CONNECT it gets.
   *
   * @returns The port of the front door, the CONNECT authorities of the engine, and the denials.
   */
  async function frontDoor(): Promise<{
    port: number;
    engine: string[];
    denials: DenialCategory[];
  }> {
    resolvesTo('93.184.216.34');
    const engine: string[] = [];
    const denials: DenialCategory[] = [];
    const fakeEngine = http.createServer();
    fakeEngine.on('connect', (req, socket: net.Socket) => {
      engine.push(req.url ?? '');
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    const enginePort = await listen(fakeEngine);

    const policy: EgressPolicy = {
      allowedHosts: [],
      ca: { key: 'K', cert: 'C' },
      credentials: [
        {
          id: 'mcp',
          hosts: ['mcp.example.com:8443', 'api.example.com'],
          headers: [],
          placeholder: 'PLACEHOLDER',
          secret: 'SECRET',
        },
      ],
    };
    const front = createForwardServer({
      policy: () => policy,
      interceptPort: () => enginePort,
      applied: () => true,
      denied: (category) => denials.push(category),
      log: () => {},
    });
    return { port: await listen(front), engine, denials };
  }

  it('hands a credential host on a named port to the engine', async () => {
    const { port, engine } = await frontDoor();
    expect(await connect(port, 'mcp.example.com:8443')).toBe('HTTP/1.1 200 Connection Established');
    expect(engine).toEqual(['mcp.example.com:8443']);
  });

  it('refuses a credential host on port 80 and on a port that no pattern names', async () => {
    const { port, engine, denials } = await frontDoor();
    expect(await connect(port, 'api.example.com:80')).toBe('HTTP/1.1 403 Forbidden');
    expect(await connect(port, 'mcp.example.com:9000')).toBe('HTTP/1.1 403 Forbidden');
    expect(engine).toEqual([]);
    expect(denials).toEqual(['plaintext-credential-host', 'port']);
  });
});
