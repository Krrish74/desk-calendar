// auth.js: Google sign-in with OAuth 2.0 for a "Desktop app" client.
//
// THE FLOW (the "loopback + PKCE" flow Google recommends for desktop apps)
//  1. We start a tiny web server on 127.0.0.1 at a random free port.
//  2. We open your real browser at Google's sign-in page, telling Google:
//     "when the user approves, send them back to http://127.0.0.1:<port>".
//  3. You approve, and Google redirects your browser to our tiny server with a one-time `code`.
//  4. We trade that `code` (plus a secret PKCE "verifier" only we know) for tokens:
//       - access_token:  short-lived (1 hour), sent with every Calendar API call
//       - refresh_token: long-lived, used to silently get new access tokens
//  5. We encrypt the tokens with secureStore (Windows DPAPI / macOS Keychain) and shut the server down.
//
// PKCE ("pixie") stops another program on your PC from stealing the `code` in step 3:
// the code is useless without the verifier, which never leaves this process.

const { app, shell } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { OAuth2Client, CodeChallengeMethod } = require('google-auth-library');
const store = require('./secureStore');

// What we ask permission for. To change permissions, edit this list AND the
// scopes in Cloud Console (Data Access), then sign out and back in.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly', // calendar list, colors, events
  'https://www.googleapis.com/auth/calendar.events',   // create / edit / delete events
  'https://www.googleapis.com/auth/tasks',             // Google Tasks: read, add, complete, delete
];
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

const TOKEN_KEY = 'google-token';
let client = null;      // the signed-in OAuth2Client, shared with calendar.js
let savedTokens = null; // in-memory copy of what's stored encrypted on disk

// ---------------------------------------------------------------------------
// credentials.json (the OAuth client file from Cloud Console)
// ---------------------------------------------------------------------------

const userCredentialsPath = () => path.join(app.getPath('userData'), 'credentials.json');

/** Find credentials.json: app-data folder first, then the project root (dev only). */
function findCredentialsFile() {
  const candidates = [userCredentialsPath()];
  if (!app.isPackaged) candidates.push(path.join(app.getAppPath(), 'credentials.json'));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function readClientInfo() {
  const file = findCredentialsFile();
  if (!file) return null;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Desktop-app client files wrap everything in an "installed" key.
  const info = json.installed || json.web;
  if (!info?.client_id) throw new Error('credentials.json is not a Google OAuth client file.');
  return { clientId: info.client_id, clientSecret: info.client_secret };
}

/** Copy a credentials.json the user picked into the app-data folder (out of any repo). */
function importCredentials(sourcePath) {
  const json = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!json.installed?.client_id) {
    throw new Error('That file is not a "Desktop app" OAuth client. Re-download it from Cloud Console → Clients.');
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.copyFileSync(sourcePath, userCredentialsPath());
}

// ---------------------------------------------------------------------------
// Building a client and keeping tokens fresh
// ---------------------------------------------------------------------------

function makeClient(redirectUri) {
  const info = readClientInfo();
  if (!info) throw new Error('No credentials.json loaded yet.');
  const c = new OAuth2Client({ ...info, redirectUri });

  // Whenever the library refreshes the access token, it emits 'tokens'.
  // Merge and re-save so the next app launch starts with a fresh token.
  // (Google usually omits refresh_token on refresh, so keep the old one.)
  c.on('tokens', (fresh) => {
    savedTokens = { ...(savedTokens || {}), ...fresh };
    store.save(TOKEN_KEY, savedTokens).catch((err) => console.error('Saving token failed:', err.message));
  });
  return c;
}

/** On startup: restore a saved session if one exists. Resolves true if signed in. */
async function restoreSession() {
  const tokens = await store.load(TOKEN_KEY);
  if (!tokens?.refresh_token || !findCredentialsFile()) return false;
  savedTokens = tokens;
  client = makeClient();
  client.setCredentials(tokens);
  return true;
}

// ---------------------------------------------------------------------------
// Interactive sign-in
// ---------------------------------------------------------------------------

function signIn() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex'); // anti-forgery value
    let oauth, verifier;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }

      const finish = (ok, message) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<body style="font-family:Segoe UI,-apple-system,sans-serif;background:#111;color:#eee;padding:40px">
          <h2>${ok ? '✅ Signed in' : '❌ Sign-in failed'}</h2><p>${message}</p></body>`);
        server.close();
      };

      if (url.searchParams.get('state') !== state) {
        finish(false, 'State mismatch. Please try again from the app.');
        return reject(new Error('OAuth state mismatch'));
      }
      if (url.searchParams.get('error')) {
        finish(false, `Google said: ${url.searchParams.get('error')}`);
        return reject(new Error(url.searchParams.get('error')));
      }
      try {
        const { tokens } = await oauth.getToken({
          code: url.searchParams.get('code'),
          codeVerifier: verifier,
        });
        oauth.setCredentials(tokens);
        // Google leaves out `scope` on some token responses; remember what we asked for then.
        savedTokens = { ...tokens, scope: tokens.scope || SCOPES.join(' ') };
        tokens.scope = savedTokens.scope;
        await store.save(TOKEN_KEY, tokens);
        client = oauth;
        finish(true, 'You can close this tab and go back to Desk Calendar.');
        resolve();
      } catch (err) {
        finish(false, err.message);
        reject(err);
      }
    });

    // Port 0 = "any free port". Google allows any port on a loopback redirect.
    server.listen(0, '127.0.0.1', async () => {
      try {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        oauth = makeClient(redirectUri);
        const pkce = await oauth.generateCodeVerifierAsync();
        verifier = pkce.codeVerifier;
        const authUrl = oauth.generateAuthUrl({
          access_type: 'offline', // ask for a refresh_token
          prompt: 'consent',      // always return a refresh_token, even on re-login
          scope: SCOPES,
          include_granted_scopes: true, // keep what was granted before (adding Tasks to an old sign-in)
          state,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: pkce.codeChallenge,
        });
        await shell.openExternal(authUrl); // your default browser, not an embedded window
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    // Give up after 5 minutes so a forgotten browser tab doesn't leave a server running.
    setTimeout(() => { server.close(); reject(new Error('Sign-in timed out.')); }, 5 * 60 * 1000).unref();
  });
}

async function signOut() {
  try { await client?.revokeCredentials(); } catch { /* already revoked/expired */ }
  await store.remove(TOKEN_KEY);
  savedTokens = null;
  client = null;
}

function getClient() {
  if (!client) throw Object.assign(new Error('Not signed in'), { code: 'NOT_SIGNED_IN' });
  return client;
}

module.exports = {
  signIn, signOut, restoreSession, getClient, importCredentials,
  hasCredentials: () => !!findCredentialsFile(),
  isSignedIn: () => !!client,
  /** True when the current sign-in includes Google Tasks (sign-ins from older versions don't). */
  hasTasksScope: () => !!client && (savedTokens?.scope || '').split(' ').includes(TASKS_SCOPE),
};
