// reminders.js: push notifications before events (Settings → Reminders).
// The rules are the desktop app's (src/main/notifier.js):
//   • N minutes before each timed event (Settings → "Remind me"; 0 = at start time)
//   • all-day events and meetings you declined are skipped
//   • each event start notifies once; a moved event (new start time) notifies again
//   • silent (no sound); tapping it opens Desk Calendar on that event
//
// HOW IT RUNS
// The desktop app checked a clock every 30 seconds. A Worker has no clock running, so
// Cloudflare's cron trigger (wrangler.toml) calls runReminders() every minute. For each
// account with at least one subscribed phone it fetches the events starting soon, picks
// the ones whose reminder time has come, records them in push_sent (so the next minute
// doesn't send them again) and pushes them to every subscribed device (webpush.js).

import * as calendar from './calendar.js';
import { getPrefs } from './prefs.js';
import { safeTimeZone } from './tz.js';
import { isAllowed } from './auth.js';
import { sendPush, isAllowedEndpoint } from './webpush.js';
import { badRequest, HttpError } from './http.js';

const MAX_FAILURES = 10; // a device that fails this many pushes in a row is dropped

export function pushConfig(env) {
  const configured = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  return { configured, publicKey: configured ? env.VAPID_PUBLIC_KEY : null };
}

function vapid(env, sub) {
  // "sub" tells the push service who runs this server; Apple requires an https: or mailto:
  // address, so we use the app's own address (where the phone subscribed).
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || sub.origin };
}

// ---------------------------------------------------------------------------------------
// Subscribing (from Settings on the phone)
// ---------------------------------------------------------------------------------------

