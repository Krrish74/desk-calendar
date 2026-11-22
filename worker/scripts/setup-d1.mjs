// setup-d1.mjs: creates the Cloudflare D1 database (if needed), writes its id into
// wrangler.toml, and creates/updates the tables on Cloudflare.
//
//   npm run setup:db        (after `npx wrangler login`)
//
// Safe to run again: an existing database is reused, and migrations that already ran
// are skipped.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerJs = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const NAME = 'desk-calendar';
const wrangler = (args, opts = {}) =>
  execFileSync(process.execPath, [wranglerJs, ...args], { cwd: workerDir, encoding: 'utf8', ...opts });

const findDb = () => JSON.parse(wrangler(['d1', 'list', '--json'])).find((d) => d.name === NAME);

let db = findDb();
if (db) {
  console.log(`Using the existing D1 database "${NAME}".`);
} else {
  console.log(`Creating the D1 database "${NAME}"…`);
  wrangler(['d1', 'create', NAME], { stdio: 'inherit' });
  db = findDb();
  if (!db) throw new Error('The database was not found after creating it. Check `npx wrangler d1 list`.');
}

const tomlPath = join(workerDir, 'wrangler.toml');
const toml = readFileSync(tomlPath, 'utf8');
const updated = toml.replace(/(database_name = "desk-calendar"\s*\r?\ndatabase_id = ")[^"]*(")/, `$1${db.uuid}$2`);
if (updated === toml && !toml.includes(db.uuid)) throw new Error('Couldn\'t find database_id in wrangler.toml to update.');
writeFileSync(tomlPath, updated);
console.log(`wrangler.toml → database_id = "${db.uuid}"`);

console.log('Creating the tables on Cloudflare…');
wrangler(['d1', 'migrations', 'apply', NAME, '--remote'], { stdio: 'inherit' }); // asks you to confirm
console.log('Database ready.');
