/** Pure functions over the egress policy. */

import { createHash } from 'node:crypto';
import net from 'node:net';
import type { EgressCredential, EgressPolicy } from '../../shared/types.ts';

/** The policy of a proxy before the first push. It is frozen, because all callers share the same object. */
export const EMPTY_POLICY: EgressPolicy = Object.freeze({
  allowedHosts: Object.freeze([] as string[]),
  ca: null,
  credentials: Object.freeze([] as EgressCredential[]),
}) as EgressPolicy;

/**
 * Checks if a hostname matches one allowlist pattern.
 *
 * A pattern is an exact name or *.example.com, where the star stands for
 * exactly one label. So *.example.com matches api.example.com, but not
 * example.com or a.b.example.com. Matching ignores case and a trailing dot. An
 * IP literal matches only an identical literal.
 *
 * @param host The hostname or IP literal.
 * @param pattern The allowlist pattern.
 * @returns True when the host matches the pattern.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (h === '' || p === '') return false;

  if (!p.startsWith('*.')) return h === p;
  if (net.isIP(h) !== 0) return false;

  const suffix = p.slice(2);
  if (suffix === '' || suffix.includes('*')) return false;
  if (!h.endsWith(`.${suffix}`)) return false;
  const label = h.slice(0, h.length - suffix.length - 1);
  return label !== '' && !label.includes('.');
}

/**
 * Checks if a hostname matches one of the patterns.
 *
 * @param host The hostname or IP literal.
 * @param patterns The allowlist patterns.
 * @returns True when the host matches at least one pattern.
 */
function hostMatchesAny(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatches(host, p));
}

/**
 * Checks if the policy allows a host. An empty allowlist allows every host.
 *
 * @param host The hostname or IP literal.
 * @param policy The policy to check against.
 * @returns True when the allowlist or the hosts of a credential match the host.
 */
export function hostAllowed(host: string, policy: EgressPolicy): boolean {
  if (policy.allowedHosts.length === 0) return true;
  if (hostMatchesAny(host, policy.allowedHosts)) return true;
  // The hosts of a credential are always allowed, so a narrow allowlist cannot
  // cut off the traffic that the proxy authenticates.
  return policy.credentials.some((c) => hostMatchesAny(host, c.hosts));
}

/**
 * Finds the credentials configured for a host.
 *
 * @param host The hostname or IP literal.
 * @param policy The policy to search.
 * @returns The credentials for the host, in policy order.
 */
export function credentialsForHost(host: string, policy: EgressPolicy): EgressCredential[] {
  return policy.credentials.filter((c) => hostMatchesAny(host, c.hosts));
}

/**
 * Checks if the proxy intercepts the TLS of a host.
 *
 * @param host The hostname or IP literal.
 * @param policy The policy to check against.
 * @returns True when the policy has a CA and a credential for the host.
 */
export function isInjectionHost(host: string, policy: EgressPolicy): boolean {
  return policy.ca !== null && credentialsForHost(host, policy).length > 0;
}

/**
 * Lists every host pattern that the policy intercepts, for logging.
 *
 * @param policy The policy to read.
 * @returns The host patterns of all credentials, without duplicates.
 */
export function injectionPatterns(policy: EgressPolicy): string[] {
  return [...new Set(policy.credentials.flatMap((c) => c.hosts))];
}

/**
 * Rewrites one header value so it holds the secret in place of the placeholder.
 *
 * The placeholder can appear as it is (Bearer <p>, token <p>, or the bare
 * value), or inside the decoded user:password of HTTP Basic. The credential
 * helper of git sends HTTP Basic.
 *
 * @param value The header value.
 * @param placeholder The placeholder to replace.
 * @param secret The real credential.
 * @returns The rewritten value, or null when the value does not hold the placeholder.
 */
export function swapCredentialValue(
  value: string,
  placeholder: string,
  secret: string,
): string | null {
  if (placeholder === '') return null;
  if (value.includes(placeholder)) return value.split(placeholder).join(secret);

  const basic = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value);
  if (!basic?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.includes(placeholder)) return null;
  const swapped = decoded.split(placeholder).join(secret);
  return `Basic ${Buffer.from(swapped, 'utf8').toString('base64')}`;
}

