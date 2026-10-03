import { describe, expect, it } from 'vitest';
import type { EgressPolicy } from '../../shared/types.ts';
import {
  EMPTY_POLICY,
  credentialsForHost,
  decideCredentials,
  hostAllowed,
  hostMatches,
  isInjectionHost,
  parsePolicy,
  policyHash,
  swapCredentialValue,
} from './policy.ts';

/** The Claude credential. */
const CLAUDE = {
  id: 'claude',
  hosts: ['api.anthropic.com'],
  headers: ['authorization', 'x-api-key'],
  placeholder: 'sk-ant-oat01-PLACEHOLDER',
  secret: 'sk-ant-oat01-realrealreal',
};

/**
 * The OpenAI credential Codex sends. Its placeholder starts with `sk-`, like
 * the Claude one, so it shows that the whole value at the right host decides
 * a swap, not a prefix.
 */
const OPENAI = {
  id: 'openai',
  hosts: ['api.openai.com'],
  headers: ['authorization'],
  placeholder: 'sk-PLACEHOLDER',
  secret: 'sk-proj-realrealreal',
};

/** The GitHub credential, with a wildcard host. */
const GITHUB = {
  id: 'github',
  hosts: ['github.com', 'api.github.com', '*.githubusercontent.com'],
  headers: ['authorization'],
  placeholder: 'ghp_PLACEHOLDER',
  secret: 'ghp_realrealreal',
};

/**
 * The Dev Tunnels credential. Its hosts also see tokens the service issued
 * for one tunnel, which travel under the `tunnel` scheme.
 */
const DEVTUNNELS = {
  id: 'devtunnels',
  hosts: ['*.rel.tunnels.api.visualstudio.com'],
  headers: ['authorization'],
  passthroughSchemes: ['tunnel'],
  placeholder: 'ghu_PLACEHOLDER',
  secret: 'ghu_realrealreal',
};

/** A policy holding all three credentials, with some fields replaced. */
const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  allowedHosts: [],
  ca: { key: 'KEY', cert: 'CERT' },
  credentials: [CLAUDE, OPENAI, GITHUB],
  ...over,
});

