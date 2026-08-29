/**
 * Per-session /24 allocation out of SESSION_SUBNET_POOL.
 *
 * Docker still requires non-overlapping subnets, but no component filters on
 * these values any more — the egress proxy vets resolved IPs against the full
 * private ranges instead (plan §8.4). Pure and unit-tested.
 */

export interface ParsedCidr {
  /** Network base as a 32-bit unsigned integer. */
  base: number;
  prefix: number;
}

export function parseCidr(cidr: string): ParsedCidr {
  const [addr, prefixText] = cidr.split('/');
  if (!addr || prefixText === undefined) throw new Error(`Malformed CIDR: ${cidr}`);
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Malformed CIDR prefix: ${cidr}`);
  }
  const octets = addr.split('.');
  if (octets.length !== 4) throw new Error(`Malformed IPv4 address: ${cidr}`);
  let base = 0;
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`Malformed IPv4 address: ${cidr}`);
    }
    base = ((base << 8) | n) >>> 0;
  }
  // Normalise to the true network address.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, prefix };
}

export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * Returns the `index`-th /24 inside `pool`, wrapping when the pool is
 * exhausted so a long-lived deployment keeps allocating. Callers must ensure
 * the returned subnet is not already in use by a live network.
 */
export function allocateSubnet(pool: string, index: number): string {
  const { base, prefix } = parseCidr(pool);
  if (prefix > 24) throw new Error(`Pool ${pool} is smaller than a /24`);
  const slots = 2 ** (24 - prefix);
  const slot = ((index % slots) + slots) % slots;
  const network = (base + slot * 256) >>> 0;
  return `${formatIpv4(network)}/24`;
}
