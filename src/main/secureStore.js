// secureStore.js: encrypted key/value storage for secrets (Google token, Claude API key).
//
// HOW IT'S SECURE
// Electron's `safeStorage` calls Windows DPAPI (Data Protection API). DPAPI encrypts
// data with a key tied to YOUR Windows user account, so the files we write are
// unreadable gibberish to other users on the PC, to anyone who copies the file to
// another machine, and to anyone browsing the folder. No password needed, and
// nothing is ever written in plain text.
//
// WHERE IT'S STORED
// app.getPath('userData') = %APPDATA%\desk-calendar\ (or %APPDATA%\Desk Calendar\ once
// packaged). That's outside your project folder, so secrets can't end up in git.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function fileFor(name) {
  return path.join(app.getPath('userData'), `${name}.bin`);
}

// All functions here are async (they return Promises), because Electron's
// encryption API is async: callers must `await store.save(...)` / `await store.load(...)`.

/** Encrypt `value` (any JSON-serializable thing) and save it under `name`. */
async function save(name, value) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    // On Windows this is always available; refusing is safer than writing plain text.
    throw new Error('OS encryption is unavailable, so the secret was not saved.');
  }
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(value));
  await fs.promises.mkdir(app.getPath('userData'), { recursive: true });
  await fs.promises.writeFile(fileFor(name), encrypted);
}

/** Load and decrypt `name`. Returns null if missing or unreadable. */
async function load(name) {
  let encrypted;
  try {
    encrypted = await fs.promises.readFile(fileFor(name));
  } catch {
    return null; // not saved yet
  }
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
    const value = JSON.parse(result);
    // Electron may say the encryption key was rotated/upgraded: re-save with the new one.
    if (shouldReEncrypt) await save(name, value);
    return value;
  } catch {
    return null; // encrypted by a different Windows user, or corrupted
  }
}

async function remove(name) {
  await fs.promises.rm(fileFor(name), { force: true });
}

module.exports = { save, load, remove };
