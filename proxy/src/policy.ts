/** Pure functions over the egress policy. */

import { createHash } from 'node:crypto';
import { DEFAULT_PORTS, hostMatches, splitHostPattern } from '../../shared/hosts.ts';
import type { EgressCredential, EgressPolicy } from '../../shared/types.ts';

/** The policy of a proxy before the first push. It is frozen, because all callers share the same object. */
export const EMPTY_POLICY: EgressPolicy = Object.freeze({
  allowedHosts: Object.freeze([] as string[]),
  ca: null,
  credentials: Object.freeze([] as EgressCredential[]),
}) as EgressPolicy;

/**
 * Checks if a hostname and a port match one of the patterns.
 *
 * @param host The hostname or IP literal.
 * @param port The destination port.
 * @param patterns The host patterns.
 * @returns True when the host and the port match at least one pattern.
 */
function hostMatchesAny(host: string, port: number, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatches(host, port, p));
}

/**
 * Checks if the policy allows a host on a port. An empty allowlist allows
 * every host on the ports in {@link DEFAULT_PORTS}.
 *
 * @param host The hostname or IP literal.
 * @param port The destination port.
 * @param policy The policy to check against.
 * @returns True when the allowlist or the hosts of a credential match the host and the port.
 */
export function hostAllowed(host: string, port: number, policy: EgressPolicy): boolean {
  if (policy.allowedHosts.length === 0 && DEFAULT_PORTS.has(port)) return true;
  if (hostMatchesAny(host, port, policy.allowedHosts)) return true;
  // The hosts of a credential are always allowed, so a narrow allowlist cannot
  // cut off the traffic that the proxy authenticates.
  return policy.credentials.some((c) => hostMatchesAny(host, port, c.hosts));
}

/**
 * Finds the credentials configured for a host on a port.
 *
 * @param host The hostname or IP literal.
 * @param port The destination port.
 * @param policy The policy to search.
 * @returns The credentials for the host and the port, in policy order.
 */
export function credentialsForHost(
  host: string,
  port: number,
  policy: EgressPolicy,
): EgressCredential[] {
  return policy.credentials.filter((c) => hostMatchesAny(host, port, c.hosts));
}

/**
 * Checks if the proxy intercepts the TLS of a host on a port.
 *
 * @param host The hostname or IP literal.
 * @param port The destination port.
 * @param policy The policy to check against.
 * @returns True when the policy has a CA and a credential for the host and the port.
 */
export function isInjectionHost(host: string, port: number, policy: EgressPolicy): boolean {
  return policy.ca !== null && credentialsForHost(host, port, policy).length > 0;
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
  | { action: 'swap'; headers: Record<string, string>; credentialIds: string[] };

/**
 * Finds the first value of a header.
 * Names are compared in lower case, so the capitalisation of a client cannot hide a header.
 *
 * @param headers The request headers.
 * @param name The header name.
 * @returns The first value, or undefined when the header is missing.
 */
function firstHeaderValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === wanted)
    .flatMap(([, raw]) => raw ?? [])[0];
}

/**
 * Decides which headers of a request to an intercepted host get a real credential.
 *
 * The function reads the first value of each header that a credential of the
 * host names. When a credential names no header, the function reads every
 * header. A value with the placeholder of a credential gets the real
 * credential. All other values stay unchanged, and the host decides if it
 * accepts them.
 *
 * @param host The hostname of the request.
 * @param port The destination port of the request.
 * @param headers The request headers.
 * @param policy The policy that holds the credentials.
 * @returns The verdict for the request.
 */
export function decideCredentials(
  host: string,
  port: number,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  policy: EgressPolicy,
): CredentialVerdict {
  const credentials = credentialsForHost(host, port, policy);
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
    const present = firstHeaderValue(headers, name);
    if (present === undefined || present.trim() === '') continue;

    // Credentials that may travel in this header, in policy order.
    const candidates = credentials.filter(
      (c) => c.headers.length === 0 || c.headers.includes(name),
    );
    for (const credential of candidates) {
      const swapped = swapCredentialValue(present, credential.placeholder, credential.secret);
      if (swapped !== null) {
        replacements[name] = swapped;
        used.push(credential.id);
        break;
      }
    }
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

  const checkPort = (pattern: string, field: string): void => {
    const { port } = splitHostPattern(pattern);
    if (port !== null && (port < 1 || port > 65535))
      fail(`${field} entry ${pattern} has no valid port`);
  };

  const allowedHosts = stringArray(raw.allowedHosts ?? [], 'allowedHosts');
  for (const pattern of allowedHosts) {
    if (pattern === '*') return fail('a bare * allowlist entry would allow everything');
    if (pattern.includes('*') && !pattern.startsWith('*.')) {
      return fail(`allowlist entry ${pattern} may only use a leading *. wildcard`);
    }
    checkPort(pattern, 'allowlist');
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
    for (const host of hosts) checkPort(host, `credential ${id} hosts`);
    const headers = stringArray(c.headers, `credential ${id} headers`).map((h) => h.toLowerCase());
    return { id, hosts, headers, placeholder, secret };
  });

  if (credentials.length > 0 && ca === null) {
    return fail('credentials cannot be translated without a CA to intercept with');
  }
  return { allowedHosts, ca, credentials };
}
