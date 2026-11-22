// app.js: starts the app and wires everything together.
//
//   1. Ask the Worker who's signed in (/api/me). Not signed in → the sign-in screen.
//   2. Load settings + calendars, draw the last-used view, fetch its events.
//   3. Keep things fresh: every 3 minutes while the app is open, and whenever you come
//      back to it (iOS freezes Home Screen apps in the background).
//   4. The countdown strip ticks every second.
//
// Navigation: bottom tabs pick the view; ‹ › and swiping left/right move by one
// period (day, 3 days, month; Agenda jumps by two weeks); "Today" comes back.

import { $, el, startOfDay, isToday, fmtTime, duration, setTimeFormat } from './util.js';
import { api, setSignedOutHandler, setOfflineHandler, clearOfflineData } from './api.js';
import { state, on, emit, viewRange, rangeLabel, step, goToday, goToDate, loadEvents as loadEventsOnly, loadCalendars, fromCache } from './state.js';
import { loadTasks, resetTasksView } from './tasks.js';
import { renderAgenda, resetAgenda } from './views/agenda.js';
import { renderTimeGrid, positionNowLine } from './views/timegrid.js';
import { renderMonth } from './views/month.js';
import { openDetails } from './details.js';
import { openQuickAdd } from './quickadd.js';
import { openAssistant } from './chat.js';
import { openSettings } from './settings.js';
import { sheetOpen, closeSheet, showToast } from './sheet.js';

const REFRESH_MINUTES = 3;

/** Events for the view (and the countdown), plus Google Tasks when the Agenda is showing. */
const loadEvents = () => Promise.all([loadEventsOnly(), loadTasks(viewRange())]);

// ---------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------

async function boot() {
  // Signed out (or the sign-in expired): don't keep calendar data on the phone.
  setSignedOutHandler((msg) => { clearOfflineData(); showSignIn(msg); });
  setOfflineHandler(() => {
    if (Date.now() - offlineNotedAt < 60000) return; // say it once a minute, not per request
    offlineNotedAt = Date.now();
    emit('status', "You're offline: showing your last-loaded events.", true);
  });
  // The service worker (sw.js) keeps the app and your last-loaded events for offline starts.
  navigator.serviceWorker?.register('/sw.js').catch((err) => console.warn('Service worker:', err.message));
  try {
    state.me = await api.me();
  } catch (err) {
    if (err.code !== 'NOT_SIGNED_IN') showSignIn(err.message, true);
    return;
  }
  state.prefs = { ...state.prefs, ...state.me.prefs };
  setTimeFormat(state.prefs.timeFormat);
  state.view = ['agenda', 'day', '3day', 'month'].includes(state.prefs.view) ? state.prefs.view : 'agenda';
  state.agendaDays = state.prefs.agendaDays;
  $('signin').hidden = true;
  $('app').hidden = false;
  $('sample-badge').hidden = !state.me.sample;
  renderChrome();
  renderView();
  await Promise.all([loadCalendars(), loadEvents()]);
  setInterval(() => { if (!document.hidden) loadEvents(); }, REFRESH_MINUTES * 60 * 1000);
  setInterval(tickCountdown, 1000);
  installHint();
  // Opened by tapping a reminder? (sw.js opens "/?open=calendarId|eventId|start")
  openFromLink(new URL(location.href));
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open') openFromLink(new URL(e.data.url));
  });
}

let offlineNotedAt = 0;

/** Show the event a tapped reminder points to. */
async function openFromLink(url) {
  const ref = url.searchParams.get('open');
  if (!ref) return;
  history.replaceState(null, '', '/'); // so a reload doesn't reopen it
  const [calendarId, eventId, startIso] = ref.split('|');
  const start = new Date(startIso);
  if (!calendarId || !eventId || Number.isNaN(start.getTime())) return;
  const same = (e) => e.id === eventId && e.calendarId === calendarId;
  let ev = [...state.soonEvents, ...state.events].find(same);
  if (!ev) {
    try {
      const day = startOfDay(start);
      const list = await api.events(day, new Date(+day + 2 * 864e5));
      const found = list.find(same);
      if (found) ev = { ...found, start: new Date(found.start), end: new Date(found.end) };
    } catch { /* offline: nothing to show */ }
  }
  if (ev) openDetails(ev);
  else emit('status', 'That event was moved or deleted.', true);
}