/** Save a device's subscription (from PushManager.subscribe()). */
export async function subscribe(c, body, { origin, userAgent, allowLocal }) {
  if (!pushConfig(c.env).configured) throw new HttpError(503, 'Reminders aren\'t set up on the Worker yet (VAPID keys missing).', 'NO_VAPID');
  const { endpoint, keys } = body || {};
  if (typeof endpoint !== 'string' || endpoint.length > 2000 || !isAllowedEndpoint(endpoint, { allowLocal })) {
    throw badRequest('That push subscription isn\'t from a known push service.');
  }
  if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw badRequest('The push subscription is missing its keys.');
  }
  await c.env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, email, p256dh, auth, origin, user_agent, created_at, failures)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
      ON CONFLICT(endpoint) DO UPDATE SET email = ?2, p256dh = ?3, auth = ?4, origin = ?5, user_agent = ?6, failures = 0`)
    .bind(endpoint, c.email, keys.p256dh, keys.auth, origin, (userAgent || '').slice(0, 200), Date.now()).run();
  return { subscribed: true, devices: await deviceCount(c) };
}

export async function unsubscribe(c, endpoint) {
  if (typeof endpoint !== 'string') throw badRequest('Send { endpoint }.');
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND email = ?').bind(endpoint, c.email).run();
  return { subscribed: false, devices: await deviceCount(c) };
}

export async function deviceCount(c) {
  const row = await c.env.DB.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE email = ?').bind(c.email).first();
  return row?.n || 0;
}

/** Settings → "Send a test reminder": pushes to every device of this account. */
export async function sendTest(c) {
  if (!pushConfig(c.env).configured) throw new HttpError(503, 'Reminders aren\'t set up on the Worker yet (VAPID keys missing).', 'NO_VAPID');
  const lead = c.prefs.notifyMinutes;
  const start = new Date(Date.now() + lead * 60000);
  const message = {
    title: 'Test reminder',
    body: `${lead ? `In ${lead} min` : 'Starting now'} · ${fmtRange(start, new Date(+start + 3600e3), c)}\nThis is what reminders will look like.`,
    tag: 'test',
    url: '/',
  };
  const results = await pushToAll(c.env, c.email, message, { topic: 'test' });
  if (!results.length) throw badRequest('No device has reminders turned on yet.');
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// ---------------------------------------------------------------------------------------
// The cron job
// ---------------------------------------------------------------------------------------

export async function runReminders(env, now = Date.now()) {
  if (!pushConfig(env).configured) return { accounts: 0, sent: 0 };
  const { results: accounts } = await env.DB.prepare('SELECT DISTINCT email FROM push_subscriptions').all();
  let sent = 0;
  for (const { email } of accounts) {
    try {
      sent += await remindAccount(env, email, now);
    } catch (err) {
      // Signed out / Google hiccup: try again next minute.
      console.warn('[reminders]', err.code === 'NOT_SIGNED_IN' ? 'account signed out' : err.message);
    }
  }
  // Forget "already sent" records after two days.
  await env.DB.prepare('DELETE FROM push_sent WHERE sent_at < ?').bind(now - 2 * 864e5).run();
  return { accounts: accounts.length, sent };
}

async function remindAccount(env, email, now) {
  if (!isAllowed(env, email)) return 0;
  const account = await env.DB.prepare('SELECT 1 FROM accounts WHERE email = ?').bind(email).first();
  if (!account) return 0;
  const prefs = await getPrefs(env.DB, email);
  if (!prefs.notifyEnabled) return 0;
  const c = { env, email, tz: safeTimeZone(prefs.timeZone), prefs, waitUntil: () => {} };

  const leadMs = prefs.notifyMinutes * 60000;
  const events = (await calendar.listEvents(c, new Date(now - 60000), new Date(now + leadMs + 30 * 60000)))
    .filter((e) => !e.allDay);
  const { results: pending } = await env.DB.prepare("SELECT calendar_id, event_id FROM pending_deletes WHERE email = ? AND kind = 'event'").bind(email).all();
  const hidden = new Set(pending.map((p) => `${p.calendar_id}|${p.event_id}`));

  let sent = 0;
  for (const ev of events) {
    if (hidden.has(`${ev.calendarId}|${ev.id}`)) continue;
    const start = new Date(ev.start).getTime();
    // Due: inside the lead window. For "at start time" allow two minutes after the start,
    // since the cron may fire a little late. (The desktop app used one minute and checked
    // every 30 seconds.)
    if (now < start - leadMs || now >= Math.max(start, start - leadMs + 2 * 60000)) continue;

    // Claim it first, so two overlapping cron runs can't both send it.
    const key = `${ev.calendarId}|${ev.id}|${ev.start}`;
    const claimed = await env.DB.prepare('INSERT INTO push_sent (email, key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING key')
      .bind(email, key, now).first();
    if (!claimed) continue;

    const mins = Math.max(0, Math.round((start - now) / 60000));
    const message = {
      title: ev.title,
      body: [`${mins === 0 ? 'Starting now' : `In ${mins} min`} · ${fmtRange(new Date(ev.start), new Date(ev.end), c)}`, ev.location].filter(Boolean).join('\n'),
      tag: key,
      // Tapping the notification opens the app on this event.
      url: `/?open=${encodeURIComponent(`${ev.calendarId}|${ev.id}|${ev.start}`)}`,
      meetLink: ev.meetLink || undefined,
    };
    // Keep the push alive until the event starts (the phone may be offline for a bit).
    const ttl = Math.max(60, Math.round((start - now) / 1000) + 300);
    await pushToAll(env, email, message, { ttl, topic: ev.id });
    sent++;
  }
  return sent;
}

/** Send to every device of `email`; drop devices that unsubscribed or keep failing. */
async function pushToAll(env, email, message, options) {
  const { results: subs } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE email = ?').bind(email).all();
  const out = [];
  for (const sub of subs) {
    let r;
    try {
      r = await sendPush(sub, message, vapid(env, sub), options);
    } catch (err) {
      r = { ok: false, status: 0, gone: false, detail: err.message };
    }
    if (r.ok) {
      await env.DB.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?').bind(Date.now(), sub.endpoint).run();
    } else if (r.gone || sub.failures + 1 >= MAX_FAILURES) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
    } else {
      console.warn('[push] failed', r.status, r.detail?.slice(0, 200));
      await env.DB.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').bind(sub.endpoint).run();
    }
    out.push(r);
  }
  return out;
}

/** "3:00 – 3:45 PM" in the phone's time zone and Settings → Time format. */
function fmtRange(start, end, c) {
  const opts = { timeZone: c.tz, hour: 'numeric', minute: '2-digit' };
  if (c.prefs.timeFormat === '12') opts.hour12 = true;
  if (c.prefs.timeFormat === '24') opts.hour12 = false;
  const f = new Intl.DateTimeFormat('en-US', opts);
  return `${f.format(start)} – ${f.format(end)}`;
}
