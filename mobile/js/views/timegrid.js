// views/timegrid.js: the Day and 3-day views (an hour grid, like Google Calendar).
// Ported from src/renderer/js/view-time.js; the layout math is the same.
//
//   ┌ gutter ┬ SUN 22 ┬ MON 23 ┬ TUE 24      ← day headers (tap → that day)
//   ├────────┼────────┴────────┴──          ← all-day row: multi-day bars span columns
//   │  9 AM  │ ┌─────┐                      ← scrolling hour grid
//   │ 10 AM  │ │Class│ ┌───┬───┐            ← overlapping events sit side by side
//   │ ───────●━━━━━━━━━━━━━━━━━━━           ← red current-time line (today only)
//
// Touch:
//   tap an event          → details sheet
//   tap an empty slot     → new event at that time (editor)
//   long-press an event   → it lifts; drag it to another time (snaps to 15 min) or,
//                           in 3-day view, another day. Let go to save.

import { el, addDays, startOfDay, isToday, clamp, fmtTime, paintEvent, hourOpts, pad } from '../util.js';
import { state, viewRange, emit, status } from '../state.js';
import { openDetails } from '../details.js';
import { openEditor } from '../editor.js';
import { moveEvent } from '../actions.js';
import { onLongPress, edgeScroller } from '../touch.js';

export const HOUR_H = 56;   // ← pixels per hour (keep in sync with background-size in app.css)
const MIN_BLOCK_H = 24;     // short events never get smaller than this
const SNAP_MIN = 15;        // drag snapping, in minutes
const snap = (min) => Math.round(min / SNAP_MIN) * SNAP_MIN;

let lastKey = '';           // view+range we last scrolled for (refreshes keep your position)
let lastScrollTop = null;

export function renderTimeGrid(days) {
  const { start } = viewRange();
  const dayList = Array.from({ length: days }, (_, i) => addDays(start, i));
  const now = new Date();

  // Timed events of 24 h or more go in the all-day row, like Google does.
  const isLong = (e) => e.allDay || e.end - e.start >= 24 * 3600 * 1000;
  const allDayEvents = state.events.filter(isLong);
  const timedEvents = state.events.filter((e) => !isLong(e));

  const root = el('div', 'tgrid');
  root.style.setProperty('--days', days);

  // --- Day headers -----------------------------------------------------------------
  const head = el('div', 'tg-head');
  head.append(el('div', 'tg-gutter tz', tzLabel()));
  for (const d of dayList) {
    const h = el('button', 'tg-dayhead');
    h.type = 'button';
    if (isToday(d)) h.classList.add('today');
    h.append(el('span', 'dow', d.toLocaleDateString([], { weekday: 'short' })), el('span', 'num', String(d.getDate())));
    if (days > 1) h.onclick = () => emit('goto', d, 'day');
    head.append(h);
  }

  // --- All-day row --------------------------------------------------------------------
  const allDay = el('div', 'tg-allday');
  allDay.append(el('div', 'tg-gutter'));
  const lanes = el('div', 'tg-allday-lanes');
  for (const seg of spanSegments(allDayEvents, dayList)) {
    const bar = el('div', 'chip', seg.ev.title);
    bar.dataset.id = seg.ev.id;
    paintEvent(bar, seg.ev);
    bar.style.gridColumn = `${seg.from + 1} / ${seg.to + 2}`;
    bar.style.gridRow = String(seg.lane + 1);
    if (seg.ev.end <= now) bar.classList.add('past');
    bar.onclick = () => openDetails(seg.ev);
    lanes.append(bar);
  }
  allDay.append(lanes);

  // --- Hour grid ------------------------------------------------------------------------
  const scroll = el('div', 'tg-scroll');
  const body = el('div', 'tg-body');
  body.style.height = `${24 * HOUR_H}px`;
  body.style.boxSizing = 'content-box';

  const hours = el('div', 'tg-gutter tg-hours');
  hours.style.height = `${24 * HOUR_H}px`;
  for (let h = 1; h < 24; h++) {
    const label = el('span', '', new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric', ...hourOpts() }));
    label.style.top = `${h * HOUR_H}px`;
    hours.append(label);
  }
  body.append(hours);

  const cols = [];
  for (const d of dayList) {
    const col = el('div', 'tg-col');
    col.style.height = `${24 * HOUR_H}px`;
    if (isToday(d)) col.classList.add('today');
    const dayEnd = addDays(d, 1);
    const segs = timedEvents
      .filter((e) => e.start < dayEnd && e.end > d)
      .map((e) => ({ ev: e, start: e.start < d ? d : e.start, end: e.end > dayEnd ? dayEnd : e.end }));
    for (const seg of layoutDay(segs)) col.append(timeBlock(seg, d, now));
    if (isToday(d)) col.append(nowLine());
    // Tap on empty space → new event starting at that 15-minute slot.
    col.addEventListener('click', (e) => {
      if (e.target !== col) return;
      const y = e.clientY - col.getBoundingClientRect().top;
      const minutes = Math.floor(((y / HOUR_H) * 60) / SNAP_MIN) * SNAP_MIN;
      const startAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes);
      openEditor(null, { start: startAt, end: new Date(+startAt + state.prefs.defaultEventMinutes * 60000) });
    });
    body.append(col);
    cols.push(col);
  }
  scroll.append(body);
  root.append(head, allDay, scroll);

  attachDrag(scroll, body, cols, dayList, [...head.querySelectorAll('.tg-dayhead')]);

  // Scroll so the morning (or the current time) is in view, but only when the view or
  // date changed: background refreshes keep your scroll position.
  const key = `${state.view}|${start.toDateString()}`;
  scroll.addEventListener('scroll', () => { lastScrollTop = scroll.scrollTop; }, { passive: true });
  requestAnimationFrame(() => {
    if (key !== lastKey || lastScrollTop === null) {
      const target = dayList.some(isToday) ? now.getHours() - 1.5 : 7.5;
      scroll.scrollTop = Math.max(0, target) * HOUR_H;
      lastKey = key;
    } else {
      scroll.scrollTop = lastScrollTop;
    }
  });
  return root;
}

