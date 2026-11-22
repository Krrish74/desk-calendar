// webpush.js: sending a Web Push message, with nothing but the Web Crypto API.
//
// The usual library (`web-push`) needs Node.js, so this implements the two standards
// it's built on. Each push is a POST to the device's push service (for an iPhone,
// web.push.apple.com) with:
//
// 1. AN ENCRYPTED BODY (RFC 8291, "aes128gcm"): only the phone can read it.
//    The phone gave us its public key (p256dh) and a 16-byte secret (auth) when it
//    subscribed. For every message we:
//      a. make a fresh one-time key pair and do ECDH with the phone's key → shared secret
//      b. mix shared secret + auth secret + both public keys (HKDF) → input key material
//      c. pick a random 16-byte salt; HKDF again → a 16-byte AES key and a 12-byte nonce
//      d. AES-128-GCM-encrypt the JSON message (plus a 0x02 "last record" marker)
//      e. send: salt | record size | our one-time public key | ciphertext
//    Apple can deliver the message but can't read it.
//
// 2. A VAPID SIGNATURE (RFC 8292): proves the push comes from this server.
//    A small JWT { aud: push service origin, exp: +12 h, sub: our address } signed with
//    the VAPID private key (ES256), sent in the Authorization header with our public key.
//    The phone subscribed with that public key, so the push service only accepts pushes
//    signed by the matching private key.

import { b64url, b64urlDecode } from './crypto.js';

const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** HKDF-SHA-256 (extract + expand) → `length` bytes. */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/**
 * Encrypt `payload` (a string) for one subscription. Returns the request body.
 * `keys` = { p256dh, auth } from the subscription (base64url). `testing` lets tests fix
 * the random parts.
 */
export async function encryptPayload(payload, keys, testing = {}) {
  const uaPublic = b64urlDecode(keys.p256dh);   // the phone's public key (65 bytes)
  const authSecret = b64urlDecode(keys.auth);   // the phone's secret (16 bytes)
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Bad push subscription keys.');

  // a. One-time key pair + ECDH
  const local = testing.localKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  // b. Input key material
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // c. Content key + nonce
  const salt = testing.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // d. Encrypt (one record; 0x02 marks it as the last)
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // e. Header: salt (16) | record size (4, big-endian) | key id length (1) | our public key (65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// --- VAPID ---------------------------------------------------------------------------------

const vapidKeyCache = new Map();

async function vapidSigningKey(publicKey, privateKey) {
  const cacheKey = `${publicKey}|${privateKey.slice(0, 8)}`;
  if (!vapidKeyCache.has(cacheKey)) {
    const pub = b64urlDecode(publicKey); // 0x04 || x (32) || y (32)
    if (pub.length !== 65) throw new Error('VAPID_PUBLIC_KEY should be 65 bytes (base64url). Run npm run vapid.');
    const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: privateKey, ext: true };
    vapidKeyCache.set(cacheKey, await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']));
  }
  return vapidKeyCache.get(cacheKey);
}

/** The Authorization header for a push to `endpoint`: "vapid t=<JWT>, k=<public key>". */
export async function vapidHeader(endpoint, { publicKey, privateKey, subject }) {
  const jwtHeader = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const unsigned = `${jwtHeader}.${claims}`;
  // Web Crypto's ECDSA signature is already the r||s form JWTs use.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(publicKey, privateKey), enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${publicKey}`;
}

// --- Sending ---------------------------------------------------------------------------------

// Push services we'll talk to. The endpoint comes from the phone, so we only POST to
// known push services, never to an arbitrary address.
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function isAllowedEndpoint(endpoint, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return true;
  return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

/**
 * Send one push. `message` is an object (sent as JSON). Returns { ok, status, gone }:
 * gone = true means the device unsubscribed (404/410) and the subscription should be deleted.
 *   ttl      seconds the push service may hold the message if the phone is offline
 *   urgency  'high' lets it wake the phone promptly
 *   topic    a newer push with the same topic replaces an undelivered older one
 */
export async function sendPush(sub, message, vapid, { ttl = 600, urgency = 'high', topic } = {}) {
  const body = await encryptPayload(JSON.stringify(message), { p256dh: sub.p256dh, auth: sub.auth });
  const headers = {
    Authorization: await vapidHeader(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, detail: res.ok ? '' : await res.text().catch(() => '') };
}
