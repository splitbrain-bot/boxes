import { describe, expect, it } from 'vitest';
import { hostMatches, splitHostPattern } from '../../shared/hosts.ts';
import type { EgressPolicy } from '../../shared/types.ts';
import {
  credentialsForHost,
  decideCredentials,
  EMPTY_POLICY,
  hostAllowed,
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
 * The OpenAI credential that Codex sends. Its placeholder starts with sk-, as
 * the Claude placeholder does, so the tests show that a swap needs the full
 * placeholder at the host of its credential.
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

/** A user's own API key, which names no header and so may travel in any. */
const OPENROUTER = {
  id: 'openrouter',
  hosts: ['openrouter.ai'],
  headers: [],
  placeholder: 'sk-or-v1-PLACEHOLDER',
  secret: 'sk-or-v1-realrealreal',
};

/**
 * Makes a policy that holds the Claude, OpenAI and GitHub credentials.
 *
 * @param over The fields to replace.
 * @returns The policy.
 */
const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  allowedHosts: [],
  ca: { key: 'KEY', cert: 'CERT' },
  credentials: [CLAUDE, OPENAI, GITHUB],
  ...over,
});

describe('hostMatches', () => {
  it('matches exact names case-insensitively and ignores a trailing dot', () => {
    expect(hostMatches('api.github.com', 443, 'api.github.com')).toBe(true);
    expect(hostMatches('API.GitHub.com', 443, 'api.github.com')).toBe(true);
    expect(hostMatches('api.github.com.', 443, 'api.github.com')).toBe(true);
    expect(hostMatches('api.github.com', 443, 'github.com')).toBe(false);
  });

  it('lets a wildcard stand for exactly one label', () => {
    expect(hostMatches('raw.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(true);
    expect(hostMatches('githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('a.b.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
  });

  it('never lets a wildcard match an address literal', () => {
    expect(hostMatches('1.1.1.1', 443, '*.1.1.1')).toBe(false);
    expect(hostMatches('1.1.1.1', 443, '1.1.1.1')).toBe(true);
    expect(hostMatches('::1', 443, '*.1')).toBe(false);
  });

  it('rejects empty patterns and hosts', () => {
    expect(hostMatches('', 443, 'github.com')).toBe(false);
    expect(hostMatches('github.com', 443, '')).toBe(false);
    expect(hostMatches('github.com', 443, '*.')).toBe(false);
  });

  it('matches a pattern without a port on the ports 80 and 443 only', () => {
    expect(hostMatches('github.com', 80, 'github.com')).toBe(true);
    expect(hostMatches('github.com', 8443, 'github.com')).toBe(false);
  });

  it('matches a pattern with a port on that port only', () => {
    expect(hostMatches('mcp.example.com', 8443, 'mcp.example.com:8443')).toBe(true);
    expect(hostMatches('mcp.example.com', 443, 'mcp.example.com:8443')).toBe(false);
    expect(hostMatches('a.example.com', 8443, '*.example.com:8443')).toBe(true);
    expect(hostMatches('2001:db8::1', 8443, '[2001:db8::1]:8443')).toBe(true);
    expect(hostMatches('2001:db8::1', 443, '2001:db8::1')).toBe(true);
  });
});

describe('splitHostPattern', () => {
  it('splits off an optional port', () => {
    expect(splitHostPattern('example.com')).toEqual({ host: 'example.com', port: null });
    expect(splitHostPattern('example.com:8443')).toEqual({ host: 'example.com', port: 8443 });
    expect(splitHostPattern('2001:db8::1')).toEqual({ host: '2001:db8::1', port: null });
    expect(splitHostPattern('[2001:db8::1]:8443')).toEqual({ host: '2001:db8::1', port: 8443 });
  });
});

describe('hostAllowed', () => {
  it('allows everything when no allowlist is configured', () => {
    expect(hostAllowed('example.com', 443, EMPTY_POLICY)).toBe(true);
    expect(hostAllowed('1.1.1.1', 443, EMPTY_POLICY)).toBe(true);
  });

  it('allows only listed hosts once an allowlist exists', () => {
    const p = policy({ allowedHosts: ['registry.npmjs.org', '*.example.com'], credentials: [] });
    expect(hostAllowed('registry.npmjs.org', 443, p)).toBe(true);
    expect(hostAllowed('a.example.com', 443, p)).toBe(true);
    expect(hostAllowed('example.com', 443, p)).toBe(false);
    expect(hostAllowed('evil.com', 443, p)).toBe(false);
    expect(hostAllowed('1.1.1.1', 443, p)).toBe(false);
  });

  it('implies the configured credentials hosts, so a narrow list cannot sever them', () => {
    const p = policy({ allowedHosts: ['registry.npmjs.org'] });
    expect(hostAllowed('api.anthropic.com', 443, p)).toBe(true);
    expect(hostAllowed('raw.githubusercontent.com', 443, p)).toBe(true);
    expect(hostAllowed('evil.com', 443, p)).toBe(false);
  });

  it('allows another port only when a pattern names it', () => {
    expect(hostAllowed('example.com', 8443, EMPTY_POLICY)).toBe(false);
    const p = policy({ allowedHosts: ['mcp.example.com:8443'], credentials: [] });
    expect(hostAllowed('mcp.example.com', 8443, p)).toBe(true);
    expect(hostAllowed('mcp.example.com', 443, p)).toBe(false);
    const keyed = policy({ credentials: [{ ...GITHUB, hosts: ['mcp.example.com:8443'] }] });
    expect(hostAllowed('mcp.example.com', 8443, keyed)).toBe(true);
    expect(hostAllowed('mcp.example.com', 9000, keyed)).toBe(false);
  });
});

describe('isInjectionHost', () => {
  it('is true only for a credential host, and only with a CA to intercept with', () => {
    expect(isInjectionHost('api.github.com', 443, policy())).toBe(true);
    expect(isInjectionHost('example.com', 443, policy())).toBe(false);
    expect(isInjectionHost('api.github.com', 443, policy({ ca: null }))).toBe(false);
    expect(isInjectionHost('api.github.com', 443, policy({ credentials: [CLAUDE] }))).toBe(false);
  });

  it('takes the port into account', () => {
    expect(isInjectionHost('api.github.com', 8443, policy())).toBe(false);
    const keyed = policy({ credentials: [{ ...GITHUB, hosts: ['mcp.example.com:8443'] }] });
    expect(isInjectionHost('mcp.example.com', 8443, keyed)).toBe(true);
    expect(isInjectionHost('mcp.example.com', 443, keyed)).toBe(false);
  });
});

describe('credentialsForHost', () => {
  it('maps a host to only its own credentials', () => {
    expect(credentialsForHost('api.anthropic.com', 443, policy()).map((c) => c.id)).toEqual([
      'claude',
    ]);
    expect(credentialsForHost('github.com', 443, policy()).map((c) => c.id)).toEqual(['github']);
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
    expect(
      swapCredentialValue('Bearer somebody-elses-token', GITHUB.placeholder, GITHUB.secret),
    ).toBeNull();
    const basic = `Basic ${Buffer.from('user:somebody-elses-token').toString('base64')}`;
    expect(swapCredentialValue(basic, GITHUB.placeholder, GITHUB.secret)).toBeNull();
    expect(swapCredentialValue('Bearer x', '', GITHUB.secret)).toBeNull();
  });
});

describe('decideCredentials', () => {
  it('passes a host with no credential configured straight through', () => {
    expect(
      decideCredentials('example.com', 443, { authorization: 'Bearer anything' }, policy()),
    ).toEqual({ action: 'pass' });
  });

  it('passes an unauthenticated request to a credential host', () => {
    expect(decideCredentials('api.github.com', 443, { accept: '*/*' }, policy())).toEqual({
      action: 'pass',
    });
    expect(decideCredentials('api.github.com', 443, { authorization: '  ' }, policy())).toEqual({
      action: 'pass',
    });
  });

  it('swaps the placeholder for the real credential', () => {
    const verdict = decideCredentials(
      'api.github.com',
      443,
      { authorization: `Bearer ${GITHUB.placeholder}` },
      policy(),
    );
    expect(verdict).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${GITHUB.secret}` },
      credentialIds: ['github'],
    });
  });

  it('forwards every value without a placeholder unchanged', () => {
    const basicJwt = `Basic ${Buffer.from('someone:eyJhbGciOi.x.y').toString('base64')}`;
    for (const authorization of [
      'Bearer ghp_someoneElsesToken',
      'tunnel eyJhbGciOi.x.y',
      'RemoteAuth abc',
      basicJwt,
    ]) {
      expect(decideCredentials('api.github.com', 443, { authorization }, policy())).toEqual({
        action: 'pass',
      });
    }
  });

  it('reads only the first value of a repeated header', () => {
    expect(
      decideCredentials(
        'api.github.com',
        443,
        { authorization: [`Bearer ${GITHUB.placeholder}`, 'Bearer ghp_someoneElsesToken'] },
        policy(),
      ),
    ).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${GITHUB.secret}` },
      credentialIds: ['github'],
    });
    expect(
      decideCredentials(
        'api.github.com',
        443,
        { authorization: ['Bearer ghp_someoneElsesToken', `Bearer ${GITHUB.placeholder}`] },
        policy(),
      ),
    ).toEqual({ action: 'pass' });
  });

  it('swaps a credential that names no header in whatever header carries it', () => {
    const anyHeader = policy({ credentials: [OPENROUTER] });
    expect(
      decideCredentials(
        'openrouter.ai',
        443,
        { 'x-custom-key': OPENROUTER.placeholder, accept: '*/*' },
        anyHeader,
      ),
    ).toEqual({
      action: 'swap',
      headers: { 'x-custom-key': OPENROUTER.secret },
      credentialIds: ['openrouter'],
    });
  });

  it('passes other values for a credential that names no header', () => {
    const anyHeader = policy({ credentials: [OPENROUTER] });
    expect(
      decideCredentials(
        'openrouter.ai',
        443,
        { authorization: 'Bearer sk-or-v1-other' },
        anyHeader,
      ),
    ).toEqual({ action: 'pass' });
  });

  it("does not swap another credential host's placeholder, so hosts do not share", () => {
    const verdict = decideCredentials(
      'api.github.com',
      443,
      { authorization: `Bearer ${CLAUDE.placeholder}` },
      policy(),
    );
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('swaps the key Codex sends at api.openai.com', () => {
    expect(
      decideCredentials(
        'api.openai.com',
        443,
        { authorization: `Bearer ${OPENAI.placeholder}` },
        policy(),
      ),
    ).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${OPENAI.secret}` },
      credentialIds: ['openai'],
    });
    expect(
      decideCredentials(
        'api.openai.com',
        443,
        { authorization: 'Bearer sk-somebodyelses' },
        policy(),
      ),
    ).toEqual({ action: 'pass' });
    expect(
      decideCredentials(
        'api.openai.com',
        443,
        { authorization: `Bearer ${CLAUDE.placeholder}` },
        policy(),
      ),
    ).toEqual({ action: 'pass' });
    // chatgpt.com, the subscription endpoint, has no credential, so any value passes there.
    expect(isInjectionHost('chatgpt.com', 443, policy())).toBe(false);
    expect(
      decideCredentials('chatgpt.com', 443, { authorization: 'Bearer whatever' }, policy()),
    ).toEqual({ action: 'pass' });
  });

  it('checks every header a credential may travel in', () => {
    expect(
      decideCredentials('api.anthropic.com', 443, { 'x-api-key': CLAUDE.placeholder }, policy()),
    ).toEqual({
      action: 'swap',
      headers: { 'x-api-key': CLAUDE.secret },
      credentialIds: ['claude'],
    });
    expect(
      decideCredentials('api.anthropic.com', 443, { 'x-api-key': 'sk-ant-someoneelse' }, policy()),
    ).toEqual({ action: 'pass' });
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
  });

  it('never echoes a secret', () => {
    const hash = policyHash(policy());
    expect(hash).not.toContain(GITHUB.secret);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('parsePolicy', () => {
  /** A valid policy with one credential. */
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

  it('accepts the empty policy the proxy boots with', () => {
    expect(parsePolicy({ allowedHosts: [], ca: null, credentials: [] })).toEqual(EMPTY_POLICY);
  });

  it('rejects an allowlist entry that would allow everything', () => {
    expect(() => parsePolicy({ ...valid, allowedHosts: ['*'] })).toThrow(/bare \*/);
    expect(() => parsePolicy({ ...valid, allowedHosts: ['api.*.com'] })).toThrow(/leading/);
  });

  it('accepts a host pattern with a port and rejects a port out of range', () => {
    expect(parsePolicy({ ...valid, allowedHosts: ['mcp.example.com:8443'] }).allowedHosts).toEqual([
      'mcp.example.com:8443',
    ]);
    expect(() => parsePolicy({ ...valid, allowedHosts: ['mcp.example.com:0'] })).toThrow(/port/);
    expect(() =>
      parsePolicy({ ...valid, credentials: [{ ...GITHUB, hosts: ['github.com:70000'] }] }),
    ).toThrow(/port/);
  });

  it('rejects a credential that cannot be translated or is not a translation', () => {
    expect(() => parsePolicy({ ...valid, ca: null })).toThrow(/without a CA/);
    expect(() =>
      parsePolicy({ ...valid, credentials: [{ ...GITHUB, secret: GITHUB.placeholder }] }),
    ).toThrow(/equal to its secret/);
    expect(() => parsePolicy({ ...valid, credentials: [{ ...GITHUB, hosts: [] }] })).toThrow(
      /at least one host/,
    );
  });

  it('accepts a credential that names no header', () => {
    const parsed = parsePolicy({ ...valid, credentials: [{ ...GITHUB, headers: [] }] });
    expect(parsed.credentials[0]?.headers).toEqual([]);
  });

  it('rejects anything that is not a policy at all', () => {
    expect(() => parsePolicy(null)).toThrow(/not an object/);
    expect(() => parsePolicy({ allowedHosts: 'github.com' })).toThrow(/must be an array/);
  });
});
