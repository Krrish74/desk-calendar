// util.js: small helpers every other module uses (ported from src/renderer/js/util.js).

export const $ = (id) => document.getElementById(id);

/** Build an element safely. Text is set with textContent, never innerHTML, so an
 *  event titled "<img onerror=...>" is shown as text, not run as code. */
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A Fluent icon element, e.g. icon('video'). Names: see css/icons.css. */
export const icon = (name) => el('i', `ico i-${name}`);

export function button(className, content, onClick) {
  const b = el('button', className);
  b.type = 'button';
  for (const c of [].concat(content)) b.append(typeof c === 'string' && c.startsWith('ico:') ? icon(c.slice(4)) : c);
  if (onClick) b.onclick = onClick;
  return b;
}

// --- Dates (all in the phone's local time zone) ------------------------------

export const pad = (n) => String(n).padStart(2, '0');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x; };
export const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
export const isToday = (d) => sameDay(d, new Date());
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fromYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/** Start of the week containing `d` (weekStartsOn: 0 = Sunday, 1 = Monday). */
export function startOfWeek(d, weekStartsOn) {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() - weekStartsOn + 7) % 7));
}

// --- Formatting -------------------------------------------------------------------

let timeFormat = 'system';
export const setTimeFormat = (f) => { timeFormat = f; };
/** { hour12 } from Settings → Time format, or {} to follow the iPhone. */
export const hourOpts = () => (timeFormat === '12' ? { hour12: true } : timeFormat === '24' ? { hour12: false } : {});
export const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...hourOpts() });
export const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtTimeRange = (ev) => (ev.allDay ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`);

/** "Tue, Nov 17 · 6:00 – 7:00 PM", "Sat, Nov 21 – Mon, Nov 23" for multi-day. */
export function whenText(ev) {
  if (ev.allDay) {
    const last = addDays(ev.end, -1);
    return sameDay(ev.start, last) ? `${fmtDay(ev.start)} · All day` : `${fmtDay(ev.start)} – ${fmtDay(last)}`;
  }
  if (sameDay(ev.start, ev.end)) return `${fmtDay(ev.start)} · ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
  return `${fmtDay(ev.start)}, ${fmtTime(ev.start)} – ${fmtDay(ev.end)}, ${fmtTime(ev.end)}`;
}

/** Countdown text: 1h 05m above an hour, 12m 04s under, 45s under a minute. */
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** Dark text on light colors, white on dark ones (WCAG relative luminance). */
export function textOn(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#10131a' : '#fff';
}

/** Fill an element with the event's color and readable text. */
export function paintEvent(node, ev) {
  node.style.background = ev.color;
  node.style.color = textOn(ev.color);
}

/** Google descriptions can contain HTML. Show them as plain text with line breaks. */
export function htmlToText(html) {
  if (!html) return '';
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'), 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text with https:// links turned into tappable links (built as nodes, never HTML). */
export function linkify(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(https:\/\/[^\s<>"')]+)/g)) {
    if (/^https:\/\//.test(part)) {
      const a = el('a', '', part);
      a.href = part;
      a.target = '_blank';
      a.rel = 'noopener';
      frag.append(a);
    } else if (part) frag.append(part);
  }
  return frag;
}

/** Open a URL outside the app (Safari / the Meet or Zoom app). Only https. */
export function openUrl(url) {
  if (typeof url === 'string' && url.startsWith('https://')) window.open(url, '_blank', 'noopener');
}
