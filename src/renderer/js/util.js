// util.js: small helpers every other script uses (loaded first).
//
// This page has NO direct access to Google or your files. Every backend action
// goes through `window.desk.*` (defined in preload.js), which returns
//   { ok: true, data }   on success, or
//   { error, code }      on failure.

const $ = (id) => document.getElementById(id);

/** Unwrap a backend reply: return data, or throw. Bounces to sign-in if needed. */
function unwrap(res) {
  if (res?.code === 'NOT_SIGNED_IN') { showSetup(res.error); throw new Error(res.error); }
  if (res?.error) throw new Error(res.error);
  return res.data;
}

/** Bottom status line. */
function status(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

/** Build an element safely. Text is set with textContent, never innerHTML, so an
 *  event titled "<img onerror=...>" is shown as text, not run as code. */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A Fluent icon element, e.g. icon('video'). Names: see icons.css. */
const icon = (name) => el('i', `ico i-${name}`);

// --- Dates -------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const isToday = (d) => sameDay(d, new Date());
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Start of the week containing `d` (weekStartsOn: 0 = Sunday, 1 = Monday). */
function startOfWeek(d, weekStartsOn) {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStartsOn + 7) % 7;
  return addDays(x, -diff);
}

// --- Formatting (Windows region settings, unless Settings → Time format says otherwise)

/** { hour12: true/false } from the Time format setting, or {} to follow Windows. */
const hourOpts = () => {
  const f = typeof state !== 'undefined' ? state.prefs.timeFormat : 'system';
  return f === '12' ? { hour12: true } : f === '24' ? { hour12: false } : {};
};
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...hourOpts() });
const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTimeRange = (ev) => (ev.allDay ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`);

/** Countdown text: 1h 05m above an hour, 12m 04s under, 45s under a minute. */
function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

// --- Popovers (the "+N more" list now; event details in phase 4) -------------

let openPop = null;
let popOnClose = null;

/**
 * Show `content` in a floating card next to `anchorEl`. Closes on outside click or Esc.
 * Options: side: true places it beside the anchor (left or right, whichever fits),
 * otherwise below it; onClose runs when it closes.
 */
function openPopover(content, anchorEl, { side = false, onClose = null } = {}) {
  // Measure first: the anchor may live inside the popover we're about to close.
  const r = anchorEl.getBoundingClientRect();
  closePopover();
  const pop = el('div', 'popover');
  pop.append(content);
  document.body.append(pop);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left, top;
  if (side) {
    left = r.right + 10 + w < innerWidth ? r.right + 10 : r.left - w - 10;
    top = r.top;
  } else {
    left = r.left;
    top = r.bottom + 6;
    if (top + h > innerHeight - 12) top = r.top - h - 6;
  }
  // Keep it inside the window.
  pop.style.left = `${clamp(left, 12, innerWidth - w - 12)}px`;
  pop.style.top = `${clamp(top, 12, innerHeight - h - 12)}px`;
  openPop = pop;
  popOnClose = onClose;
  setTimeout(() => document.addEventListener('mousedown', outsideClose), 0);
}

function closePopover() {
  openPop?.remove();
  openPop = null;
  document.removeEventListener('mousedown', outsideClose);
  const cb = popOnClose;
  popOnClose = null;
  cb?.();
  if (typeof deferredRender !== 'undefined' && deferredRender) { deferredRender = false; renderView(); } // see views.js
}

function outsideClose(e) { if (openPop && !openPop.contains(e.target)) closePopover(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