/**
 * Opened in Safari rather than from the Home Screen? Explain how to install it once:
 * reminders (push notifications) only work for Home Screen apps on iPhone.
 */
function installHint() {
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let seen = false;
  try { seen = localStorage.getItem('dc-install-hint') === '1'; } catch { /* storage blocked */ }
  if (!iOS || installed || seen) return;
  showToast('Install it: tap Share, then "Add to Home Screen".', 'Got it', () => {
    try { localStorage.setItem('dc-install-hint', '1'); } catch { /* ignore */ }
  }, 20000);
}

function showSignIn(message, isError = false) {
  closeSheet(true);
  $('scrim').hidden = true;
  $('app').hidden = true;
  $('signin').hidden = false;
  if (message) {
    $('signin-msg').textContent = message;
    $('signin-msg').classList.toggle('error', isError);
  }
}

// Coming back to the app (iOS pauses it in the background): refresh, and fix "today".
document.addEventListener('visibilitychange', () => {
  if (document.hidden || $('app').hidden) return;
  refreshPrefs().finally(loadEvents);
});

/**
 * Pick up settings changed elsewhere: the Windows app shares some of them through the
 * Worker (worker/src/sync.js), e.g. which calendars are shown or the time format.
 */
async function refreshPrefs() {
  try {
    const me = await api.me();
    if (JSON.stringify(me.prefs) === JSON.stringify(state.prefs)) return;
    state.me = me;
    state.prefs = { ...state.prefs, ...me.prefs };
    setTimeFormat(state.prefs.timeFormat);
    await loadCalendars();
    emit('render');
  } catch { /* offline or signed out: handled by the normal loading */ }
}

// ---------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------

let lastDrawn = '';

function renderChrome() {
  $('range-label').textContent = rangeLabel();
  for (const b of $('tabs').querySelectorAll('[data-view]')) b.classList.toggle('active', b.dataset.view === state.view);
  for (const b of $('tabs').querySelectorAll('[data-view] .ico')) {
    b.className = b.className.replace(/-filled\b/, '');
    if (b.parentElement.classList.contains('active')) b.className += '-filled';
  }
  // Countdown strip: Agenda / Day / 3-day (Month needs the space).
  $('countdown').hidden = state.view === 'month' || !countdownEvent();
}

function renderView() {
  const view = $('view');
  const key = `${state.view}|${viewRange().start.toDateString()}`;
  let content;
  if (state.view === 'day') content = renderTimeGrid(1);
  else if (state.view === '3day') content = renderTimeGrid(3);
  else if (state.view === 'month') content = renderMonth(view);
  else content = renderAgenda();
  view.classList.toggle('no-scroll', state.view !== 'agenda');
  if (key !== lastDrawn) content.classList.add('fade-in');
  const keepScroll = key === lastDrawn && state.view === 'agenda' ? view.scrollTop : 0;
  view.replaceChildren(content);
  view.scrollTop = keepScroll;
  lastDrawn = key;
  flashHighlighted();
  state.settleId = null;
}

/** A just-created or moved event: scroll to it and flash it once. */
function flashHighlighted() {
  if (!state.highlightId) return;
  const target = $('view').querySelector(`[data-id="${CSS.escape(state.highlightId)}"]`);
  if (!target) return; // not loaded yet; we'll try again after the fetch
  requestAnimationFrame(() => {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('flash');
  });
  state.highlightId = null;
}

// The bus (see state.js)
on('render', () => { renderChrome(); renderView(); });
on('reload', () => loadEvents());
on('countdown', () => { tickCountdown(); renderChrome(); });
on('navigate', () => {
  resetAgenda();
  resetTasksView();
  renderChrome();
  if (!fromCache()) state.events = []; // draw the empty grid now; events arrive in a moment
  renderView();
  loadEvents();
});
on('goto', (date, view) => {
  if (view && view !== state.view) api.setPrefs({ view }).catch(() => {});
  goToDate(date, view);
});
// "Schedule with assistant" on a task: open the assistant with the request filled in.
on('assistant', (text) => openAssistant({ prefill: text }));
on('signedOut', (msg) => { clearOfflineData(); showSignIn(msg); });