/** What the proxy does with one intercepted request. */
export type CredentialVerdict =
  /** Forward the request unchanged, because no header of it holds a placeholder. */
  | { action: 'pass' }
  /** Forward the request with the values in headers. credentialIds names the credentials that were swapped in. */
  | { action: 'swap'; headers: Record<string, string>; credentialIds: string[] }
  /** Refuse the request, so a foreign credential does not reach the host. reason says why. */
  | { action: 'deny'; reason: string };

/**
 * Finds the value of a header. For an array value, only the first entry counts.
 * Names are compared in lower case, so the capitalisation of a client cannot hide a header.
 *
 * @param headers The request headers.
 * @param name The header name.
 * @returns The value, or null when the header is missing or blank.
 */
function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.trim() === '') continue;
    return value;
  }
  return null;
}

/**
 * Finds the authorization scheme that a header value starts with.
 *
 * @param value The header value.
 * @returns The scheme in lower case, or null when the value is not a scheme followed by a credential.
 */
function schemeOf(value: string): string | null {
  return /^\s*([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s+\S/.exec(value)?.[1]?.toLowerCase() ?? null;
}

/**
 * Decides what a request to an intercepted host may carry.
 *
 * The function reads each header that a credential of the host names. When a
 * credential names no header, the function reads every header. A header with a
 * placeholder gets the real credential. A named header under a pass-through
 * scheme of its credential stays unchanged, because the host issued that value.
 * A named header with any other value refuses the request, so no foreign
 * credential reaches the host. All other headers stay unchanged.
 *
 * A request without these headers passes, so an agent can still log in with a
 * session cookie.
 *
 * @param host The hostname of the request.
 * @param headers The request headers.
 * @param policy The policy that holds the credentials.
 * @returns The verdict for the request.
 */
export function decideCredentials(
  host: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  policy: EgressPolicy,
): CredentialVerdict {
  const credentials = credentialsForHost(host, policy);
  if (credentials.length === 0) return { action: 'pass' };

  // Pseudo-headers carry the request line, never a credential.
  const sent = credentials.some((c) => c.headers.length === 0)
    ? Object.keys(headers)
        .map((h) => h.toLowerCase())
        .filter((h) => !h.startsWith(':'))
    : [];
  const names = [...new Set([...credentials.flatMap((c) => c.headers), ...sent])];
  const replacements: Record<string, string> = {};
  const used: string[] = [];

  for (const name of names) {
    const present = headerValue(headers, name);
    if (present === null) continue;

    // Credentials that may travel in this header, in policy order. The first
    // credential with its placeholder in the value is swapped in.
    const candidates = credentials.filter(
      (c) => c.headers.length === 0 || c.headers.includes(name),
    );
    let swapped: string | null = null;
    for (const credential of candidates) {
      swapped = swapCredentialValue(present, credential.placeholder, credential.secret);
      if (swapped !== null) {
        used.push(credential.id);
        break;
      }
    }
    if (swapped === null) {
      const named = candidates.filter((c) => c.headers.includes(name));
      if (named.length === 0) continue;
      const scheme = schemeOf(present);
      if (scheme !== null && named.some((c) => c.passthroughSchemes?.includes(scheme))) {
        continue;
      }
      return {
        action: 'deny',
        reason: `foreign credential in ${name} for ${named[0]?.id ?? host}`,
      };
    }
    replacements[name] = swapped;
  }

  if (used.length === 0) return { action: 'pass' };
  return { action: 'swap', headers: replacements, credentialIds: [...new Set(used)] };
}

/**
 * Makes a stable fingerprint of a policy for the status of the proxy. The
 * fingerprint uses only hashes of the secrets, because the status travels over
 * the control channel.
 *
 * @param policy The policy to fingerprint.
 * @returns 32 hex digits, which ignore the order of the lists and the case of the hosts.
 */
export function policyHash(policy: EgressPolicy): string {
  const canonical = JSON.stringify({
    allowedHosts: [...policy.allowedHosts].map((h) => h.toLowerCase()).sort(),
    ca: policy.ca ? createHash('sha256').update(policy.ca.cert).digest('hex') : null,
    credentials: [...policy.credentials]
      .map((c) => ({
        id: c.id,
        hosts: [...c.hosts].map((h) => h.toLowerCase()).sort(),
        headers: [...c.headers].sort(),
        passthroughSchemes: [...(c.passthroughSchemes ?? [])].sort(),
        placeholder: createHash('sha256').update(c.placeholder).digest('hex'),
        secret: createHash('sha256').update(c.secret).digest('hex'),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Parses and validates a pushed policy.
 *
 * @param input The decoded JSON body of the push.
 * @returns The validated policy, with trimmed entries and header names in lower case.
 * @throws Error When the input is not a valid policy.
 */
export function parsePolicy(input: unknown): EgressPolicy {
  const fail = (why: string): never => {
    throw new Error(`invalid policy: ${why}`);
  };
  if (typeof input !== 'object' || input === null) return fail('not an object');
  const raw = input as Record<string, unknown>;

  const stringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value)) return fail(`${field} must be an array`);
    return value.map((v) => {
      if (typeof v !== 'string' || v.trim() === '') return fail(`${field} has an empty entry`);
      return v.trim();
    });
  };

  const allowedHosts = stringArray(raw.allowedHosts ?? [], 'allowedHosts');
  for (const pattern of allowedHosts) {
    if (pattern === '*') return fail('a bare * allowlist entry would allow everything');
    if (pattern.includes('*') && !pattern.startsWith('*.')) {
      return fail(`allowlist entry ${pattern} may only use a leading *. wildcard`);
    }
  }

  let ca: EgressPolicy['ca'] = null;
  const rawCa = raw.ca;
  if (rawCa !== null && rawCa !== undefined) {
    if (typeof rawCa !== 'object') return fail('ca must be an object or null');
    const { key, cert } = rawCa as Record<string, unknown>;
    if (typeof key !== 'string' || typeof cert !== 'string' || !key || !cert) {
      return fail('ca needs a key and a cert');
    }
    ca = { key, cert };
  }

  const rawCredentials = raw.credentials ?? [];
  if (!Array.isArray(rawCredentials)) return fail('credentials must be an array');
  const credentials = rawCredentials.map((entry, i): EgressCredential => {
    if (typeof entry !== 'object' || entry === null)
      return fail(`credential ${i} is not an object`);
    const c = entry as Record<string, unknown>;
    const id = c.id;
    const placeholder = c.placeholder;
    const secret = c.secret;
    if (typeof id !== 'string' || !id) return fail(`credential ${i} needs an id`);
    if (typeof placeholder !== 'string' || !placeholder) {
      return fail(`credential ${id} needs a placeholder`);
    }
    if (typeof secret !== 'string' || !secret) return fail(`credential ${id} needs a secret`);
    if (placeholder === secret) {
      return fail(`credential ${id} has a placeholder equal to its secret`);
    }
    const hosts = stringArray(c.hosts, `credential ${id} hosts`);
    if (hosts.length === 0) return fail(`credential ${id} needs at least one host`);
    const headers = stringArray(c.headers, `credential ${id} headers`).map((h) => h.toLowerCase());
    if (c.passthroughSchemes === undefined) return { id, hosts, headers, placeholder, secret };
    const passthroughSchemes = stringArray(
      c.passthroughSchemes,
      `credential ${id} passthroughSchemes`,
    ).map((scheme) => scheme.toLowerCase());
    for (const scheme of passthroughSchemes) {
      if (/\s/.test(scheme)) return fail(`credential ${id} has a pass-through scheme with a space`);
    }
    return { id, hosts, headers, passthroughSchemes, placeholder, secret };
  });

  if (credentials.length > 0 && ca === null) {
    return fail('credentials cannot be translated without a CA to intercept with');
  }
  return { allowedHosts, ca, credentials };
}