describe('hostMatches', () => {
  it('matches exact names case-insensitively and ignores a trailing dot', () => {
    expect(hostMatches('api.github.com', 'api.github.com')).toBe(true);
    expect(hostMatches('API.GitHub.com', 'api.github.com')).toBe(true);
    expect(hostMatches('api.github.com.', 'api.github.com')).toBe(true);
    expect(hostMatches('api.github.com', 'github.com')).toBe(false);
  });

  it('lets a wildcard stand for exactly one label', () => {
    expect(hostMatches('raw.githubusercontent.com', '*.githubusercontent.com')).toBe(true);
    expect(hostMatches('githubusercontent.com', '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('a.b.githubusercontent.com', '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('.githubusercontent.com', '*.githubusercontent.com')).toBe(false);
  });

  it('never lets a wildcard match an address literal', () => {
    expect(hostMatches('1.1.1.1', '*.1.1.1')).toBe(false);
    expect(hostMatches('1.1.1.1', '1.1.1.1')).toBe(true);
    expect(hostMatches('::1', '*.1')).toBe(false);
  });

  it('rejects empty patterns and hosts', () => {
    expect(hostMatches('', 'github.com')).toBe(false);
    expect(hostMatches('github.com', '')).toBe(false);
    expect(hostMatches('github.com', '*.')).toBe(false);
  });
});

describe('hostAllowed', () => {
  it('allows everything when no allowlist is configured', () => {
    expect(hostAllowed('example.com', EMPTY_POLICY)).toBe(true);
    expect(hostAllowed('1.1.1.1', EMPTY_POLICY)).toBe(true);
  });

  it('allows only listed hosts once an allowlist exists', () => {
    const p = policy({ allowedHosts: ['registry.npmjs.org', '*.example.com'], credentials: [] });
    expect(hostAllowed('registry.npmjs.org', p)).toBe(true);
    expect(hostAllowed('a.example.com', p)).toBe(true);
    expect(hostAllowed('example.com', p)).toBe(false);
    expect(hostAllowed('evil.com', p)).toBe(false);
    expect(hostAllowed('1.1.1.1', p)).toBe(false);
  });

  it('implies the configured credentials hosts, so a narrow list cannot sever them', () => {
    const p = policy({ allowedHosts: ['registry.npmjs.org'] });
    expect(hostAllowed('api.anthropic.com', p)).toBe(true);
    expect(hostAllowed('raw.githubusercontent.com', p)).toBe(true);
    expect(hostAllowed('evil.com', p)).toBe(false);
  });
});

describe('isInjectionHost', () => {
  it('is true only for a credential host, and only with a CA to intercept with', () => {
    expect(isInjectionHost('api.github.com', policy())).toBe(true);
    expect(isInjectionHost('example.com', policy())).toBe(false);
    expect(isInjectionHost('api.github.com', policy({ ca: null }))).toBe(false);
    expect(isInjectionHost('api.github.com', policy({ credentials: [CLAUDE] }))).toBe(false);
  });
});

describe('credentialsForHost', () => {
  it('maps a host to only its own credentials', () => {
    expect(credentialsForHost('api.anthropic.com', policy()).map((c) => c.id)).toEqual(['claude']);
    expect(credentialsForHost('github.com', policy()).map((c) => c.id)).toEqual(['github']);
  });
});

describe('swapCredentialValue', () => {
  it('swaps a bearer, a token and a bare value', () => {
    expect(swapCredentialValue('Bearer ghp_PLACEHOLDER', GITHUB.placeholder, GITHUB.secret)).toBe(
      'Bearer ghp_realrealreal',
    );
    expect(swapCredentialValue('token ghp_PLACEHOLDER', GITHUB.placeholder, GITHUB.secret)).toBe(
      'token ghp_realrealreal',
    );
    expect(swapCredentialValue('ghp_PLACEHOLDER', GITHUB.placeholder, GITHUB.secret)).toBe(
      'ghp_realrealreal',
    );
  });

  it('swaps the password inside HTTP Basic, which is what git sends', () => {
    const basic = `Basic ${Buffer.from(`x-access-token:${GITHUB.placeholder}`).toString('base64')}`;
    const swapped = swapCredentialValue(basic, GITHUB.placeholder, GITHUB.secret);
    expect(swapped).not.toBeNull();
    const decoded = Buffer.from(swapped!.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe(`x-access-token:${GITHUB.secret}`);
  });

  it('reports a value that does not carry the placeholder', () => {
    expect(swapCredentialValue('Bearer somebody-elses-token', GITHUB.placeholder, GITHUB.secret)).toBeNull();
    const basic = `Basic ${Buffer.from('user:somebody-elses-token').toString('base64')}`;
    expect(swapCredentialValue(basic, GITHUB.placeholder, GITHUB.secret)).toBeNull();
    expect(swapCredentialValue('Bearer x', '', GITHUB.secret)).toBeNull();
  });
});

describe('decideCredentials', () => {
  it('passes a host with no credential configured straight through', () => {
    expect(decideCredentials('example.com', { authorization: 'Bearer anything' }, policy())).toEqual(
      { action: 'pass' },
    );
  });

  it('passes an unauthenticated request to a credential host', () => {
    // `curl https://api.github.com` must keep working: no credential is not a
    // foreign credential.
    expect(decideCredentials('api.github.com', { accept: '*/*' }, policy())).toEqual({
      action: 'pass',
    });
    expect(decideCredentials('api.github.com', { authorization: '  ' }, policy())).toEqual({
      action: 'pass',
    });
  });

  it('swaps the placeholder for the real credential', () => {
    const verdict = decideCredentials(
      'api.github.com',
      { authorization: `Bearer ${GITHUB.placeholder}` },
      policy(),
    );
    expect(verdict).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${GITHUB.secret}` },
      credentialIds: ['github'],
    });
  });

  it('refuses a foreign credential rather than forwarding it', () => {
    const verdict = decideCredentials(
      'api.github.com',
      { authorization: 'Bearer ghp_someoneElsesToken' },
      policy(),
    );
    expect(verdict.action).toBe('deny');
  });

  it('refuses another credential host s placeholder, so hosts do not share', () => {
    const verdict = decideCredentials(
      'api.github.com',
      { authorization: `Bearer ${CLAUDE.placeholder}` },
      policy(),
    );
    expect(verdict.action).toBe('deny');
  });

  it('swaps the key Codex sends at api.openai.com', () => {
    expect(
      decideCredentials(
        'api.openai.com',
        { authorization: `Bearer ${OPENAI.placeholder}` },
        policy(),
      ),
    ).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${OPENAI.secret}` },
      credentialIds: ['openai'],
    });
    // A foreign key and the Claude placeholder are both refused here.
    expect(
      decideCredentials('api.openai.com', { authorization: 'Bearer sk-somebodyelses' }, policy())
        .action,
    ).toBe('deny');
    expect(
      decideCredentials(
        'api.openai.com',
        { authorization: `Bearer ${CLAUDE.placeholder}` },
        policy(),
      ).action,
    ).toBe('deny');
    // The subscription endpoint is not intercepted, so anything passes there.
    expect(isInjectionHost('chatgpt.com', policy())).toBe(false);
    expect(
      decideCredentials('chatgpt.com', { authorization: 'Bearer whatever' }, policy()),
    ).toEqual({ action: 'pass' });
  });

  it('checks every header a credential may travel in', () => {
    expect(
      decideCredentials('api.anthropic.com', { 'x-api-key': CLAUDE.placeholder }, policy()),
    ).toEqual({
      action: 'swap',
      headers: { 'x-api-key': CLAUDE.secret },
      credentialIds: ['claude'],
    });
    expect(
      decideCredentials('api.anthropic.com', { 'x-api-key': 'sk-ant-someoneelse' }, policy()).action,
    ).toBe('deny');
  });

  it('passes a value under a pass-through scheme unchanged, and swaps the placeholder', () => {
    const tunnels = policy({ credentials: [DEVTUNNELS] });
    const host = 'euw-data.rel.tunnels.api.visualstudio.com';
    // A token the service minted for one tunnel, which the box got from it.
    expect(decideCredentials(host, { authorization: 'tunnel eyJhbGciOi.x.y' }, tunnels)).toEqual({
      action: 'pass',
    });
    expect(decideCredentials(host, { authorization: 'Tunnel eyJhbGciOi.x.y' }, tunnels)).toEqual({
      action: 'pass',
    });
    expect(
      decideCredentials(host, { authorization: `github ${DEVTUNNELS.placeholder}` }, tunnels),
    ).toEqual({
      action: 'swap',
      headers: { authorization: `github ${DEVTUNNELS.secret}` },
      credentialIds: ['devtunnels'],
    });
  });

  it('still refuses a foreign value under any other scheme, or under none', () => {
    const tunnels = policy({ credentials: [DEVTUNNELS] });
    const host = 'global.rel.tunnels.api.visualstudio.com';
    for (const value of ['github ghu_someoneelse', 'Bearer ghu_someoneelse', 'tunnel', 'tunnelx y']) {
      expect(decideCredentials(host, { authorization: value }, tunnels).action).toBe('deny');
    }
    // A pass-through scheme belongs to its own credential's hosts only.
    expect(
      decideCredentials('api.github.com', { authorization: 'tunnel eyJhbGciOi.x.y' }, policy())
        .action,
    ).toBe('deny');
  });
});

