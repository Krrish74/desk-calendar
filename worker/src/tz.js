// tz.js: time zones.
//
// WHY THIS FILE EXISTS
// The desktop app runs on your PC, so "tomorrow", "6 PM" and "local midnight" just
// use the PC's clock. A Cloudflare Worker runs in a data center whose clock is UTC.
// So the phone tells the Worker its time zone (an IANA name like "America/New_York",
// sent in the X-Time-Zone header) and every "local" calculation goes through here.
//
// Two conversions do all the work:
//   zonedParts(instant, tz)  → the wall clock in that zone: { year, month, day, hour, … }
//   zonedToUtc(parts, tz)    → the instant at which that wall clock shows those values
// Both use the runtime's built-in time zone database (Intl), including daylight saving.

import { badRequest } from './http.js';

const partsFormatters = new Map(); // creating Intl formatters is slow, so reuse them

function formatter(tz) {
  if (!partsFormatters.has(tz)) {
    partsFormatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    }));
  }
  return partsFormatters.get(tz);
}

/** A valid IANA zone name, or 'UTC' if `tz` is missing or unknown. */
export function safeTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC';
  try { formatter(tz); return tz; } catch { return 'UTC'; }
}

/** The wall clock in `tz` at instant `date`: { year, month (1-12), day, hour, minute, second, weekday }. */
export function zonedParts(date, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type === 'weekday') out.weekday = p.value;
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** How far `tz` is ahead of UTC at `date`, in ms (New York in winter: -5 h). */
function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant when the clock in `tz` reads the given wall time.
 * Takes a guess using the offset at that moment, then corrects once in case the
 * guess landed on the other side of a daylight-saving change.
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let t = wall - offsetMs(new Date(wall), tz);
  const off2 = offsetMs(new Date(t), tz);
  if (wall - off2 !== t) t = wall - off2;
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The wall clock in `tz` at instant `date`, as a Date whose UTC fields hold it
 * (7:30 PM in Chicago → a Date for 19:30 UTC). Code written for "local time" (like
 * freetime.js, copied from the desktop app) gives the right answers on these, because a
 * Worker's own local time zone is UTC.
 */
export function toWall(date, tz) {
  const p = zonedParts(date, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

/** 'YYYY-MM-DD' of `date` as seen in `tz`. */
export function ymdIn(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local midnight of 'YYYY-MM-DD' in `tz`, as an instant. */
export function localMidnight(ymd, tz) {
  const [year, month, day] = ymd.split('-').map(Number);
  return zonedToUtc({ year, month, day }, tz);
}

/** 'YYYY-MM-DD' plus n calendar days (pure date math, no time zone involved). */
export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * Turn any time the phone or Claude sends into an instant:
 *   '2026-11-17'                → local midnight in tz
 *   '2026-11-17T18:00'          → 6 PM local in tz (Claude sends these: no offset)
 *   '2026-11-17T23:00:00.000Z'  → exactly that instant (the phone sends these)
 */
export function parseTime(value, tz) {
  if (value instanceof Date) return value;
  const s = String(value ?? '');
  if (DATE_ONLY.test(s)) return localMidnight(s, tz);
  const m = s.match(LOCAL_DATETIME);
  if (m) {
    return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] || 0) }, tz);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw badRequest(`Couldn't understand the time "${s}".`);
  return d;
}

/** Is `value` a bare date ('YYYY-MM-DD')? */
export const isDateOnly = (value) => DATE_ONLY.test(String(value ?? ''));

/** '2026-11-17T18:00 (Tue)' or, for all-day, '2026-11-17 (Tue)', in tz. What Claude reads. */
export function localStamp(date, tz, dateOnly = false) {
  const p = zonedParts(date, tz);
  const ymd = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return dateOnly ? `${ymd} (${p.weekday})` : `${ymd}T${pad(p.hour)}:${pad(p.minute)} (${p.weekday})`;
}
