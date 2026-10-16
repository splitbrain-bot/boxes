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

/** An empty set of taken subnets. */
const FREE = new Set<string>();

test('allocates the first /24 of the pool', () => {
  assert.equal(allocateSubnet('10.200.0.0/16', FREE), '10.200.0.0/24');
});

test('steps over the subnets that are taken', () => {
  const taken = new Set(['10.200.0.0/24', '10.200.1.0/24', '10.200.3.0/24']);
  assert.equal(allocateSubnet('10.200.0.0/16', taken), '10.200.2.0/24');
});

test('says so when every subnet in the pool is taken', () => {
  // /20 holds 16 /24s, and all of them are on a box.
  const all = new Set(Array.from({ length: 16 }, (_, i) => `172.31.${i}.0/24`));
  assert.equal(allocateSubnet('172.31.0.0/20', all), null);
});

test('honours a pool that is not a /16', () => {
  assert.equal(allocateSubnet('172.31.0.0/20', FREE), '172.31.0.0/24');
  const fifteen = new Set(Array.from({ length: 15 }, (_, i) => `172.31.${i}.0/24`));
  assert.equal(allocateSubnet('172.31.0.0/20', fifteen), '172.31.15.0/24');
});

test('rejects a pool smaller than a /24', () => {
  assert.throws(() => allocateSubnet('10.0.0.0/25', FREE));
});