describe('policyHash', () => {
  it('is stable across ordering and case, and changes with the secret', () => {
    const a = policy({ allowedHosts: ['B.com', 'a.com'] });
    const b = policy({ allowedHosts: ['a.com', 'b.com'], credentials: [GITHUB, OPENAI, CLAUDE] });
    expect(policyHash(a)).toBe(policyHash(b));
    expect(policyHash(policy({ credentials: [{ ...GITHUB, secret: 'other' }, CLAUDE] }))).not.toBe(
      policyHash(a),
    );
    expect(policyHash(policy({ credentials: [DEVTUNNELS] }))).not.toBe(
      policyHash(policy({ credentials: [{ ...DEVTUNNELS, passthroughSchemes: [] }] })),
    );
  });

  it('never echoes a secret', () => {
    const hash = policyHash(policy());
    expect(hash).not.toContain(GITHUB.secret);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('parsePolicy', () => {
  const valid = {
    allowedHosts: ['github.com', '*.github.com'],
    ca: { key: 'K', cert: 'C' },
    credentials: [GITHUB],
  };

  it('accepts a well-formed policy and lowercases header names', () => {
    const parsed = parsePolicy({
      ...valid,
      credentials: [{ ...GITHUB, headers: ['Authorization'] }],
    });
    expect(parsed.credentials[0]?.headers).toEqual(['authorization']);
    expect(parsed.allowedHosts).toEqual(['github.com', '*.github.com']);
  });

  it('accepts pass-through schemes, lowercased, and refuses one with a space', () => {
    const parsed = parsePolicy({
      ...valid,
      credentials: [{ ...DEVTUNNELS, passthroughSchemes: ['Tunnel'] }],
    });
    expect(parsed.credentials[0]?.passthroughSchemes).toEqual(['tunnel']);
    expect(parsePolicy(valid).credentials[0]?.passthroughSchemes).toBeUndefined();
    expect(() =>
      parsePolicy({ ...valid, credentials: [{ ...DEVTUNNELS, passthroughSchemes: ['a b'] }] }),
    ).toThrow(/space/);
  });

  it('accepts the empty policy the proxy boots with', () => {
    expect(parsePolicy({ allowedHosts: [], ca: null, credentials: [] })).toEqual(EMPTY_POLICY);
  });

  it('rejects an allowlist entry that would allow everything', () => {
    expect(() => parsePolicy({ ...valid, allowedHosts: ['*'] })).toThrow(/bare \*/);
    expect(() => parsePolicy({ ...valid, allowedHosts: ['api.*.com'] })).toThrow(/leading/);
  });

  it('rejects a credential that cannot be translated or is not a translation', () => {
    expect(() => parsePolicy({ ...valid, ca: null })).toThrow(/without a CA/);
    expect(() =>
      parsePolicy({ ...valid, credentials: [{ ...GITHUB, secret: GITHUB.placeholder }] }),
    ).toThrow(/equal to its secret/);
    expect(() => parsePolicy({ ...valid, credentials: [{ ...GITHUB, hosts: [] }] })).toThrow(
      /at least one host/,
    );
    expect(() => parsePolicy({ ...valid, credentials: [{ ...GITHUB, headers: [] }] })).toThrow(
      /at least one header/,
    );
  });

  it('rejects anything that is not a policy at all', () => {
    expect(() => parsePolicy(null)).toThrow(/not an object/);
    expect(() => parsePolicy({ allowedHosts: 'github.com' })).toThrow(/must be an array/);
  });
});
