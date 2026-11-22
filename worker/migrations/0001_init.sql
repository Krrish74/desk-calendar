-- 0001_init.sql: the Worker's database tables (Cloudflare D1 = SQLite).
--
-- Apply locally:      npm run db:local
-- Apply to Cloudflare: npm run db:remote
-- Times are Unix milliseconds (Date.now()).

-- The Google account you signed in with. Tokens are AES-GCM encrypted with the
-- TOKEN_KEY secret, so a copy of the database alone can't reach your calendar.
CREATE TABLE accounts (
  email           TEXT PRIMARY KEY,
  refresh_token   TEXT NOT NULL,      -- encrypted; long-lived, used to get access tokens
  access_token    TEXT,               -- encrypted; 1-hour token sent to the Calendar API
  access_expires  INTEGER,            -- when access_token stops working
  scope           TEXT,               -- permissions Google granted
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- One row per signed-in device. The cookie holds a random id; only its SHA-256 hash
-- is stored, so the table can't be used to forge a cookie.
CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX sessions_email ON sessions(email);

-- Settings (calendar visibility, default length, reminder minutes, model…) as JSON.
CREATE TABLE prefs (
  email  TEXT PRIMARY KEY,
  json   TEXT NOT NULL
);

-- The assistant conversation (Claude's message history) as JSON.
CREATE TABLE chats (
  email       TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  messages    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Deletes waiting out their "Undo" window. due_at NULL = queued by the assistant,
-- countdown starts when its reply is sent.
CREATE TABLE pending_deletes (
  token        TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  calendar_id  TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  due_at       INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX pending_deletes_due ON pending_deletes(due_at);
CREATE INDEX pending_deletes_email ON pending_deletes(email);
