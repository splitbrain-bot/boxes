import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allAddressesAllowed, isBlockedAddress } from './cidr.ts';

test('blocks RFC1918 IPv4 ranges', () => {
  for (const addr of [
    '10.0.0.1',
    '10.200.5.2',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '192.168.0.0',
  ]) {
    assert.equal(isBlockedAddress(addr), true, `${addr} should be blocked`);
  }
});

test('blocks loopback, link-local, CGNAT and reserved ranges', () => {
  for (const addr of [
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
  ]) {
    assert.equal(isBlockedAddress(addr), true, `${addr} should be blocked`);
  }
});

test('allows ordinary public IPv4', () => {
  for (const addr of ['1.1.1.1', '8.8.8.8', '140.82.121.4', '172.15.0.1', '172.32.0.1']) {
    assert.equal(isBlockedAddress(addr), false, `${addr} should be allowed`);
  }
});

test('172.16/12 boundary is exact', () => {
  assert.equal(isBlockedAddress('172.15.255.255'), false);
  assert.equal(isBlockedAddress('172.16.0.0'), true);
  assert.equal(isBlockedAddress('172.31.255.255'), true);
  assert.equal(isBlockedAddress('172.32.0.0'), false);
});

test('blocks IPv6 loopback, ULA, link-local and multicast', () => {
  for (const addr of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::']) {
    assert.equal(isBlockedAddress(addr), true, `${addr} should be blocked`);
  }
});

test('allows public IPv6', () => {
  for (const addr of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isBlockedAddress(addr), false, `${addr} should be allowed`);
  }
});

test('vets v4-mapped IPv6 as the IPv4 address it reaches', () => {
  assert.equal(isBlockedAddress('::ffff:192.168.1.1'), true);
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('vets v4-compatible IPv6 as the IPv4 address it reaches', () => {
  assert.equal(isBlockedAddress('::192.168.1.1'), true);
  assert.equal(isBlockedAddress('::8.8.8.8'), false);
});

test('handles bracketed and zoned IPv6 literals', () => {
  assert.equal(isBlockedAddress('[::1]'), true);
  assert.equal(isBlockedAddress('fe80::1%eth0'), true);
});

test('fails closed on unparseable input', () => {
  for (const addr of ['', '   ', 'not-an-ip', '10.0.0', '10.0.0.256', 'gggg::1', '1::2::3']) {
    assert.equal(isBlockedAddress(addr), true, `${addr} should fail closed`);
  }
});

test('a multi-answer record is rejected if ANY address is private', () => {
  // The DNS-rebinding shape: one public answer, one private.
  assert.equal(allAddressesAllowed(['8.8.8.8', '192.168.1.1']), false);
  assert.equal(allAddressesAllowed(['192.168.1.1', '8.8.8.8']), false);
  assert.equal(allAddressesAllowed(['8.8.8.8', '1.1.1.1']), true);
});

test('an empty answer set fails closed', () => {
  assert.equal(allAddressesAllowed([]), false);
});