let statusTimer;
on('status', (text, isError) => {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', !!isError);
  s.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => s.classList.remove('show'), isError ? 5000 : 2500);
});
on('loading', (busy) => $('range-label').classList.toggle('muted', busy));

// ---------------------------------------------------------------------------------------
// Countdown (ported from src/renderer/js/sidebar.js)
// ---------------------------------------------------------------------------------------

let renderedDay = new Date().toDateString();

/** The event to count down to: the one happening now, unless the next starts within 5 min. */
function countdownEvent() {
  const now = new Date();
  const timed = state.soonEvents.filter((e) => !e.allDay && e.end > now);
  const current = timed.find((e) => e.start <= now);
  const next = timed.find((e) => e.start > now);
  const showNow = current && (!next || next.start - now > 5 * 60000);
  return showNow ? { ev: current, now: true } : next ? { ev: next, now: false } : null;
}

function tickCountdown() {
  positionNowLine();
  // Past midnight? Re-fetch so "today" is right everywhere.
  if (new Date().toDateString() !== renderedDay) {
    renderedDay = new Date().toDateString();
    emit('render');
    loadEvents();
    return;
  }
  const pick = countdownEvent();
  const card = $('countdown');
  const shouldShow = !!pick && state.view !== 'month';
  if (card.hidden === shouldShow) card.hidden = !shouldShow;
  if (!pick) return;
  const { ev } = pick;
  const now = new Date();
  card.style.borderLeftColor = ev.color;
  $('cd-title').textContent = ev.title;
  const join = $('cd-join');
  join.hidden = !ev.meetLink;
  if (ev.meetLink) join.href = ev.meetLink;
  $('cd-progress').hidden = !pick.now;
  const time = $('cd-time');
  if (pick.now) {
    $('cd-label').textContent = 'Now';
    time.replaceChildren('ends in ', el('b', '', duration(ev.end - now)));
    $('cd-progress-bar').style.width = `${Math.min(100, ((now - ev.start) / (ev.end - ev.start)) * 100).toFixed(1)}%`;
    $('cd-progress').style.color = ev.color;
  } else {
    $('cd-label').textContent = `Next · ${fmtTime(ev.start)}${isToday(ev.start) ? '' : ' tomorrow'}`;
    time.replaceChildren('in ', el('b', '', duration(ev.start - now)), ev.location ? ` · ${ev.location}` : '');
  }
  card.onclick = (e) => { if (!e.target.closest('#cd-join')) openDetails(ev); };
}

// ---------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tab === 'assistant') { openAssistant(); return; }
  const view = b.dataset.view;
  if (!view) return;
  if (view === state.view) { goToday(); return; } // tapping the current tab again → today
  // Leaving Month for a day-based view: start at today if today is in that month.
  if (state.view === 'month') {
    const today = startOfDay(new Date());
    const { monthStart } = viewRange();
    if (today.getMonth() === monthStart.getMonth() && today.getFullYear() === monthStart.getFullYear()) state.anchor = today;
  }
  state.view = view;
  if (view === 'agenda') state.agendaDays = state.prefs.agendaDays;
  api.setPrefs({ view }).catch(() => {});
  emit('navigate');
});
$('btn-prev').onclick = () => step(-1);
$('btn-next').onclick = () => step(1);
$('btn-today').onclick = goToday;
$('range-label').onclick = () => { loadCalendars(true); loadEvents(); }; // tap the title to refresh
$('btn-settings').onclick = openSettings;
$('fab').onclick = openQuickAdd;

// Swipe left/right on Day / 3-day / Month to change period.
(() => {
  let sx = 0, sy = 0, t0 = 0, tracking = false;
  const view = $('view');
  view.addEventListener('touchstart', (e) => {
    tracking = e.touches.length === 1 && state.view !== 'agenda';
    if (!tracking) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!tracking || document.body.classList.contains('dragging')) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - t0 < 600) step(dx < 0 ? 1 : -1);
  });
})();

// Escape closes a sheet (hardware keyboards / desktop testing).
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

boot();
