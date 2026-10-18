/**
 * Address checks of the egress proxy, which decide the addresses that an agent may connect to.
 */

/** IPv4 ranges an agent must never reach through the proxy. */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16], // link-local, including cloud metadata at 169.254.169.254
  ['127.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['0.0.0.0', 8],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
];

/**
 * Parses a dotted quad into a 32-bit unsigned integer.
 *
 * @param addr The IPv4 address in dotted quad form.
 * @returns The address as an unsigned integer, or null when the text is malformed.
 */
function v4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value;
}

/**
 * Checks if an IPv4 address is inside a range.
 *
 * @param value The address as an unsigned integer.
 * @param base The first address of the range, in dotted quad form.
 * @param prefix The prefix length of the range, in bits.
 * @returns True when the address is inside base/prefix.
 */
function inV4Range(value: number, base: string, prefix: number): boolean {
  const baseInt = v4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (baseInt & mask) >>> 0;
}

/**
 * Expands an IPv6 literal to its 8 groups of 16 bits.
 *
 * @param addr The IPv6 literal, optionally in brackets and with a zone ID.
 * @returns The 8 groups, or null when the literal is malformed.
 */
function parseV6(addr: string): number[] | null {
  let text = addr.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Strip a zone ID (fe80::1%eth0).
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text === '') return null;

  // A trailing dotted quad (v4-mapped and v4-compatible forms) becomes two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const trailing = text.slice(lastColon + 1);
  if (trailing.includes('.')) {
    const v4 = v4ToInt(trailing);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon + 1);
    if (text.endsWith('::')) {
      // keep the compression marker intact
    } else {
      text = text.slice(0, -1);
    }
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon === -1) {
    const groups = text === '' ? [] : text.split(':');
    if (groups.some((g) => g === '')) return null;
    const head = groups.map(hexGroup).filter((g): g is number => g !== null);
    if (head.length !== groups.length) return null;
    const all = [...head, ...tail];
    return all.length === 8 ? all : null;
  }

  if (text.indexOf('::', doubleColon + 1) !== -1) return null;
  const left = text.slice(0, doubleColon);
  const right = text.slice(doubleColon + 2);
  const leftGroups = left === '' ? [] : left.split(':');
  const rightGroups = right === '' ? [] : right.split(':');
  if (leftGroups.some((g) => g === '') || rightGroups.some((g) => g === '')) return null;

  const head = leftGroups.map(hexGroup).filter((g): g is number => g !== null);
  const mid = rightGroups.map(hexGroup).filter((g): g is number => g !== null);
  if (head.length !== leftGroups.length || mid.length !== rightGroups.length) return null;

  const explicit = head.length + mid.length + tail.length;
  if (explicit > 8) return null;
  const zeros = new Array<number>(8 - explicit).fill(0);
  return [...head, ...zeros, ...mid, ...tail];
}

/**
 * Parses one IPv6 group.
 *
 * @param text The group as text.
 * @returns The value of the group, or null when the text is not one to four hex digits.
 */
function hexGroup(text: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(text)) return null;
  return Number.parseInt(text, 16);
}

/**
 * Finds the IPv4 address that an IPv6 address embeds.
 *
 * The function knows the v4-mapped (::ffff:a.b.c.d), v4-translated (::ffff:0:a.b.c.d),
 * v4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) forms.
 *
 * @param groups The 8 groups of the IPv6 address.
 * @returns The embedded IPv4 address as an unsigned integer, or null when the address embeds none.
 */
function embeddedV4(groups: readonly number[]): number | null {
  const at = (i: number): number => groups[i] ?? 0;
  const zeros = (upTo: number): boolean => groups.slice(0, upTo).every((g) => g === 0);
  const low = (): number => ((at(6) << 16) | at(7)) >>> 0;

  if (zeros(5) && at(5) === 0xffff) return low(); // ::ffff:a.b.c.d
  if (zeros(4) && at(4) === 0xffff && at(5) === 0) return low(); // ::ffff:0:a.b.c.d
  if (zeros(6) && (at(6) !== 0 || at(7) !== 0)) return low(); // ::a.b.c.d
  // 64:ff9b::/96
  const nat64 = at(0) === 0x64 && at(1) === 0xff9b;
  if (nat64 && at(2) === 0 && at(3) === 0 && at(4) === 0 && at(5) === 0) return low();
  if (at(0) === 0x2002) return ((at(1) << 16) | at(2)) >>> 0; // 2002::/16
  return null;
}

/**
 * Checks if an address is in a range that an agent must not reach.
 *
 * @param address The IPv4 or IPv6 address.
 * @returns True when the address is blocked. Input that does not parse counts as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const text = address.trim();
  if (text === '') return true;

  const v4 = v4ToInt(text);
  if (v4 !== null) {
    return V4_BLOCKED.some(([base, prefix]) => inV4Range(v4, base, prefix));
  }

  const groups = parseV6(text);
  if (groups === null) return true;

  const embedded = embeddedV4(groups);
  if (embedded !== null) {
    return V4_BLOCKED.some(([base, prefix]) => inV4Range(embedded, base, prefix));
  }

  const [g0 = 0] = groups;
  // ::1/128 loopback and :: unspecified
  if (groups.every((g, i) => (i === 7 ? g === 1 || g === 0 : g === 0))) return true;
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Checks if every address of a DNS answer is safe to connect to.
 *
 * @param addresses The resolved addresses.
 * @returns True when the list has addresses and none of them is blocked.
 */
export function allAddressesAllowed(addresses: readonly string[]): boolean {
  if (addresses.length === 0) return false; // An empty answer fails closed.
  return addresses.every((a) => !isBlockedAddress(a));
}
