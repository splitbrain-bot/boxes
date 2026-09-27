/**
 * Allocation of one /24 per box out of BOX_SUBNET_POOL. Docker requires each
 * box network to have a subnet of its own.
 */

/** An IPv4 CIDR in the form the allocator works with. */
export interface ParsedCidr {
  /** Network base as a 32-bit unsigned integer. */
  base: number;
  /** Prefix length in bits. */
  prefix: number;
}

/** Parses an IPv4 CIDR, masking off any host bits. Throws if malformed. */
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
  // Clear the host bits.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, prefix };
}

/** Renders a 32-bit unsigned integer as a dotted quad. */
export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/**
 * Returns the first free /24 inside pool, starting at the index-th and
 * wrapping around, or null when `taken` holds every one of them.
 *
 * The index comes from a counter that only rises, while deleted boxes give
 * their subnets back. The wrap reuses those subnets, and `taken` keeps it
 * from handing out one that a box still holds.
 */
export function allocateSubnet(
  pool: string,
  index: number,
  taken: ReadonlySet<string>,
): string | null {
  const { base, prefix } = parseCidr(pool);
  if (prefix > 24) throw new Error(`Pool ${pool} is smaller than a /24`);
  const slots = 2 ** (24 - prefix);
  for (let step = 0; step < slots; step++) {
    const slot = (((index + step) % slots) + slots) % slots;
    const subnet = `${formatIpv4((base + slot * 256) >>> 0)}/24`;
    if (!taken.has(subnet)) return subnet;
  }
  return null;
}
