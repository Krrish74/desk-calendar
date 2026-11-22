// state.js: the app's shared state, which dates are on screen, loading events,
// and a tiny event bus so modules can ask for a redraw without importing each other.
// (Ported from src/renderer/js/data.js.)
//
// state.view + state.anchor decide what's on screen:
//   agenda → state.agendaDays days starting at the anchor (grows as you scroll down)
//   day    → the anchor day
//   3day   → the anchor day and the next two
//   month  → the month containing the anchor (shown as whole weeks)

import { api } from './api.js';
import { startOfDay, addDays, addMonths, startOfWeek, fmtTime } from './util.js';

export const state = {
  view: 'agenda',
  anchor: startOfDay(new Date()),
  agendaDays: 14,
  prefs: { weekStartsOn: 0, agendaDays: 14, timeFormat: 'system', defaultEventMinutes: 60, defaultCalendarId: null, assistantModel: 'claude-haiku-5-5' },
  me: null,            // { email, sample, assistantReady }
  events: [],          // events in the visible range
  soonEvents: [],      // now → end of tomorrow, for the countdown (whatever the view shows)
  calendars: [],       // every calendar, with .visible
  highlightId: null,   // event to flash after it's created / moved
  settleId: null,      // event that just got dropped (little bounce)
  loading: false,
};

// --- Event bus ------------------------------------------------------------------
//   'render'           redraw the current view from state (no network)
//   'reload'           fetch events again, then redraw
//   'countdown'        redraw the countdown strip
//   'status', text, isError   show a short message at the top of the calendar
const listeners = {};
export const on = (name, fn) => { (listeners[name] ||= []).push(fn); };
export const emit = (name, ...args) => { for (const fn of listeners[name] || []) fn(...args); };
export const status = (text, isError = false) => emit('status', text, isError);

// --- Ranges -------------------------------------------------------------------------

/** The [start, end) dates the current view covers. */
export function viewRange(view = state.view, anchor = state.anchor) {
  if (view === 'day') return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 1) };
  if (view === '3day') return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 3) };
  if (view === 'month') {
    // Whole weeks covering the month, like Google's month grid (always 6 rows).
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first, state.prefs.weekStartsOn);
    return { start, end: addDays(start, 42), monthStart: first };
  }
  return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), state.agendaDays) };
}

/** Header title: "November 2026" for month/agenda, "Sun, Nov 22" for a day, "Nov 22 – 24" for 3 days. */
export function rangeLabel() {
  const { start, end } = viewRange();
  if (state.view === 'day') return start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (state.view === '3day') {
    const last = addDays(end, -1);
    const md = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return start.getMonth() === last.getMonth() ? `${md(start)} – ${last.getDate()}` : `${md(start)} – ${md(last)}`;
  }
  const yearSuffix = state.anchor.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' };
  return state.anchor.toLocaleDateString([], { month: 'long', ...yearSuffix });
}

/** Move one period back (-1) or forward (+1). */
export function step(direction) {
  const a = state.anchor;
  if (state.view === 'day') state.anchor = addDays(a, direction);
  else if (state.view === '3day') state.anchor = addDays(a, 3 * direction);
  else if (state.view === 'month') state.anchor = addMonths(a, direction);
  else { state.anchor = addDays(a, state.prefs.agendaDays * direction); state.agendaDays = state.prefs.agendaDays; }
  emit('navigate');
}

export function goToday() { state.anchor = startOfDay(new Date()); state.agendaDays = state.prefs.agendaDays; emit('navigate'); }
export function goToDate(d, view) {
  state.anchor = startOfDay(d);
  if (view) state.view = view;
  if (state.view === 'agenda') state.agendaDays = state.prefs.agendaDays;
  emit('navigate');
}

// --- Loading ------------------------------------------------------------------------

const toDates = (list) => list.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));

// Recently fetched ranges, so going back to a month you just saw draws instantly
// (then refreshes). Phase 3 adds an offline copy in the service worker.
const cache = new Map(); // "startISO|endISO" → { at, events }
const cacheKey = (s, e) => `${s.toISOString()}|${e.toISOString()}`;

/** Show cached events for the current range right away, if we have them. */
export function fromCache() {
  const { start, end } = viewRange();
  const hit = cache.get(cacheKey(start, end));
  if (hit) state.events = hit.events;
  return !!hit;
}

let loadSeq = 0; // ignore replies from older requests if you navigate quickly

export async function loadEvents() {
  const seq = ++loadSeq;
  const { start, end } = viewRange();
  const now = new Date();
  const soonStart = startOfDay(now);
  const soonEnd = addDays(soonStart, 2);
  // If the view already covers today and tomorrow, one request serves both.
  const coversSoon = start <= soonStart && end >= soonEnd;
  state.loading = true;
  emit('loading', true);
  try {
    const [inView, soon] = await Promise.all([
      api.events(start, end),
      coversSoon ? null : api.events(soonStart, soonEnd),
    ]);
    if (seq !== loadSeq) return;
    state.events = toDates(inView);
    cache.set(cacheKey(start, end), { at: Date.now(), events: state.events });
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    const soonList = coversSoon ? state.events : toDates(soon);
    state.soonEvents = soonList.filter((e) => e.end > now && e.start < soonEnd).sort((a, b) => a.start - b.start);
    emit('render');
    emit('countdown');
    emit('loaded', new Date());
  } catch (e) {
    if (seq === loadSeq) status(e.message, true);
  } finally {
    if (seq === loadSeq) { state.loading = false; emit('loading', false); }
  }
}

export async function loadCalendars(fresh = false) {
  try {
    state.calendars = await api.calendars(fresh);
  } catch (e) { status(e.message, true); }
}

/** Drop cached ranges (after a change, so stale copies don't flash back). */
export const clearCache = () => cache.clear();

export const calendarById = (id) => state.calendars.find((c) => c.id === id);
export const defaultCalendarId = () =>
  (calendarById(state.prefs.defaultCalendarId)?.canEdit && state.prefs.defaultCalendarId)
  || state.calendars.find((c) => c.primary)?.id || 'primary';

export const lastUpdatedText = (d) => `Updated ${fmtTime(d)}`;
