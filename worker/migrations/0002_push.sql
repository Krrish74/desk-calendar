-- 0002_push.sql: push notification (reminder) tables.

-- One row per phone/browser that turned reminders on. The endpoint is the URL at
-- Apple's (or another browser's) push service that delivers to that device; p256dh and
-- auth are the device's keys, used to encrypt each message so only it can read it.
CREATE TABLE push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  origin       TEXT NOT NULL,          -- this app's address when it subscribed (VAPID "sub")
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  last_ok_at   INTEGER,
  failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_email ON push_subscriptions(email);

-- Reminders already sent, so each event start notifies once (a moved event has a new
-- start, so it notifies again). Rows older than two days are cleaned up by the cron.
CREATE TABLE push_sent (
  email    TEXT NOT NULL,
  key      TEXT NOT NULL,              -- calendarId|eventId|startISO
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (email, key)
);
