// make-vapid-keys.mjs: creates the VAPID key pair push notifications need.
//
//   node scripts/make-vapid-keys.mjs        (or: npm run vapid)
//
// WHAT VAPID IS
// When the Worker sends a reminder, it goes through Apple's push service. Apple needs
// to know the message really comes from the server your phone subscribed to. VAPID
// ("Voluntary Application Server Identification") does that with a key pair:
//   • the PUBLIC key is given to the phone when it subscribes (it's not secret)
//   • the PRIVATE key stays on the Worker and signs every push
// Make the pair ONCE. If you replace it later, every phone has to turn reminders on again.
//
// This script only prints the keys; it doesn't save them anywhere. Put them in
// worker/.dev.vars for local testing, and on Cloudflare with:
//   npx wrangler secret put VAPID_PUBLIC_KEY
//   npx wrangler secret put VAPID_PRIVATE_KEY

const { subtle } = globalThis.crypto;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicRaw = await subtle.exportKey('raw', pair.publicKey);   // 65 bytes: 0x04 || x || y
const privateJwk = await subtle.exportKey('jwk', pair.privateKey); // d = the 32-byte private number

console.log(`VAPID_PUBLIC_KEY=${b64url(publicRaw)}`);
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d}`);
