// calendar.js: everything that talks to the Google Calendar API.
//
// The UI and the chatbot both go through these functions, so there's exactly one
// place where events are fetched, created, edited or deleted.
//
// API reference: https://developers.google.com/calendar/api/v3/reference

const crypto = require('crypto');
const { calendar: calendarApi } = require('@googleapis/calendar');
const auth = require('./auth');
const prefs = require('./prefs');

function api() {
  return calendarApi({ version: 'v3', auth: auth.getClient() });
}

// Event colors as Google Calendar's web UI shows them today. (The API's /colors
// endpoint returns an older, paler palette for the same IDs, so we map directly.)
// Key = event.colorId ("1".."11"), which you set in Google Calendar via the color dot on an event.
const EVENT_COLORS = {
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
 *   visible  whether Desk Calendar shows it: your tick in the sidebar's "My calendars",
 *            or, if you never changed it here, whether it's ticked in Google Calendar.
 * The list is cached for a minute (quick add looks it up on every keystroke).
 */
let calendarCache = { at: 0, list: null };

async function listCalendars({ fresh = false } = {}) {
  if (!fresh && calendarCache.list && Date.now() - calendarCache.at < 60 * 1000) {
    return withVisibility(calendarCache.list);
  }
  const { data } = await api().calendarList.list({ minAccessRole: 'freeBusyReader' });
  const list = (data.items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    primary: !!c.primary,
    canEdit: c.accessRole === 'owner' || c.accessRole === 'writer',
    googleSelected: !!c.selected,
    // e.g. [{ method: 'popup', minutes: 10 }]: used when an event says "use default reminders"
    defaultReminders: c.defaultReminders || [],
  }));
  // Primary first, then the rest alphabetically (like Google's sidebar).
  list.sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
  calendarCache = { at: Date.now(), list };
  return withVisibility(list);
}

function withVisibility(list) {
  const overrides = prefs.get('calendarVisibility');
  return list.map((c) => ({ ...c, visible: overrides[c.id] ?? c.googleSelected }));
}

/** Show or hide one calendar in Desk Calendar (doesn't change Google Calendar itself). */
function setCalendarVisible(id, visible) {
  prefs.set({ calendarVisibility: { ...prefs.get('calendarVisibility'), [id]: visible } });
}

/**
 * Events between `start` and `end` (Date objects) across all visible calendars,
 * merged and sorted by start time.
 *
 * singleEvents: true expands recurring events ("every Monday") into individual
 * occurrences, so each one has its own id. Editing that id changes just that
 * occurrence, exactly like choosing "This event" in Google Calendar.
 */
async function listEvents(start, end) {
  const calendars = (await listCalendars()).filter((c) => c.visible);

  // Fetch every calendar in parallel. One failing calendar shouldn't blank the
  // whole list, so failures are logged and skipped.
  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      try {
        const { data } = await api().events.list({
          calendarId: cal.id,
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
        });
        return (data.items || [])
          .filter((e) => e.status !== 'cancelled')
          .filter((e) => !declinedByMe(e))
          .map((e) => normalize(e, cal));
      } catch (err) {
        console.warn(`Skipping calendar ${cal.name}:`, err.message);
        return [];
      }
    }),
  );

  return perCalendar.flat().sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Hide meetings you've declined, like Google Calendar does by default.
function declinedByMe(e) {
  return (e.attendees || []).some((a) => a.self && a.responseStatus === 'declined');
}

/**
 * Turn Google's event shape into a small, flat object the UI can use directly.
 * All-day events use { date: 'YYYY-MM-DD' }; timed events use { dateTime: ISO }.
 */
