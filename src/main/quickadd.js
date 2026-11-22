// quickadd.js: turn "gym tomorrow 6pm" into { title: 'Gym', start, end, allDay }.
//
// Runs locally with the `chrono-node` library (no network, no AI), so the preview
// under the input box updates instantly as you type.
//
// Examples it understands:
//   "gym tomorrow 6pm"                → Gym, tomorrow 18:00–19:00
//   "lunch with Sam friday 12:30-2pm" → Lunch with Sam, Fri 12:30–14:00
//   "dentist dec 3 at 9"              → Dentist, Dec 3 09:00–10:00
//   "mom's birthday saturday"         → all-day event (no time given)
//   "call bank in 2 hours"            → 2 hours from now
//   "standup tomorrow 9am for 15 min" → 15-minute event

const chrono = require('chrono-node');

const DEFAULT_MINUTES = 60; // fallback; main.js passes the "Default event length" setting

function parse(text, now = new Date(), defaultMinutes = DEFAULT_MINUTES) {
  text = text.trim();
  if (!text) return null;

  // "#work" picks a calendar. Pull the tag out so it isn't part of the title or the date.
  // (main.js matches it against your calendar names.)
  let calendarTag = null;
  text = text.replace(/(^|\s)#([\p{L}\p{N}_-]+)/u, (_m, lead, tag) => { calendarTag = tag; return lead; }).trim();

  // forwardDate: "friday" means the NEXT friday, never one in the past.
  const results = chrono.parse(text, now, { forwardDate: true });
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
  const start = r.start.date();

  if (!hasTime) {
    // No time → all-day event. For "sat to mon" the end is the last day (inclusive).
    return { title, calendarTag, allDay: true, start: ymd(start), end: ymd(r.end?.date() || start) };
  }

  let end = r.end?.date();
  if (!end || end <= start) end = new Date(start.getTime() + (durationMin ?? defaultMinutes) * 60000);
  return { title, calendarTag, allDay: false, start: start.toISOString(), end: end.toISOString() };
}

// Local calendar date as 'YYYY-MM-DD' (what all-day events use).
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

module.exports = { parse };
