// quickadd.js: turn "gym tomorrow 6pm" into { title: 'Gym', start, end, allDay }.
// Ported from src/main/quickadd.js; uses the same `chrono-node` library (no AI).
//
// Examples it understands:
//   "gym tomorrow 6pm"                → Gym, tomorrow 18:00–19:00
//   "lunch with Sam friday 12:30-2pm" → Lunch with Sam, Fri 12:30–14:00
//   "dentist dec 3 at 9"              → Dentist, Dec 3 09:00–10:00
//   "mom's birthday saturday"         → all-day event (no time given)
//   "call bank in 2 hours"            → 2 hours from now
//   "standup tomorrow 9am for 15 min" → 15-minute event
//   "gym tomorrow 6pm #fitness"       → on your "Fitness" calendar
//
// TIME ZONES (the one real change from desktop)
// chrono reads dates in the computer's own time zone, and this server's is UTC.
// So we hand chrono your phone's current WALL CLOCK dressed up as a UTC time
// (23:30 in New York becomes "23:30 UTC"), let it parse in UTC, then read the
// wall-clock answer back and convert it to a real instant in your time zone
// (tz.zonedToUtc), daylight saving included. "Tomorrow" therefore means YOUR tomorrow.

import * as chrono from 'chrono-node/en'; // English only: keeps the Worker small
import { zonedParts, zonedToUtc } from './tz.js';

const DEFAULT_MINUTES = 60;

export function parse(text, { now = new Date(), tz = 'UTC', defaultMinutes = DEFAULT_MINUTES } = {}) {
  text = String(text || '').trim();
  if (!text) return null;

  // "#work" picks a calendar. Pull the tag out so it isn't part of the title or the date.
  // (index.js matches it against your calendar names.)
  let calendarTag = null;
  text = text.replace(/(^|\s)#([\p{L}\p{N}_-]+)/u, (_m, lead, tag) => { calendarTag = tag; return lead; }).trim();

  // Your wall clock right now, encoded as if it were UTC.
  const p = zonedParts(now, tz);
  const wallNow = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));

  // forwardDate: "friday" means the NEXT friday, never one in the past.
  const results = chrono.parse(text, { instant: wallNow, timezone: 0 }, { forwardDate: true });
  if (results.length === 0) return null;
  const r = results[0];

  // Optional duration: "for 30 min", "for 2 hours", "for 1.5h"
  const durMatch = text.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b/i);
  const durationMin = durMatch
    ? Math.round(parseFloat(durMatch[1]) * (/^h/i.test(durMatch[2]) ? 60 : 1))
    : null;

  // Title = the text with the date phrase and duration phrase cut out.
  let title = (text.slice(0, r.index) + ' ' + text.slice(r.index + r.text.length));
  if (durMatch) title = title.replace(durMatch[0], ' ');
  title = title
    .replace(/\s+/g, ' ')
    .replace(/\s+(at|on|from|by|@)\s*$/i, '') // dangling "gym at"
    .replace(/^(at|on)\s+/i, '')
    .trim();
  if (!title) return null;
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // chrono says whether the hour was actually written ("6pm") or just assumed.
  const hasTime = r.start.isCertain('hour');
  const toInstant = (component) => realInstant(component, r.text, tz);

  if (!hasTime) {
    // No time → all-day event. For "sat to mon" the end is the last day (inclusive).
    return { title, calendarTag, allDay: true, start: wallYmd(r.start.date()), end: wallYmd((r.end || r.start).date()) };
  }

  const start = toInstant(r.start);
  let end = r.end ? toInstant(r.end) : null;
  if (!end || end <= start) end = new Date(start.getTime() + (durationMin ?? defaultMinutes) * 60000);
  return { title, calendarTag, allDay: false, start: start.toISOString(), end: end.toISOString() };
}

/**
 * The real instant for a parsed time. Normally chrono's answer is a wall-clock time in
 * your zone (see the top of this file). But if you typed a time zone ("3pm EST"), chrono
 * already gives the real instant. Relative phrases ("in 2 hours") are marked as having
 * offset 0, which is our pretend-UTC frame, so they're wall-clock too.
 */
function realInstant(component, matchedText, tz) {
  const d = component.date();
  const explicitZone = component.isCertain('timezoneOffset')
    && (component.get('timezoneOffset') !== 0 || /\b(utc|gmt)\b/i.test(matchedText));
  if (explicitZone) return d;
  return zonedToUtc({
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  }, tz);
}

// Wall-clock date (our pretend-UTC frame) as 'YYYY-MM-DD' (what all-day events use).
const wallYmd = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