function normalize(e, cal) {
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
    // For all-day events we build local-midnight Dates. `new Date('2026-11-16')`
    // would mean UTC midnight, which is the previous evening in US timezones.
    start: allDay ? localMidnight(e.start.date).toISOString() : e.start.dateTime,
    end: allDay ? localMidnight(e.end.date).toISOString() : e.end.dateTime,
    color: EVENT_COLORS[e.colorId] || cal.color,
    meetLink: meetingLink(e),
    // true only for a real Google Meet attached to the event (not a pasted Zoom link)
    hasGoogleMeet: !!(e.hangoutLink || e.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet'),
    colorId: e.colorId || '',                     // '' = uses the calendar's color
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

function meetingLink(e) {
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  if (video?.uri) return video.uri;
  const text = `${e.location || ''} ${e.description || ''}`;
  const m = text.match(MEETING_URL);
  return m ? m[0] : '';
}

function localMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Convert our simple { start, end, allDay } into Google's request body.
 *
 * Timed events: start/end are date-times. No end → 1 hour long.
 * All-day events: start is the first day, end is the LAST day (inclusive);
 *   no end → a single day. Google wants an EXCLUSIVE end date, so a one-day
 *   event on Nov 16 is sent as { start: 2026-11-16, end: 2026-11-17 }.
 */
function toGoogleTimes({ start, end, allDay }) {
  const s = toDate(start);
  if (allDay) {
    const lastDay = end ? toDate(end) : s;
    const exclusiveEnd = addDays(lastDay < s ? s : lastDay, 1);
    return { start: { date: ymd(s) }, end: { date: ymd(exclusiveEnd) } };
  }
  const e = end ? toDate(end) : new Date(s.getTime() + prefs.get('defaultEventMinutes') * 60 * 1000);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; // e.g. America/New_York
  return {
    start: { dateTime: s.toISOString(), timeZone },
    end: { dateTime: e.toISOString(), timeZone },
  };
}

// A bare 'YYYY-MM-DD' means local midnight here (plain `new Date()` would read it as UTC).
// Anything else ('2026-11-17T18:00', full ISO strings, Date objects) goes to `new Date`.
const toDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? localMidnight(v) : new Date(v));
const addDays =(d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The optional extras the editor can set, turned into Google's format:
 *   colorId    '1'..'11' for one of Google's event colors, '' to go back to the calendar's color
 *   reminders  'default' (the calendar's own reminders) or a list of minutes, e.g. [10, 60, 1440]
 *   meet       'add' to create a Google Meet link, 'remove' to take it off
 *   taskLink   'listId|taskId': marks the event as a time block for that Google Task
 *              (stored privately on the event; only this app reads it)
 * Returns extra request parameters (Meet changes need conferenceDataVersion=1).
 */
function applyExtras(body, { colorId, reminders, meet, taskLink }) {
  if (colorId !== undefined) body.colorId = colorId || null; // null clears it
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
async function createEvent({ calendarId = 'primary', title, start, end, allDay, location, description, ...extras }) {
  const requestBody = { summary: title, location, description, ...toGoogleTimes({ start, end, allDay }) };
  const params = applyExtras(requestBody, extras);
  const { data } = await api().events.insert({ calendarId, requestBody, ...params });
  return summarize(data);
}

/**
 * Edit an event. Only the fields you pass are changed (that's what PATCH means).
 * If you pass start you should pass end too, so the duration stays what you expect.
 */
async function updateEvent({ calendarId, eventId, title, start, end, allDay, location, description, ...extras }) {
  const body = {};
  if (title !== undefined) body.summary = title;
  if (location !== undefined) body.location = location;
  if (description !== undefined) body.description = description;
  if (start !== undefined) Object.assign(body, toGoogleTimes({ start, end, allDay }));
  const params = applyExtras(body, extras);
  const { data } = await api().events.patch({ calendarId, eventId, requestBody: body, ...params });
  return summarize(data);
}

/** What create/update hand back: enough for the UI to jump to the event and show its time. */
function summarize(data) {
  const allDay = !!data.start.date;
  return {
    id: data.id,
    title: data.summary || '(No title)',
    allDay,
    start: allDay ? localMidnight(data.start.date).toISOString() : data.start.dateTime,
    end: allDay ? localMidnight(data.end.date).toISOString() : data.end.dateTime,
    htmlLink: data.htmlLink,
    meetLink: meetingLink(data),
  };
}

async function deleteEvent({ calendarId, eventId }) {
  await api().events.delete({ calendarId, eventId });
  return { deleted: true };
}

async function getEvent({ calendarId, eventId }) {
  const { data } = await api().events.get({ calendarId, eventId });
  return data;
}

module.exports = { listCalendars, setCalendarVisible, listEvents, createEvent, updateEvent, deleteEvent, getEvent };
