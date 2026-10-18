/**
 * Allocation of one /24 per box out of BOX_SUBNET_POOL, for the box networks of the
 * Docker runtime. Docker refuses a network whose subnet overlaps the subnet of another network.
 */

/** An IPv4 CIDR in the form the allocator works with. */
export interface ParsedCidr {
  /** Network base as a 32-bit unsigned integer. */
  base: number;
  /** Prefix length in bits. */
  prefix: number;
}

/**
 * Parses an IPv4 CIDR, and masks off any host bits.
 *
 * @param cidr The CIDR, for example `10.200.0.0/16`.
 * @returns The network base and the prefix length.
 * @throws Error when the CIDR is malformed.
 */
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
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, prefix };
}

/**
 * Renders a 32-bit unsigned integer as a dotted quad.
 *
 * @param value The address as an unsigned integer.
 * @returns The dotted quad.
 */
export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * Returns the first free /24 inside a pool.
 *
 * @param pool The pool, as a CIDR.
 * @param taken The /24 subnets in use.
 * @returns The first /24 that `taken` does not hold, or null when it holds every one of them.
 * @throws Error when the pool is malformed or smaller than a /24.
 */
export function allocateSubnet(pool: string, taken: ReadonlySet<string>): string | null {
  const { base, prefix } = parseCidr(pool);
  if (prefix > 24) throw new Error(`Pool ${pool} is smaller than a /24`);
  const slots = 2 ** (24 - prefix);
  for (let slot = 0; slot < slots; slot++) {
    const subnet = `${formatIpv4((base + slot * 256) >>> 0)}/24`;
    if (!taken.has(subnet)) return subnet;
  }
  return null;
}