/**
 * Side-by-side layout for one day's timed events (same as desktop).
 * Overlapping events form clusters; each takes the first free column, then stretches
 * right over columns that stay free for its whole time.
 */
function layoutDay(segs) {
  segs.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const out = [];
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => {
    const columns = [];
    for (const s of cluster) {
      let c = columns.findIndex((end) => end <= s.start);
      if (c === -1) { c = columns.length; columns.push(0); }
      columns[c] = s.end;
      s.col = c;
    }
    const n = columns.length;
    for (const s of cluster) {
      let span = 1;
      for (let c = s.col + 1; c < n; c++) {
        if (cluster.some((o) => o.col === c && o.start < s.end && o.end > s.start)) break;
        span++;
      }
      s.left = s.col / n;
      s.width = span / n;
      out.push(s);
    }
    cluster = [];
  };
  for (const s of segs) {
    if (cluster.length && +s.start >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = cluster.length === 1 ? +s.end : Math.max(clusterEnd, +s.end);
  }
  if (cluster.length) flush();
  return out;
}

function timeBlock(seg, day, now) {
  const { ev } = seg;
  const top = ((seg.start - day) / 3600000) * HOUR_H;
  const height = Math.max(MIN_BLOCK_H, ((seg.end - seg.start) / 3600000) * HOUR_H - 2);

  const b = el('div', 'tblock');
  b.dataset.id = ev.id;
  b.dataset.cal = ev.calendarId;
  if (state.settleId === ev.id) b.classList.add('settle');
  b.style.top = `${top}px`;
  b.style.height = `${height}px`;
  b.style.left = `calc(${seg.left * 100}% + 1px)`;
  b.style.width = `calc(${seg.width * 100}% - ${seg.left + seg.width >= 0.999 ? 6 : 2}px)`;
  paintEvent(b, ev);
  if (ev.end <= now) b.classList.add('past');

  if (height < 40) {
    const line = el('div', 'tb-title one-line');
    line.append(el('b', '', ev.title), `, ${fmtTime(ev.start)}`);
    b.append(line);
  } else {
    b.append(el('div', 'tb-title', ev.title), el('div', 'tb-time', `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`));
    if (ev.location && height >= 66) b.append(el('div', 'tb-loc', ev.location));
  }
  b.onclick = () => openDetails(ev);
  return b;
}

function nowLine() {
  const line = el('div', 'now-line');
  line.id = 'now-line';
  positionNowLine(line);
  return line;
}

/** Called every second by the countdown timer too, so the line creeps down. */
export function positionNowLine(line = document.getElementById('now-line')) {
  if (!line) return;
  const n = new Date();
  line.style.top = `${((n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60) / 60) * HOUR_H}px`;
}

/** "GMT-5" style label for the top-left corner. */
function tzLabel() {
  const off = -new Date().getTimezoneOffset();
  const h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return `GMT${off >= 0 ? '+' : '-'}${h}${m ? ':' + pad(m) : ''}`;
}

/**
 * Bars for events that span days, stacked in lanes so they don't overlap.
 * Returns { ev, from, to, lane } with from/to as column indexes. (Also used by Month.)
 */
export function spanSegments(events, days) {
  const first = days[0];
  const last = days[days.length - 1];
  const dayIndex = (d) => Math.round((startOfDay(d) - first) / 86400000);
  const segs = events
    .filter((e) => e.start < addDays(last, 1) && e.end > first)
    .map((e) => ({ ev: e, from: Math.max(0, dayIndex(e.start)), to: Math.min(days.length - 1, dayIndex(new Date(e.end - 1))) }))
    .sort((a, b) => (a.from - b.from) || ((b.to - b.from) - (a.to - a.from)));
  const laneEnds = [];
  for (const s of segs) {
    let lane = laneEnds.findIndex((end) => end < s.from);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(-1); }
    laneEnds[lane] = s.to;
    s.lane = lane;
  }
  return segs;
}

