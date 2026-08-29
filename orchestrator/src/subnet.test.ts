import { test } from 'node:test';
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

test('allocates sequential /24s from the pool', () => {
  assert.equal(allocateSubnet('10.200.0.0/16', 0), '10.200.0.0/24');
  assert.equal(allocateSubnet('10.200.0.0/16', 1), '10.200.1.0/24');
  assert.equal(allocateSubnet('10.200.0.0/16', 255), '10.200.255.0/24');
});

test('wraps when the pool is exhausted', () => {
  assert.equal(allocateSubnet('10.200.0.0/16', 256), '10.200.0.0/24');
  assert.equal(allocateSubnet('10.200.0.0/16', 257), '10.200.1.0/24');
});

test('honours a pool that is not a /16', () => {
  assert.equal(allocateSubnet('172.31.0.0/20', 0), '172.31.0.0/24');
  assert.equal(allocateSubnet('172.31.0.0/20', 15), '172.31.15.0/24');
  // /20 holds 16 /24s, so index 16 wraps.
  assert.equal(allocateSubnet('172.31.0.0/20', 16), '172.31.0.0/24');
});

test('rejects a pool smaller than a /24', () => {
  assert.throws(() => allocateSubnet('10.0.0.0/25', 0));
});
