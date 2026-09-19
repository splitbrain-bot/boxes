import { test } from 'vitest';
import assert from 'node:assert/strict';
import { allocateSubnet, formatIpv4, parseCidr } from './subnet.ts';

test('parses and normalises a CIDR', () => {
  assert.deepEqual(parseCidr('10.200.0.0/16'), { base: 0x0ac80000, prefix: 16 });
  // Host bits are masked off.
  assert.deepEqual(parseCidr('10.200.5.7/16'), { base: 0x0ac80000, prefix: 16 });
});

test('rejects malformed CIDRs', () => {
  assert.throws(() => parseCidr('10.200.0.0'));
  assert.throws(() => parseCidr('10.200.0/16'));
  assert.throws(() => parseCidr('10.200.0.300/16'));
  assert.throws(() => parseCidr('10.200.0.0/33'));
});

test('formats 32-bit values back to dotted quads', () => {
  assert.equal(formatIpv4(0x0ac80000), '10.200.0.0');
  assert.equal(formatIpv4(0xffffffff), '255.255.255.255');
});

/** Nothing is allocated yet, which is where most of these cases start. */
const FREE = new Set<string>();

test('allocates sequential /24s from the pool', () => {
  assert.equal(allocateSubnet('10.200.0.0/16', 0, FREE), '10.200.0.0/24');
  assert.equal(allocateSubnet('10.200.0.0/16', 1, FREE), '10.200.1.0/24');
  assert.equal(allocateSubnet('10.200.0.0/16', 255, FREE), '10.200.255.0/24');
});

test('wraps when the pool is exhausted', () => {
  assert.equal(allocateSubnet('10.200.0.0/16', 256, FREE), '10.200.0.0/24');
  assert.equal(allocateSubnet('10.200.0.0/16', 257, FREE), '10.200.1.0/24');
});

test('steps over the subnets that are taken', () => {
  // The wrap the counter produces lands on the first session's subnet, which
  // is the collision this set exists to prevent.
  const taken = new Set(['10.200.0.0/24', '10.200.1.0/24']);
  assert.equal(allocateSubnet('10.200.0.0/16', 256, taken), '10.200.2.0/24');
  // And it wraps while stepping, rather than stopping at the pool's end.
  assert.equal(allocateSubnet('10.200.0.0/16', 255, taken), '10.200.255.0/24');
  assert.equal(
    allocateSubnet('10.200.0.0/16', 255, new Set([...taken, '10.200.255.0/24'])),
    '10.200.2.0/24',
  );
});

test('says so when every subnet in the pool is taken', () => {
  // /20 holds 16 /24s, and all of them are on a session.
  const all = new Set(Array.from({ length: 16 }, (_, i) => `172.31.${i}.0/24`));
  assert.equal(allocateSubnet('172.31.0.0/20', 0, all), null);
});

test('honours a pool that is not a /16', () => {
  assert.equal(allocateSubnet('172.31.0.0/20', 0, FREE), '172.31.0.0/24');
  assert.equal(allocateSubnet('172.31.0.0/20', 15, FREE), '172.31.15.0/24');
  // /20 holds 16 /24s, so index 16 wraps.
  assert.equal(allocateSubnet('172.31.0.0/20', 16, FREE), '172.31.0.0/24');
});

test('rejects a pool smaller than a /24', () => {
  assert.throws(() => allocateSubnet('10.0.0.0/25', 0, FREE));
});