// ---------------------------------------------------------------------------------------
// Long-press drag to move
// ---------------------------------------------------------------------------------------

function attachDrag(scroll, body, cols, dayList, heads) {
  const colAt = (x) => {
    const i = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
    if (i !== -1) return i;
    return x < cols[0].getBoundingClientRect().left ? 0 : cols.length - 1;
  };

  onLongPress(body, (origin) => {
    const block = origin.target.closest?.('.tblock');
    if (!block) return null;
    const ev = state.events.find((e) => e.id === block.dataset.id && e.calendarId === block.dataset.cal);
    if (!ev) return null;
    if (!ev.canEdit) { status(`“${ev.calendarName}” is view-only.`, true); return null; }

    const fromCol = cols.indexOf(block.parentElement);
    const scroll0 = scroll.scrollTop;
    const duration = ev.end - ev.start;
    let point = origin;
    let newStart = ev.start;
    block.classList.add('lifted');
    block.style.left = '1px';
    block.style.width = 'calc(100% - 6px)';
    scroll.classList.add('locked');

    const place = () => {
      const dy = point.y - origin.y + (scroll.scrollTop - scroll0);
      const dMin = snap((dy / HOUR_H) * 60);
      const toCol = clamp(fromCol + colAt(point.x) - colAt(origin.x), 0, cols.length - 1);
      newStart = new Date(+addDays(ev.start, toCol - fromCol) + dMin * 60000);
      // Keep it on its (new) day: no dragging past midnight.
      const day = dayList[toCol];
      const minStart = +day;
      const maxStart = +addDays(day, 1) - Math.min(duration, 24 * 3600e3);
      newStart = new Date(clamp(+newStart, minStart, Math.max(minStart, maxStart)));
      if (block.parentElement !== cols[toCol]) cols[toCol].append(block);
      block.style.top = `${((newStart - day) / 3600000) * HOUR_H}px`;
      heads.forEach((h, i) => h.classList.toggle('drop-target', i === toCol && toCol !== fromCol));
      const t = block.querySelector('.tb-time') || block.querySelector('.tb-title');
      if (t?.classList.contains('tb-time')) t.textContent = `${fmtTime(newStart)} – ${fmtTime(new Date(+newStart + duration))}`;
    };
    const auto = edgeScroller(scroll, place);
    const finish = () => {
      auto.stop();
      scroll.classList.remove('locked');
      heads.forEach((h) => h.classList.remove('drop-target'));
    };
    return {
      move(p) { point = p; auto.update(p.y); place(); },
      end(p) {
        point = p; place(); finish();
        if (+newStart === +ev.start) { emit('render'); return; }
        moveEvent(ev, newStart, new Date(+newStart + duration));
      },
      cancel() { finish(); emit('render'); },
    };
  });
}
