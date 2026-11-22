// freetime.js: find open time in your working hours (used by the assistant's find_free_time tool).
//
// Doing this arithmetic here, instead of making the AI read every event and work it out,
// is cheaper (fewer tokens, fewer round trips) and never gets the math wrong.
//
// Pure functions, no Electron: test/unit/freetime.test.js runs them with plain `node --test`.
//
// The profile (Settings → Assistant → About you) decides what counts as "available":
//   workDays        [0-6], 0 = Sunday
//   dayStart/dayEnd 'HH:MM' working hours
//   lunchStart/End  'HH:MM' kept free ('' = no lunch break)
//   meetingBuffer   minutes kept clear before and after each event
// All-day events (birthdays, holidays) don't block time.

const PROFILE_DEFAULTS = {
  workDays: [1, 2, 3, 4, 5],
  dayStart: '09:00',
  dayEnd: '17:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  focusTime: 'morning',   // morning | afternoon | evening | none
  blockMinutes: 60,       // usual length of a work block
  maxBlockMinutes: 120,   // never longer than this in one go
  breakMinutes: 15,       // gap between back-to-back blocks
  meetingBuffer: 10,      // free minutes around meetings
  blockColorId: '',       // Google event color for time blocks ('' = calendar color)
  notes: '',              // free text: anything else about how you work
};

const MINUTE = 60000;
const STEP = 5; // slot edges are rounded to 5 minutes

/** Fill in defaults and drop anything malformed. */
function normalizeProfile(p) {
  const out = { ...PROFILE_DEFAULTS, ...(p || {}) };
  const time = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  const num = (v, d, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
  out.workDays = Array.isArray(out.workDays) ? [...new Set(out.workDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : PROFILE_DEFAULTS.workDays;
  out.dayStart = time(out.dayStart, PROFILE_DEFAULTS.dayStart);
  out.dayEnd = time(out.dayEnd, PROFILE_DEFAULTS.dayEnd);
  out.lunchStart = out.lunchStart === '' ? '' : time(out.lunchStart, PROFILE_DEFAULTS.lunchStart);
  out.lunchEnd = out.lunchEnd === '' ? '' : time(out.lunchEnd, PROFILE_DEFAULTS.lunchEnd);
  out.focusTime = ['morning', 'afternoon', 'evening', 'none'].includes(out.focusTime) ? out.focusTime : 'none';
  out.blockMinutes = num(out.blockMinutes, 60, 15, 480);
  out.maxBlockMinutes = Math.max(out.blockMinutes, num(out.maxBlockMinutes, 120, 15, 480));
  out.breakMinutes = num(out.breakMinutes, 15, 0, 120);
  out.meetingBuffer = num(out.meetingBuffer, 10, 0, 120);
  out.blockColorId = /^(|[1-9]|1[01])$/.test(String(out.blockColorId)) ? String(out.blockColorId) : '';
  out.notes = String(out.notes || '').slice(0, 1500);
  return out;
}

/** A Date at local HH:MM on the same calendar day as `day` (DST-safe: built from parts). */
function at(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ceilStep = (t) => Math.ceil(t / (STEP * MINUTE)) * STEP * MINUTE;
const floorStep = (t) => Math.floor(t / (STEP * MINUTE)) * STEP * MINUTE;

/** Subtract busy intervals [{s,e}] (ms) from [start,end); returns free [{s,e}]. */
function subtract(start, end, busy) {
  const sorted = busy.filter((b) => b.e > start && b.s < end).sort((a, b) => a.s - b.s);
  const free = [];
  let cursor = start;
  for (const b of sorted) {
    if (b.s > cursor) free.push({ s: cursor, e: Math.min(b.s, end) });
    cursor = Math.max(cursor, b.e);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push({ s: cursor, e: end });
  return free;
}

/**
 * Free time per day.
 *   from, to      Dates; every local day d with from <= d < to is checked
 *   events        [{ start: Date|string, end: Date|string, allDay }]
 *   profile       see PROFILE_DEFAULTS
 *   now           Date; time already past is never free
 *   minMinutes    shortest gap worth returning (default 30)
 *   anyDay        true = also check days that aren't working days
 * Returns [{ date: 'YYYY-MM-DD', weekday: 'Mon', free_minutes, slots: [{ start: 'HH:MM', end: 'HH:MM', minutes }] }],
 * one entry per checked day (days with nothing free have slots: []).
 */
function freeSlots({ from, to, events = [], profile, now = new Date(), minMinutes = 30, anyDay = false }) {
  const p = normalizeProfile(profile);
  const busy = events
    .filter((ev) => !ev.allDay)
    .map((ev) => ({ s: +new Date(ev.start) - p.meetingBuffer * MINUTE, e: +new Date(ev.end) + p.meetingBuffer * MINUTE }));

  const days = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (!anyDay && !p.workDays.includes(d.getDay())) continue;
    const start = +at(d, p.dayStart);
    const end = +at(d, p.dayEnd);
    const blocked = [...busy, { s: -Infinity, e: +now }];
    if (p.lunchStart && p.lunchEnd && p.lunchEnd > p.lunchStart) blocked.push({ s: +at(d, p.lunchStart), e: +at(d, p.lunchEnd) });
    const slots = end > start
      ? subtract(start, end, blocked)
        .map(({ s, e }) => ({ s: ceilStep(s), e: floorStep(e) }))
        .filter(({ s, e }) => e - s >= minMinutes * MINUTE)
        .map(({ s, e }) => ({ start: hm(new Date(s)), end: hm(new Date(e)), minutes: Math.round((e - s) / MINUTE) }))
      : [];
    days.push({
      date: ymd(d),
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
      free_minutes: slots.reduce((n, sl) => n + sl.minutes, 0),
      slots,
    });
  }
  return days;
}

module.exports = { freeSlots, normalizeProfile, PROFILE_DEFAULTS };
