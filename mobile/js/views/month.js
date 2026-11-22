// views/month.js: the Month view: 6 weeks × 7 days (ported from src/renderer/js/view-month.js).
//
// Each week row is a CSS grid: row 1 holds the date numbers, the rows below are
// "lanes" of events. Multi-day / all-day events are filled bars that span columns;
// single-day timed events are "● Title" lines. When a day has more than fits, its last
// lane says "+N".
//
// Touch (cells are small on a phone, so the whole cell is the target):
//   tap a day                      → that day in Day view
//   long-press an event, drag it   → move it to another day (time of day is kept)

import { el, addDays, isToday, sameDay, ymd, fromYmd, paintEvent } from '../util.js';
import { state, viewRange, emit, status } from '../state.js';
import { spanSegments } from './timegrid.js';
import { moveEvent } from '../actions.js';
import { onLongPress } from '../touch.js';

const LANE_H = 16; // ← height of one event line in a cell

export function renderMonth(viewEl) {
  const { start, monthStart } = viewRange();
  const now = new Date();
  const root = el('div', 'mgrid');

  const head = el('div', 'mg-head');
  for (let i = 0; i < 7; i++) head.append(el('div', '', addDays(start, i).toLocaleDateString([], { weekday: 'narrow' })));
  root.append(head);

  // How many lanes fit in a cell? (6 rows share the view's height.)
  const viewH = viewEl.clientHeight || 600;
  const rowH = (viewH - 26) / 6;
  const maxLanes = Math.max(1, Math.floor((rowH - 30) / (LANE_H + 1)));

  for (let w = 0; w < 6; w++) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i));
    const weekEnd = addDays(days[0], 7);
    const row = el('div', 'mg-week');
    row.style.gridTemplateRows = `28px repeat(${maxLanes}, ${LANE_H}px) 1fr`;

    days.forEach((d, i) => {
      const cell = el('div', 'mg-cell');
      cell.dataset.date = ymd(d);
      cell.style.gridColumn = String(i + 1);
      if (d.getMonth() !== monthStart.getMonth()) cell.classList.add('other');
      const num = el('span', 'mg-num', String(d.getDate()));
      if (isToday(d)) num.classList.add('today');
      cell.append(num);
      row.append(cell);
    });

    // Events in this week: spanning bars first, then single-day timed events.
    const inWeek = state.events.filter((e) => e.start < weekEnd && e.end > days[0]);
    const spans = inWeek.filter((e) => e.allDay || !sameDay(e.start, new Date(e.end - 1)));
    const singles = inWeek.filter((e) => !spans.includes(e));

    const placed = spanSegments(spans, days);
    const laneUse = days.map(() => new Set());
    for (const s of placed) for (let c = s.from; c <= s.to; c++) laneUse[c].add(s.lane);
    const items = placed.map((s) => ({ ...s, kind: 'bar' }));
    for (const ev of singles.sort((a, b) => a.start - b.start)) {
      const c = days.findIndex((d) => sameDay(d, ev.start));
      if (c === -1) continue;
      let lane = 0;
      while (laneUse[c].has(lane)) lane++;
      laneUse[c].add(lane);
      items.push({ ev, from: c, to: c, lane, kind: 'line' });
    }

    // A day that doesn't fit everything shows "+N" in its last lane (same rule as desktop).
    const covers = (it, c) => it.from <= c && it.to >= c;
    const overflowing = days.map((_, c) => items.some((it) => covers(it, c) && it.lane >= maxLanes));
    const laneLimit = (c) => (overflowing[c] ? maxLanes - 1 : maxLanes);
    let drawn;
    for (let pass = 0; pass < 7; pass++) {
      drawn = items.filter((it) => { for (let c = it.from; c <= it.to; c++) if (it.lane >= laneLimit(c)) return false; return true; });
      let changed = false;
      days.forEach((_, c) => {
        if (items.some((it) => covers(it, c) && !drawn.includes(it)) && !overflowing[c]) { overflowing[c] = true; changed = true; }
      });
      if (!changed) break;
    }

    for (const it of drawn) {
      const node = it.kind === 'bar' ? bar(it.ev) : line(it.ev);
      node.dataset.id = it.ev.id;
      node.dataset.cal = it.ev.calendarId;
      node.style.gridColumn = `${it.from + 1} / ${it.to + 2}`;
      node.style.gridRow = String(it.lane + 2);
      if (it.ev.end <= now) node.classList.add('past');
      if (state.settleId === it.ev.id) node.classList.add('settle');
      row.append(node);
    }
    days.forEach((d, c) => {
      const hidden = items.filter((it) => covers(it, c)).length - drawn.filter((it) => covers(it, c)).length;
      if (hidden <= 0) return;
      const more = el('div', 'mg-more', `+${hidden}`);
      more.style.gridColumn = String(c + 1);
      more.style.gridRow = String(maxLanes + 1);
      row.append(more);
    });
    root.append(row);
  }

  const cellAt = (x, y) => [...root.querySelectorAll('.mg-cell')].find((c) => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  });

  // Tap a day → Day view.
  root.addEventListener('click', (e) => {
    const cell = cellAt(e.clientX, e.clientY);
    if (cell) emit('goto', fromYmd(cell.dataset.date), 'day');
  });

  // Long-press an event → drag it to another day.
  onLongPress(root, (origin) => {
    // Event lines don't take taps themselves (the whole cell does), so find the one under the finger.
    const hit = [...root.querySelectorAll('[data-id]')].find((n) => {
      const r = n.getBoundingClientRect();
      return origin.x >= r.left && origin.x < r.right && origin.y >= r.top - 2 && origin.y < r.bottom + 2;
    });
    if (!hit) return null;
    const ev = state.events.find((e) => e.id === hit.dataset.id && e.calendarId === hit.dataset.cal);
    if (!ev) return null;
    if (!ev.canEdit) { status(`“${ev.calendarName}” is view-only.`, true); return null; }
    const fromCell = cellAt(origin.x, origin.y);
    if (!fromCell) return null;

    const floater = el('div', 'drag-floater', ev.title);
    paintEvent(floater, ev);
    document.body.append(floater);
    const sources = root.querySelectorAll(`[data-id="${CSS.escape(ev.id)}"]`);
    sources.forEach((n) => { n.style.opacity = '.35'; });
    let target = fromCell;
    const place = (p) => {
      floater.style.left = `${p.x - 30}px`;
      floater.style.top = `${p.y - 40}px`;
      target = cellAt(p.x, p.y) || target;
      for (const c of root.querySelectorAll('.mg-cell')) c.classList.toggle('drop-target', c === target);
    };
    place(origin);
    const finish = () => {
      floater.remove();
      sources.forEach((n) => { n.style.opacity = ''; });
      for (const c of root.querySelectorAll('.mg-cell')) c.classList.remove('drop-target');
    };
    return {
      move: place,
      end(p) {
        place(p); finish();
        const days = Math.round((fromYmd(target.dataset.date) - fromYmd(fromCell.dataset.date)) / 86400000);
        if (!days) return;
        moveEvent(ev, addDays(ev.start, days), addDays(ev.end, days));
      },
      cancel: finish,
    };
  });
  return root;
}

function bar(ev) {
  const c = el('div', 'chip', ev.title);
  paintEvent(c, ev);
  return c;
}

function line(ev) {
  const l = el('div', 'mg-line');
  const dot = el('span', 'dot');
  dot.style.background = ev.color;
  l.append(dot, el('span', 'mg-title', ev.title));
  return l;
}
