/** Host patterns of the egress policy, and the match of a host and a port against them. */

/** The ports that a host pattern without a port matches. */
export const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);

/**
 * Splits a host pattern into its host and its optional port. An IPv6 literal
 * with a port is in brackets, as in [2001:db8::1]:8443.
 *
 * @param pattern The host pattern.
 * @returns The host part, and the port or null when the pattern names no port.
 */
export function splitHostPattern(pattern: string): { host: string; port: number | null } {
  const p = pattern.trim();
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(p);
  if (bracketed) {
    return { host: bracketed[1] ?? '', port: bracketed[2] ? Number(bracketed[2]) : null };
  }
  const withPort = /^([^:]*):(\d+)$/.exec(p);
  if (withPort) return { host: withPort[1] ?? '', port: Number(withPort[2]) };
  return { host: p, port: null };
}

/**
 * Checks if a hostname and a port match one host pattern.
 *
 * A pattern is an exact name or *.example.com, where the star stands for
 * exactly one label. So *.example.com matches api.example.com, but not
 * example.com or a.b.example.com. Matching ignores case and a trailing dot. An
 * IP literal matches only an identical literal. A pattern with a port, as in
 * mcp.example.com:8443, matches only that port. A pattern without a port
 * matches the ports in {@link DEFAULT_PORTS}.
 *
 * @param host The hostname or IP literal.
 * @param port The destination port.
 * @param pattern The host pattern.
 * @returns True when the host and the port match the pattern.
 */
export function hostMatches(host: string, port: number, pattern: string): boolean {
  const split = splitHostPattern(pattern);
  if (split.port === null ? !DEFAULT_PORTS.has(port) : split.port !== port) return false;

  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const p = split.host.toLowerCase().replace(/\.$/, '');
  if (h === '' || p === '') return false;

  if (!p.startsWith('*.')) return h === p;
  if (isIpLiteral(h)) return false;

  const suffix = p.slice(2);
  if (suffix === '' || suffix.includes('*')) return false;
  if (!h.endsWith(`.${suffix}`)) return false;
  const label = h.slice(0, h.length - suffix.length - 1);
  return label !== '' && !label.includes('.');
}

/**
 * Checks if a host is an IP literal.
 *
 * @param host The hostname or IP literal, in lower case and without brackets.
 * @returns True for an IPv4 or an IPv6 literal.
 */
function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}
