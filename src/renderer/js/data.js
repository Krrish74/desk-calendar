// data.js: the app's shared state, loading events, and date navigation.
//
// state.view + state.anchor decide what's on screen:
//   day    → the anchor day
//   week   → the week containing the anchor
//   month  → the month containing the anchor (shown as whole weeks)
//   agenda → state.prefs.agendaDays days starting at the anchor ("Agenda shows" setting)
// The toolbar's ‹ › move the anchor by one period; "Today" resets it.

const REFRESH_MINUTES = 3;  // ← how often to re-fetch from Google

const state = {
  view: 'week',
  anchor: startOfDay(new Date()),
  weekStartsOn: 0,
  prefs: { agendaDays: 8, timeFormat: 'system', defaultEventMinutes: 60, defaultCalendarId: null }, // from Settings
  events: [],          // events in the visible range
  soonEvents: [],      // today + tomorrow, for the countdown (whatever the view shows)
  calendars: [],       // every calendar, with .visible
  lastLoaded: 0,
  highlightId: null,   // event to flash after it's created
};

/** The [start, end) dates the current view covers. */
function viewRange(view = state.view, anchor = state.anchor) {
  if (view === 'day') return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 1) };
  if (view === 'week') {
    const start = startOfWeek(anchor, state.weekStartsOn);
    return { start, end: addDays(start, 7) };
  }
  if (view === 'month') {
    // Whole weeks covering the month, like Google's month grid (always 6 rows).
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first, state.weekStartsOn);
    return { start, end: addDays(start, 42), monthStart: first, monthEnd: addMonths(first, 1) };
  }
  return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), state.prefs.agendaDays) }; // agenda
}

/** Toolbar title: "Sunday, November 22, 2026", "Nov 16 – 22, 2026", "November 2026"… */
function rangeLabel() {
  const { start, end } = viewRange();
  if (state.view === 'day') {
    return start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (state.view === 'month') {
    return state.anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  }
  const last = addDays(end, -1);
  const sameYear = start.getFullYear() === last.getFullYear();
  const sameMonth = sameYear && start.getMonth() === last.getMonth();
  const md = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (sameMonth) return `${md(start)} – ${last.getDate()}, ${last.getFullYear()}`;
  if (sameYear) return `${md(start)} – ${md(last)}, ${last.getFullYear()}`;
  return `${md(start)}, ${start.getFullYear()} – ${md(last)}, ${last.getFullYear()}`;
}

/** Move one period back (-1) or forward (+1). */
function step(direction) {
  const a = state.anchor;
  if (state.view === 'day') state.anchor = addDays(a, direction);
  else if (state.view === 'week') state.anchor = addDays(a, 7 * direction);
  else if (state.view === 'month') state.anchor = addMonths(a, direction);
  else state.anchor = addDays(a, state.prefs.agendaDays * direction);
  refreshScreen();
}

function goToday() { state.anchor = startOfDay(new Date()); refreshScreen(); }
function goToDate(d) { state.anchor = startOfDay(d); refreshScreen(); }

function setView(view) {
  state.view = view;
  desk.setPrefs({ view });
  refreshScreen();
}

/** Redraw everything that depends on the view/anchor, then fetch that range. */
function refreshScreen() {
  renderToolbar();
  renderMiniMonth();
  renderView();       // draw what we already have right away…
  loadEvents();       // …then fetch the new range
}

// --- Loading ---------------------------------------------------------------

const toDates = (list) => list.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
let loadSeq = 0; // ignore replies from older requests if you click ‹ › quickly

async function loadEvents() {
  const seq = ++loadSeq;
  const { start, end } = viewRange();
  const today = startOfDay(new Date());
  $('btn-refresh').classList.add('spinning');
  try {
    const [inView, soon] = await Promise.all([
      desk.getEvents(start.toISOString(), end.toISOString()),
      desk.getEvents(today.toISOString(), addDays(today, 2).toISOString()),
    ]);
    if (seq !== loadSeq) return;
    state.events = toDates(unwrap(inView));
    state.soonEvents = toDates(unwrap(soon));
    state.lastLoaded = Date.now();
    renderView();
    tickCountdown();
    status(`Updated ${fmtTime(new Date())}`);
  } catch (e) {
    status(e.message, true);
  } finally {
    if (seq === loadSeq) $('btn-refresh').classList.remove('spinning');
  }
}

async function loadCalendars() {
  try {
    state.calendars = unwrap(await desk.getCalendars());
    renderCalendarList();
  } catch (e) { status(e.message, true); }
}
