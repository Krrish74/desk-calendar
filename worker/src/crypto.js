// crypto.js: random ids, hashing and token encryption, using the Web Crypto API
// that Workers provide (no Node `crypto` module needed).

const enc = new TextEncoder();
const dec = new TextDecoder();

/** URL-safe base64 (no + / =), used for cookie values, OAuth state and PKCE. */
export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** n cryptographically random bytes as base64url (32 bytes = 256 bits: unguessable). */
export const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** Compare two strings without leaking where they differ through timing. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Token encryption at rest
//
// Google tokens are stored in D1 encrypted with AES-256-GCM. The key is derived
// from the TOKEN_KEY secret (any long random string), so the database on its own
// is useless to someone who gets a copy of it. Stored format: "v1.<iv>.<ciphertext>".
// ---------------------------------------------------------------------------

const keyCache = new Map();

async function aesKey(secret) {
  if (!secret || secret.length < 16) {
    throw new Error('TOKEN_KEY secret is missing or too short (use 32+ random characters).');
  }
  if (!keyCache.has(secret)) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
    keyCache.set(secret, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(secret);
}

export async function encrypt(secret, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(data)}`;
}

export async function decrypt(secret, stored) {
  const [v, iv, data] = String(stored).split('.');
  if (v !== 'v1') throw new Error('Unknown token format.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(iv) }, await aesKey(secret), b64urlDecode(data));
  return dec.decode(plain);
}
