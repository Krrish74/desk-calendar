// calendar.js: everything that talks to Google Calendar (ported from src/main/calendar.js).
//
// The phone UI and the assistant both go through these functions, so there's exactly
// one place where events are fetched, created, edited or deleted.
//
// What changed from the desktop version:
//   • REST calls through google.js instead of the @googleapis/calendar library.
//   • "Local time" means the PHONE's time zone (c.tz), not the server's (which is UTC).
//   • Settings come from D1 (c.prefs) instead of a JSON file.
// Everything the UI sees (the normalized event shape) is the same as on desktop.
//
// `c` is the request context built in index.js: { env, email, tz, prefs, waitUntil }.

import { google, enc } from './google.js';
import { ymdIn, localMidnight, addDaysYmd, parseTime, isDateOnly } from './tz.js';
import { setPrefs } from './prefs.js';
import { badRequest } from './http.js';

// Event colors as Google Calendar's web UI shows them today. (The API's /colors
// endpoint returns an older, paler palette for the same IDs, so we map directly.)
// Key = event.colorId ("1".."11").
export const EVENT_COLORS = {
  1: '#7986cb', // Lavender
  2: '#33b679', // Sage
  3: '#8e24aa', // Grape
  4: '#e67c73', // Flamingo
  5: '#f6bf26', // Banana
  6: '#f4511e', // Tangerine
  7: '#039be5', // Peacock
  8: '#616161', // Graphite
  9: '#3f51b5', // Blueberry
  10: '#0b8043', // Basil
  11: '#d50000', // Tomato
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every calendar in your Google account's list, each with:
 *   color    the color you picked for it in Google Calendar
 *   canEdit  'owner'/'writer' access (holidays and others' calendars are view-only)
 *   visible  whether Desk Calendar shows it: your choice in the app, or, if you never
 *            changed it here, whether it's ticked in Google Calendar.
 * The list is cached for a minute per Worker instance (quick add looks it up a lot).
 */
const calendarCache = new Map(); // email → { at, list }

export async function listCalendars(c, { fresh = false } = {}) {
  const cached = calendarCache.get(c.email);
  if (!fresh && cached && Date.now() - cached.at < 60 * 1000) return withVisibility(c, cached.list);

  const data = await google(c, '/users/me/calendarList', { query: { minAccessRole: 'freeBusyReader', maxResults: 250 } });
  const list = (data.items || []).map((cal) => ({
    id: cal.id,
    name: cal.summaryOverride || cal.summary,
    color: cal.backgroundColor,
    primary: !!cal.primary,
    canEdit: cal.accessRole === 'owner' || cal.accessRole === 'writer',
    googleSelected: !!cal.selected,
    // e.g. [{ method: 'popup', minutes: 10 }]: used when an event says "use default reminders"
    defaultReminders: cal.defaultReminders || [],
  }));
  // Primary first, then the rest alphabetically (like Google's sidebar).
  list.sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
  calendarCache.set(c.email, { at: Date.now(), list });
  return withVisibility(c, list);
}

function withVisibility(c, list) {
  const overrides = c.prefs.calendarVisibility || {};
  return list.map((cal) => ({ ...cal, visible: overrides[cal.id] ?? cal.googleSelected }));
}

/** Show or hide one calendar in Desk Calendar (doesn't change Google Calendar itself). */
export async function setCalendarVisible(c, id, visible) {
  c.prefs = await setPrefs(c.env.DB, c.email, { calendarVisibility: { [id]: visible } }); // merged in the database
  return true;
}

/**
 * Events between `start` and `end` (Date objects) across all visible calendars,
 * merged and sorted by start time.
 *
 * singleEvents: true expands recurring events ("every Monday") into individual
 * occurrences, so each one has its own id. Editing that id changes just that
 * occurrence, exactly like choosing "This event" in Google Calendar.
 */
export async function listEvents(c, start, end) {
  const calendars = (await listCalendars(c)).filter((cal) => cal.visible);

  // Fetch every calendar in parallel. One failing calendar shouldn't blank the
  // whole list, so failures are logged and skipped.
  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      try {
        const data = await google(c, `/calendars/${enc(cal.id)}/events`, {
          query: {
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250,
          },
        });
        return (data.items || [])
          .filter((e) => e.status !== 'cancelled')
          .filter((e) => !declinedByMe(e))
          .map((e) => normalize(c, e, cal));
      } catch (err) {
        if (err.code === 'NOT_SIGNED_IN') throw err; // that one isn't per-calendar
        console.warn(`Skipping a calendar: ${err.message}`);
        return [];
      }
    }),
  );

  return perCalendar.flat().sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Hide meetings you've declined, like Google Calendar does by default.
export function declinedByMe(e) {
  return (e.attendees || []).some((a) => a.self && a.responseStatus === 'declined');
}

/**
 * Turn Google's event shape into a small, flat object the UI can use directly.
 * All-day events become local-midnight instants in the phone's time zone, exactly
 * what the desktop app sends its UI, so `new Date(ev.start)` on the phone is right.
 */
