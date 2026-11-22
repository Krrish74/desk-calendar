// setup-secrets.mjs: puts the Worker's secrets on Cloudflare.
//
//   npm run secrets             (in your own terminal: it asks you to type some values)
//
// Two kinds of secrets:
//   MADE FOR YOU (random; you never need to see them):
//     TOKEN_KEY          encrypts the Google tokens stored in D1
//     VAPID_PUBLIC_KEY   } the key pair that signs reminder pushes
//     VAPID_PRIVATE_KEY  }
//   Generated here and handed straight to `wrangler secret put`; never printed, never
//   saved to a file. If they already exist they're KEPT: replacing TOKEN_KEY would sign
//   you out, replacing the VAPID pair would turn reminders off on every phone.
//   (Use --rotate to replace them anyway.)
//
//   YOU TYPE (wrangler asks for each, hiding what you type):
//     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   the Web OAuth client (SETUP-IPHONE.md step 6)
//     ANTHROPIC_API_KEY                        your Claude API key
//     ALLOWED_EMAILS                           your Gmail address (comma-separate several)
//   Already-set ones are skipped; use --all to re-enter them.

import { execFileSync, spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerJs = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const rotate = process.argv.includes('--rotate');
const reenter = process.argv.includes('--all');

let existing = new Set();
try {
  const list = JSON.parse(execFileSync(process.execPath, [wranglerJs, 'secret', 'list', '--format', 'json'], { cwd: workerDir, encoding: 'utf8' }));
  existing = new Set(list.map((s) => s.name));
} catch {
  console.log('(Couldn\'t list existing secrets; is the Worker deployed? Run `npm run deploy` first.)');
}

/** `wrangler secret put NAME`, with the value piped in (generated) or typed by you (inherit). */
function put(name, value) {
  const r = spawnSync(process.execPath, [wranglerJs, 'secret', 'put', name], {
    cwd: workerDir,
    input: value === undefined ? undefined : `${value}\n`,
    stdio: value === undefined ? 'inherit' : ['pipe', 'ignore', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`Setting ${name} failed.`);
  console.log(`✓ ${name}`);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// --- Generated -----------------------------------------------------------------------------
if (rotate || !existing.has('TOKEN_KEY')) {
  put('TOKEN_KEY', b64url(webcrypto.getRandomValues(new Uint8Array(32))));
} else console.log('• TOKEN_KEY already set (kept)');

if (rotate || !existing.has('VAPID_PUBLIC_KEY') || !existing.has('VAPID_PRIVATE_KEY')) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  put('VAPID_PUBLIC_KEY', b64url(await webcrypto.subtle.exportKey('raw', pair.publicKey)));
  put('VAPID_PRIVATE_KEY', (await webcrypto.subtle.exportKey('jwk', pair.privateKey)).d);
} else console.log('• VAPID keys already set (kept)');

// --- Typed by you ------------------------------------------------------------------------
const ASK = [
  ['GOOGLE_CLIENT_ID', 'the Client ID of the "Desk Calendar (iPhone)" Web client (ends in .apps.googleusercontent.com)'],
  ['GOOGLE_CLIENT_SECRET', 'that client\'s Client secret (starts with GOCSPX-)'],
  ['ANTHROPIC_API_KEY', 'your Claude API key (starts with sk-ant-)'],
  ['ALLOWED_EMAILS', 'the Gmail address allowed to sign in (several: comma-separated)'],
];
for (const [name, what] of ASK) {
  if (!reenter && existing.has(name)) { console.log(`• ${name} already set (kept; --all to change)`); continue; }
  console.log(`\n${name}: paste ${what}, then press Enter.`);
  put(name);
}
console.log('\nDone. Secrets take effect right away; no redeploy needed.');
