import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as signWith,
} from 'node:crypto';
import { readAppKey, writeAppKey, type Db } from './db.ts';
import { log } from './log.ts';

/**
 * Web Push delivery on `node:crypto`: RFC 8291 payload encryption and RFC 8292
 * (VAPID) sender authentication.
 */

/** One browser's subscription, as the Push API hands it to the page. */
export interface PushSubscription {
  /** The push service URL to POST to. Opaque, and unique per subscription. */
  endpoint: string;
  /** The subscriber's public key, uncompressed P-256, base64url. */
  p256dh: string;
  /** The subscriber's authentication secret, 16 bytes, base64url. */
  auth: string;
}

/** The deployment's VAPID identity, base64url over the raw key material. */
export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes. Handed to the browser verbatim. */
  publicKey: string;
  /** The scalar, 32 bytes. Never leaves the orchestrator. */
  privateKey: string;
}

/** Record size the payload is written with; every message here fits one. */
const RECORD_SIZE = 4096;

/** What one record adds to its plaintext: the padding delimiter and the tag. */
const RECORD_OVERHEAD = 17;

/** How long a push service should hold an undelivered message, in seconds. */
const DEFAULT_TTL = 12 * 60 * 60;

/**
 * How long one delivery attempt may take, in milliseconds. The caller awaits
 * all browsers at once, so one silent push service would otherwise hold them.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Lifetime of a VAPID assertion. Well under the 24h RFC 8292 allows. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

/** The app key under which the generated keypair is stored. */
const APP_KEY = 'vapid';

/** Base64url of raw bytes, which is how every key and salt here travels. */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** The bytes behind a base64url string. */
function unb64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** HKDF-SHA256 over Node's one-shot, as a Buffer. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** A fresh P-256 keypair, in the raw form both halves of this file want. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    // A scalar with leading zero bytes comes back short of 32 bytes.
    privateKey: b64url(pad32(ecdh.getPrivateKey())),
  };
}

/** Left-pads a scalar to the 32 bytes P-256 uses. */
function pad32(scalar: Buffer): Buffer {
  if (scalar.length >= 32) return scalar;
  return Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
}

/**
 * The deployment's keypair, generated once and kept in the database. A new
 * keypair invalidates every subscription.
 */
export function loadVapidKeys(db: Db): VapidKeys {
  const stored = readAppKey<VapidKeys>(db, APP_KEY);
  if (stored) return stored;

  const keys = generateVapidKeys();
  writeAppKey(db, APP_KEY, keys);
  log.info('generated a VAPID keypair for this deployment');
  return keys;
}

// --- RFC 8291 payload encryption -------------------------------------------

/**
 * Encrypts one push message for one subscriber, producing a whole
 * `aes128gcm` body: header, then a single record.
 *
 * Throws for a plaintext that does not fit the one record.
 *
 * `salt` and `senderKeys` let a test pin the random inputs to the RFC's own.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscriberKey: Buffer,
  authSecret: Buffer,
  salt: Buffer = randomBytes(16),
  senderKeys: VapidKeys = generateVapidKeys(),
): Buffer {
  if (plaintext.length + RECORD_OVERHEAD > RECORD_SIZE) {
    throw new Error(
      `a push payload must be at most ${RECORD_SIZE - RECORD_OVERHEAD} bytes, ` +
        `and this one is ${plaintext.length}`,
    );
  }

  const senderPublic = unb64url(senderKeys.publicKey);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64url(senderKeys.privateKey));
  const shared = ecdh.computeSecret(subscriberKey);

  // Receiver key first, then sender key, as the RFC orders them.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    subscriberKey,
    senderPublic,
  ]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // 0x02 is the delimiter of the last record, and here the only one.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body]);
}

// --- RFC 8292 VAPID --------------------------------------------------------

/** The `aud` of a VAPID assertion: the push service's own origin. */
function audienceOf(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * The Authorization header proving this deployment sent the message.
 *
 * `subject` is the operator's contact for the push service, as a mailto: or
 * https: URL.
 */
export function vapidHeader(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number = Date.now(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audienceOf(endpoint),
        exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS,
        sub: subject,
      }),
      'utf8',
    ),
  );
  const signingInput = Buffer.from(`${header}.${claims}`, 'utf8');

  const publicKey = unb64url(keys.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(publicKey.subarray(1, 33)),
      y: b64url(publicKey.subarray(33, 65)),
    },
    format: 'jwk',
  });
  // JWS wants the raw r||s pair, not the DER sequence Node signs with by
  // default.
  const signature = signWith('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' });

  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

// --- sending ---------------------------------------------------------------

/** What one delivery attempt did, as the caller needs to see it. */
export interface PushResult {
  /** Whether the push service accepted the message. */
  ok: boolean;
  /** HTTP status from the push service, or 0 when it could not be reached. */
  status: number;
  /**
   * True when the subscription can never work again, so its row should go:
   * the push service answered 404 or 410, or the subscription keys are
   * malformed.
   */
  gone: boolean;
  /** Why the attempt failed, or null. Never carries the payload. */
  error: string | null;
}

/**
 * Posts one encrypted message to one push service.
 *
 * Never throws. Every failure comes back as a result the caller can log.
 */
export async function sendPush(
  subscription: PushSubscription,
  payload: string,
  keys: VapidKeys,
  subject: string,
  ttl: number = DEFAULT_TTL,
): Promise<PushResult> {
  let body: Buffer;
  try {
    body = encryptPayload(
      Buffer.from(payload, 'utf8'),
      unb64url(subscription.p256dh),
      unb64url(subscription.auth),
    );
  } catch (err) {
    // Malformed subscription keys never work, so the row counts as gone.
    return { ok: false, status: 0, gone: true, error: (err as Error).message };
  }

  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(subscription.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'high',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: res.ok ? null : `push service answered ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: (err as Error).message };
  }
}
