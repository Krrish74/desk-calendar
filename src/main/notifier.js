// notifier.js: desktop notifications before events (Settings → Notifications).
//
// Runs in the backend, so it keeps working while the window is hidden in the tray.
//   • Every 2 minutes (and right after you create/move/delete something) it fetches
//     the events starting soon from your visible calendars.
//   • Every 30 seconds it checks whether any event has reached "N minutes before".
//   • Each event start notifies once. A moved event (new start time) notifies again.
//   • All-day events and meetings you declined are skipped.
//   • The notification is silent. "Join" opens the meeting link; clicking the
//     notification opens Desk Calendar on that event.

const { Notification, shell } = require('electron');
const path = require('path');
const prefs = require('./prefs');
const auth = require('./auth');
const calendar = require('./calendar');
const windowManager = require('./windowManager');

const CHECK_MS = 30 * 1000;          // how often to check the clock
const FETCH_MS = 2 * 60 * 1000;      // how often to re-fetch upcoming events
const ICON = path.join(__dirname, '..', 'assets', 'icon-256.png');

let upcoming = [];                   // cached events starting soon
let lastFetch = 0;
const notified = new Set();          // "calendarId|eventId|startISO" already shown
const live = new Set();              // keep shown notifications referenced (else clicks can be lost)
let isHidden = () => false;          // (calendarId, eventId) → true while a delete's Undo window runs

async function fetchUpcoming() {
  const now = Date.now();
  const lead = prefs.get('notifyMinutes');
  const until = new Date(now + (lead + 30) * 60 * 1000); // a little beyond the lead time
  upcoming = (await calendar.listEvents(new Date(now - 60 * 1000), until)).filter((e) => !e.allDay);
  lastFetch = now;
}

async function check() {
  if (!prefs.get('notifyEnabled') || !auth.isSignedIn()) return;
  try {
    if (Date.now() - lastFetch > FETCH_MS) await fetchUpcoming();
  } catch (err) {
    console.warn('[notifier] fetch failed:', err.message);
    return;
  }
  const now = Date.now();
  const leadMs = prefs.get('notifyMinutes') * 60 * 1000;
  for (const ev of upcoming) {
    if (isHidden(ev.calendarId, ev.id)) continue; // being deleted
    const start = new Date(ev.start).getTime();
    const key = `${ev.calendarId}|${ev.id}|${ev.start}`;
    // Due: we're inside the lead window (or within a minute after start, for "at start time").
    if (now >= start - leadMs && now < Math.max(start, start - leadMs + 60 * 1000) && !notified.has(key)) {
      notified.add(key);
      show(ev, start - now);
    }
  }
}

function show(ev, msUntil) {
  if (!Notification.isSupported()) return;
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  const tf = prefs.get('timeFormat');
  if (tf !== 'system') timeOpts.hour12 = tf === '12';
  const fmt = (iso) => new Date(iso).toLocaleTimeString([], timeOpts);
  const mins = Math.max(0, Math.round(msUntil / 60000));
  const when = mins === 0 ? 'Starting now' : `In ${mins} min`;

  const n = new Notification({
    title: ev.title,
    body: [`${when} · ${fmt(ev.start)} – ${fmt(ev.end)}`, ev.location].filter(Boolean).join('\n'),
    icon: ICON,
    silent: true,
    actions: ev.meetLink ? [{ type: 'button', text: 'Join' }] : [],
  });
  n.on('action', () => { if (/^https:\/\//i.test(ev.meetLink || '')) shell.openExternal(ev.meetLink); });
  n.on('click', () => windowManager.command('show-event', { id: ev.id, calendarId: ev.calendarId, start: ev.start }));
  n.on('close', () => live.delete(n));
  live.add(n);
  n.show();
}

/** Something changed (event created/moved/deleted, or settings): re-fetch on the next check. */
function invalidate() {
  lastFetch = 0;
  setTimeout(check, 1000);
}

function start() {
  setInterval(check, CHECK_MS);
  setTimeout(check, 5000); // shortly after launch
  // Once a day, forget keys of events that have started (so the set doesn't grow forever).
  // Keys of events still ahead are kept, so they can't notify a second time.
  setInterval(() => {
    const now = Date.now();
    for (const key of notified) if (new Date(key.split('|').pop()).getTime() < now) notified.delete(key);
  }, 24 * 60 * 60 * 1000);
}

/** main.js tells us which events are waiting to be deleted (they shouldn't remind you). */
function setHiddenCheck(fn) { isHidden = fn; }

module.exports = { start, invalidate, show, setHiddenCheck };
