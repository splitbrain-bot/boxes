import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  encryptPayload,
  generateVapidKeys,
  loadVapidKeys,
  sendPush,
  vapidHeader,
} from './push.ts';

/**
 * Web Push encryption, against the published vectors rather than against
 * itself.
 *
 * The crypto here is hand-rolled on node:crypto, so "it round-trips" is not
 * enough: an implementation can be self-consistent and still produce a body
 * no browser can open. The RFC 8291 example pins every input, so matching its
 * output byte for byte is the thing worth asserting.
 */

/** The example from RFC 8291 section 5, with its intermediates from appendix A. */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const b64 = (value: string): Buffer => Buffer.from(value, 'base64url');

test('encryptPayload reproduces the RFC 8291 example byte for byte', () => {
  const body = encryptPayload(
    Buffer.from(RFC8291.plaintext, 'utf8'),
    b64(RFC8291.uaPublic),
    b64(RFC8291.authSecret),
    b64(RFC8291.salt),
    { publicKey: RFC8291.asPublic, privateKey: RFC8291.asPrivate },
  );
  assert.equal(body.toString('base64url'), RFC8291.body);
});

test('encryptPayload writes a header a receiver can parse', () => {
  const body = encryptPayload(
    Buffer.from('hello', 'utf8'),
    b64(RFC8291.uaPublic),
    b64(RFC8291.authSecret),
  );
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body.readUInt8(20), 65, 'key id length');
  // Uncompressed point, which is what every push service and browser expects.
  assert.equal(body.readUInt8(21), 0x04);
});

test('a subscriber can decrypt what encryptPayload produced', () => {
  // The receiver's side of RFC 8291, done independently of the sender's: the
  // round trip covers the random salt and ephemeral key the vector cannot.
  const message = 'Session muffin is waiting for a permission decision.';
  const body = encryptPayload(
    Buffer.from(message, 'utf8'),
    b64(RFC8291.uaPublic),
    b64(RFC8291.authSecret),
  );

  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body.readUInt8(20));
  const ciphertext = body.subarray(21 + body.readUInt8(20));

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64(RFC8291.uaPrivate));
  const shared = ecdh.computeSecret(senderPublic);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    b64(RFC8291.uaPublic),
    senderPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync('sha256', shared, b64(RFC8291.authSecret), keyInfo, 32),
  );
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // The last byte is the record delimiter, not content.
  assert.equal(plain.subarray(0, plain.length - 1).toString('utf8'), message);
  assert.equal(plain[plain.length - 1], 0x02);
});

test('generateVapidKeys produces a usable uncompressed P-256 pair', () => {
  const keys = generateVapidKeys();
  const publicKey = b64(keys.publicKey);
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 0x04);
  assert.equal(b64(keys.privateKey).length, 32);
});

test('vapidHeader signs a JWT the public key verifies', () => {
  const keys = generateVapidKeys();
  const header = vapidHeader('https://push.example.net/push/abc?x=1', keys, 'mailto:a@b.c');

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, `unexpected header shape: ${header}`);
  const [, jwt, sentKey] = match;
  assert.equal(sentKey, keys.publicKey);

  const [encodedHeader, encodedClaims, signature] = jwt!.split('.');
  const claims = JSON.parse(b64(encodedClaims!).toString('utf8')) as Record<string, unknown>;
  // The audience is the push service's origin, never the full endpoint: the
  // path is a capability and has no business in a token.
  assert.equal(claims['aud'], 'https://push.example.net');
  assert.equal(claims['sub'], 'mailto:a@b.c');
  assert.ok((claims['exp'] as number) > Date.now() / 1000);

  const publicKey = b64(keys.publicKey);
  const verifier = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`, 'utf8'),
      { key: verifier, dsaEncoding: 'ieee-p1363' },
      b64(signature!),
    ),
    'signature does not verify against the advertised key',
  );
});

/** Runs a case against a throwaway data dir. */
function withDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-push-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadVapidKeys generates once and reuses after', () => {
  withDataDir((dir) => {
    const first = loadVapidKeys(dir);
    const second = loadVapidKeys(dir);
    assert.deepEqual(first, second);
    // Regenerating would silently invalidate every subscription anybody made.
    assert.equal(statSync(join(dir, 'vapid-keys.json')).mode & 0o777, 0o600);
  });
});

test('loadVapidKeys replaces a malformed keyfile rather than failing to boot', () => {
  withDataDir((dir) => {
    const path = join(dir, 'vapid-keys.json');
    writeFileSync(path, 'not json at all');
    const keys = loadVapidKeys(dir);
    assert.equal(b64(keys.publicKey).length, 65);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).publicKey, keys.publicKey);
  });
});

test('sendPush reports a dead subscription rather than throwing', async () => {
  // A malformed key can never be encrypted for, which is as final as a 410.
  const result = await sendPush(
    { endpoint: 'https://push.example.net/x', p256dh: 'nonsense', auth: 'nonsense' },
    'body',
    generateVapidKeys(),
    'mailto:a@b.c',
  );
  assert.equal(result.ok, false);
  assert.equal(result.gone, true);
});

test('sendPush reports an unreachable push service rather than throwing', async () => {
  const result = await sendPush(
    {
      endpoint: 'https://127.0.0.1:1/push',
      p256dh: RFC8291.uaPublic,
      auth: RFC8291.authSecret,
    },
    'body',
    generateVapidKeys(),
    'mailto:a@b.c',
  );
  assert.equal(result.ok, false);
  // Unreachable is not gone: the subscription may well outlive the outage.
  assert.equal(result.gone, false);
  assert.ok(result.error);
});