function normalize(c, e, cal) {
  const allDay = !!e.start.date;
  return {
    id: e.id,
    calendarId: cal.id,
    calendarName: cal.name,
    canEdit: cal.canEdit,
    title: e.summary || '(No title)',
    location: e.location || '',
    description: e.description || '',
    allDay,
    start: allDay ? localMidnight(e.start.date, c.tz).toISOString() : e.start.dateTime,
    end: allDay ? localMidnight(e.end.date, c.tz).toISOString() : e.end.dateTime,
    color: EVENT_COLORS[e.colorId] || cal.color,
    meetLink: meetingLink(e),
    // true only for a real Google Meet attached to the event (not a pasted Zoom link)
    hasGoogleMeet: !!(e.hangoutLink || e.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet'),
    colorId: e.colorId || '',                       // '' = uses the calendar's color
    taskLink: e.extendedProperties?.private?.deskTask || '', // 'listId|taskId' for a task's time block
    reminders: e.reminders || { useDefault: true }, // { useDefault, overrides: [{ method, minutes }] }
    htmlLink: e.htmlLink,
  };
}

/**
 * The video-call link for an event, if it has one: Google Meet (hangoutLink or
 * conferenceData), or a Zoom / Teams / Webex / Meet URL pasted into the
 * location or description.
 */
const MEETING_URL =
  /https:\/\/[\w.-]*(zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com)\/[^\s"'<>)]+/i;

export function meetingLink(e) {
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  if (video?.uri) return video.uri;
  const text = `${e.location || ''} ${e.description || ''}`;
  const m = text.match(MEETING_URL);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Convert our simple { start, end, allDay } into Google's request body.
 *
 * Timed events: start/end are date-times. No end → default length (Settings).
 * All-day events: start is the first day, end is the LAST day (inclusive);
 *   no end → a single day. Google wants an EXCLUSIVE end date, so a one-day
 *   event on Nov 16 is sent as { start: 2026-11-16, end: 2026-11-17 }.
 * Times may be full ISO instants (from the phone) or local '2026-11-17T18:00'
 * (from Claude); tz.parseTime handles both.
 */
function toGoogleTimes(c, { start, end, allDay }) {
  if (allDay) {
    const first = isDateOnly(start) ? start : ymdIn(parseTime(start, c.tz), c.tz);
    let last = end ? (isDateOnly(end) ? end : ymdIn(parseTime(end, c.tz), c.tz)) : first;
    if (last < first) last = first; // 'YYYY-MM-DD' strings compare correctly as text
    return { start: { date: first }, end: { date: addDaysYmd(last, 1) } };
  }
  const s = parseTime(start, c.tz);
  const e = end ? parseTime(end, c.tz) : new Date(s.getTime() + c.prefs.defaultEventMinutes * 60 * 1000);
  if (e <= s) throw badRequest('The event must end after it starts.');
  return {
    start: { dateTime: s.toISOString(), timeZone: c.tz },
    end: { dateTime: e.toISOString(), timeZone: c.tz },
  };
}

/**
 * The optional extras the editor can set, turned into Google's format:
 *   colorId    '1'..'11' for one of Google's event colors, '' to go back to the calendar's color
 *   reminders  'default' (the calendar's own reminders) or a list of minutes, e.g. [10, 60, 1440]
 *   meet       'add' to create a Google Meet link, 'remove' to take it off
 * Returns extra query parameters (Meet changes need conferenceDataVersion=1).
 */
function applyExtras(body, { colorId, reminders, meet, taskLink }) {
  if (colorId !== undefined) body.colorId = colorId || null; // null clears it
  // 'listId|taskId': marks the event as a time block for that Google Task (stored privately
  // on the event; only Desk Calendar reads it). Same property the desktop app uses.
  if (taskLink) body.extendedProperties = { private: { deskTask: taskLink } };
  if (reminders !== undefined) {
    body.reminders = reminders === 'default'
      ? { useDefault: true }
      : { useDefault: false, overrides: reminders.slice(0, 5).map((minutes) => ({ method: 'popup', minutes })) };
  }
  if (meet === 'add') {
    body.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  } else if (meet === 'remove') {
    body.conferenceData = null;
  }
  return meet ? { conferenceDataVersion: 1 } : {};
}

/** Create an event. `calendarId` defaults to your primary calendar. */
export async function createEvent(c, { calendarId = 'primary', title, start, end, allDay, location, description, ...extras }) {
  const body = { summary: title, location, description, ...toGoogleTimes(c, { start, end, allDay }) };
  const query = applyExtras(body, extras);
  const data = await google(c, `/calendars/${enc(calendarId)}/events`, { method: 'POST', query, body });
  return summarize(c, data);
}

/**
 * Edit an event. Only the fields you pass are changed (that's what PATCH means).
 * If you pass start you should pass end too, so the duration stays what you expect.
 */
export async function updateEvent(c, { calendarId, eventId, title, start, end, allDay, location, description, ...extras }) {
  const body = {};
  if (title !== undefined) body.summary = title;
  if (location !== undefined) body.location = location;
  if (description !== undefined) body.description = description;
  if (start !== undefined) Object.assign(body, toGoogleTimes(c, { start, end, allDay }));
  const query = applyExtras(body, extras);
  const data = await google(c, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'PATCH', query, body });
  return summarize(c, data);
}

/** What create/update hand back: enough for the UI to jump to the event and show its time. */
function summarize(c, data) {
  const allDay = !!data.start.date;
  return {
    id: data.id,
    title: data.summary || '(No title)',
    allDay,
    start: allDay ? localMidnight(data.start.date, c.tz).toISOString() : data.start.dateTime,
    end: allDay ? localMidnight(data.end.date, c.tz).toISOString() : data.end.dateTime,
    htmlLink: data.htmlLink,
    meetLink: meetingLink(data),
  };
}

/** Delete for real. 404/410 ("already gone") counts as success. */
export async function deleteEvent(c, { calendarId, eventId }) {
  try {
    await google(c, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'DELETE' });
  } catch (err) {
    if (err.googleStatus !== 404 && err.googleStatus !== 410) throw err;
  }
  return { deleted: true };
}

export async function getEvent(c, { calendarId, eventId }) {
  return google(c, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
}
