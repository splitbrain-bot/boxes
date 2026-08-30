import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EgressPolicy } from '../../shared/types.ts';
import { parseHostPort, vetTarget } from './forward.ts';
import { EMPTY_POLICY } from './policy.ts';

/**
 * The check that stands between an agent and everything it must not reach:
 * the port, the allowlist, and the address a name actually resolves to.
 */

/** Answers DNS with a fixed set of addresses, without touching the network. */
function resolvesTo(...addresses: string[]): void {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never,
  );
}

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
  });
});

describe('vetTarget', () => {
  it('allows only ports 80 and 443', async () => {
    resolvesTo('93.184.216.34');
    await expect(vetTarget({ host: 'example.com', port: 443 }, EMPTY_POLICY)).resolves.toMatchObject(
      { ok: true },
    );
    await expect(vetTarget({ host: 'example.com', port: 22 }, EMPTY_POLICY)).resolves.toEqual({
      ok: false,
      reason: 'port 22 not allowed',
    });
  });

  it('checks the allowlist before resolving anything', async () => {
    const lookup = vi.spyOn(dns.promises, 'lookup');
    const verdict = await vetTarget({ host: 'evil.com', port: 443 }, allowing('example.com'));
    expect(verdict).toEqual({ ok: false, reason: 'host is not on the egress allowlist' });
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
      reason: 'hostname resolves to a blocked address',
    });
  });

  it('refuses address literals in private space, including the v4-mapped form', async () => {
    for (const host of ['192.168.1.1', '10.0.0.1', '169.254.169.254', '127.0.0.1', '::1']) {
      await expect(vetTarget({ host, port: 443 }, EMPTY_POLICY)).resolves.toEqual({
        ok: false,
        reason: 'target address is in a blocked range',
      });
    }
    await expect(
      vetTarget({ host: '::ffff:192.168.1.1', port: 443 }, EMPTY_POLICY),
    ).resolves.toEqual({ ok: false, reason: 'target address is in a blocked range' });
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
      reason: 'DNS lookup failed: ENOTFOUND',
    });

    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([] as never);
    await expect(vetTarget({ host: 'nope.example', port: 443 }, EMPTY_POLICY)).resolves.toEqual({
      ok: false,
      reason: 'hostname resolves to a blocked address',
    });
  });
});
