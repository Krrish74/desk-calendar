// view-time.js: the Day and Week views (an hour grid, like Google Calendar).
//
//   ┌ gutter ┬ SUN 22 ┬ MON 23 ┬ …            ← day headers (today highlighted)
//   ├────────┼────────┴────────┴──           ← all-day row: multi-day bars span columns
//   │  9 AM  │ ┌─────┐                       ← scrolling hour grid
//   │ 10 AM  │ │Class│ ┌───┬───┐             ← overlapping events sit side by side
//   │ ───────●━━━━━━━━━━━━━━━━━━━            ← red current-time line (today only)
//
// Layout math lives in layoutDay(): it's the same "cluster + columns" approach
// Google uses, so overlapping events share the width.

const HOUR_H = 48;        // ← pixels per hour (taller = roomier)
const MIN_BLOCK_H = 22;   // short events never get smaller than this

let lastTimeKey = '';     // view+range we last scrolled for (so refreshes don't jump)

function renderTimeGrid(days) {
  const { start } = viewRange();
  const dayList = Array.from({ length: days }, (_, i) => addDays(start, i));
  const now = new Date();

  // Timed events of 24 h or more go in the all-day row, like Google does.
  const isLong = (e) => e.allDay || e.end - e.start >= 24 * 3600 * 1000;
  const allDayEvents = state.events.filter(isLong);
  const timedEvents = state.events.filter((e) => !isLong(e));

  const root = el('div', 'tgrid');
  root.style.setProperty('--days', days);

  // --- Day headers ---------------------------------------------------------
  const head = el('div', 'tg-head');
  head.append(el('div', 'tg-gutter tz', tzLabel()));
  for (const d of dayList) {
    const h = el('button', 'tg-dayhead');
    h.type = 'button';
    if (isToday(d)) h.classList.add('today');
    if (d < startOfDay(now)) h.classList.add('past');
    h.append(
      el('span', 'dow', d.toLocaleDateString([], { weekday: 'short' })),
      el('span', 'num', String(d.getDate())),
    );
    h.title = 'Open this day';
    h.onclick = () => { state.anchor = startOfDay(d); setView('day'); };
    head.append(h);
  }

  // --- All-day row -------------------------------------------------------------
  const allDay = el('div', 'tg-allday');
  allDay.append(el('div', 'tg-gutter'));
  const lanes = el('div', 'tg-allday-lanes');
  for (const seg of spanSegments(allDayEvents, dayList)) {
    const bar = eventChip(seg.ev, 'bar');
    bar.style.gridColumn = `${seg.from + 1} / ${seg.to + 2}`;
    bar.style.gridRow = String(seg.lane + 1);
    if (seg.ev.end <= now) bar.classList.add('past');
    lanes.append(bar);
  }
  allDay.append(lanes);

  // --- Hour grid -------------------------------------------------------------
  const scroll = el('div', 'tg-scroll');
  const body = el('div', 'tg-body');
  body.style.height = `${24 * HOUR_H}px`;

  const hours = el('div', 'tg-gutter tg-hours');
  for (let h = 1; h < 24; h++) {
    const label = el('span', '', new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric', ...hourOpts() }));
    label.style.top = `${h * HOUR_H}px`;
    hours.append(label);
  }
  body.append(hours);

  for (const d of dayList) {
    const col = el('div', 'tg-col');
    if (isToday(d)) col.classList.add('today');
    const dayEnd = addDays(d, 1);
    const segs = timedEvents
      .filter((e) => e.start < dayEnd && e.end > d)
      .map((e) => ({
        ev: e,
        start: e.start < d ? d : e.start,       // clip events that cross midnight
        end: e.end > dayEnd ? dayEnd : e.end,
      }));
    for (const seg of layoutDay(segs)) col.append(timeBlock(seg, d, now));
    if (isToday(d)) col.append(nowLine());
    body.append(col);
  }
  scroll.append(body);
  root.append(head, allDay, scroll);

  // Clicking / dragging (interactions.js): the hour grid, and the all-day row by whole days.
  attachTimeGrid(root, dayList);
  const heads = [...head.querySelectorAll('.tg-dayhead')];
  attachDayGrid(allDay, (x) => {
    const i = heads.findIndex((h) => { const r = h.getBoundingClientRect(); return x >= r.left && x < r.right; });
    return i === -1 ? null : dayList[i];
  }, (day) => heads.forEach((h, i) => h.classList.toggle('drop-target', !!day && sameDay(dayList[i], day))));

  // Scroll so the morning (or the current time) is in view, but only when the
  // view or date changed: auto-refreshes keep your scroll position.
  const key = `${state.view}|${ymd(start)}`;
  const previous = $('view').querySelector('.tg-scroll')?.scrollTop;
  requestAnimationFrame(() => {
    // (No previous grid, e.g. coming back from Month, counts as a fresh view too.)
    if (key !== lastTimeKey || previous === undefined) {
      const target = dayList.some(isToday) ? now.getHours() - 1.5 : 7.5;
      scroll.scrollTop = Math.max(0, target) * HOUR_H;
      lastTimeKey = key;
    } else if (previous !== undefined) {
      scroll.scrollTop = previous;
    }
  });
  return root;
}

/**
 * Side-by-side layout for one day's timed events.
 * 1. Sort by start (longer first on ties).
 * 2. Split into clusters of events that (transitively) overlap.
 * 3. In each cluster put each event in the first column that's free at its start.
 * 4. Let each event stretch right over columns that are free for its whole time.
 * Returns segments with .left / .width as fractions of the column.
 */
function layoutDay(segs) {
  segs.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const out = [];
  let cluster = [];
  let clusterEnd = 0;
  const flush = () => {
    const columns = []; // each: last end time in that column
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
        const blocked = cluster.some((o) => o.col === c && o.start < s.end && o.end > s.start);
        if (blocked) break;
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

/** One filled event block in the hour grid. */
function timeBlock(seg, day, now) {
  const { ev } = seg;
  const startMin = wallMinutes(seg.start, day);
  const top = (startMin / 60) * HOUR_H;
  const height = Math.max(MIN_BLOCK_H, ((wallMinutes(seg.end, day) - startMin) / 60) * HOUR_H - 2);

  const b = el('div', 'tblock');
  b.dataset.id = ev.id;
  b.dataset.cal = ev.calendarId;
  if (state.settleId === ev.id) b.classList.add('settle');
  b.style.top = `${top}px`;
  b.style.height = `${height}px`;
  // Small inset so neighbours don't touch; the last column leaves room to click the grid.
  b.style.left = `calc(${seg.left * 100}% + 1px)`;
  b.style.width = `calc(${seg.width * 100}% - ${seg.left + seg.width >= 0.999 ? 8 : 3}px)`;
  paintEvent(b, ev);
  if (ev.end <= now) b.classList.add('past');
  if (!ev.canEdit) b.classList.add('readonly');

  const time = `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
  if (height < 38) {
    // Too short for two lines: "Title, 6:00 PM"
    const line = el('div', 'tb-title one-line');
    line.append(el('b', '', ev.title), `, ${fmtTime(ev.start)}`);
    b.append(line);
  } else {
    b.append(el('div', 'tb-title', ev.title), el('div', 'tb-time', time));
    if (ev.location && height >= 62) b.append(el('div', 'tb-loc', ev.location));
  }
  b.title = [ev.title, time, ev.location, ev.calendarName].filter(Boolean).join('\n');
  // Bottom-edge handle to change the length (only where the event really ends).
  if (ev.canEdit && +seg.end === +ev.end) b.append(el('div', 'tb-resize'));
  b.onclick = () => openDetails(ev, b);
  return b;
}

function nowLine() {
  const line = el('div', 'now-line');
  line.id = 'now-line';
  positionNowLine(line);
  return line;
}

/** Called every second from the countdown timer too, so the line creeps down. */
function positionNowLine(line = $('now-line')) {
  if (!line) return;
  const n = new Date();
  line.style.top = `${((n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60) / 60) * HOUR_H}px`;
}

/** "GMT-06" style label for the top-left corner. */
function tzLabel() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return `GMT${sign}${pad(h)}${m ? ':' + pad(m) : ''}`;
}

/**
 * Bars for events that span days (all-day and very long events), stacked in
 * lanes so they don't overlap. `days` is the list of visible day dates.
 * Returns { ev, from, to, lane } with from/to as column indexes.
 */
function spanSegments(events, days) {
  const first = days[0];
  const last = days[days.length - 1];
  const dayIndex = (d) => Math.round((startOfDay(d) - first) / 86400000);
  const segs = events
    .filter((e) => e.start < addDays(last, 1) && e.end > first)
    .map((e) => ({
      ev: e,
      from: Math.max(0, dayIndex(e.start)),
      // end is exclusive: an all-day event ending at midnight doesn't cover that day
      to: Math.min(days.length - 1, dayIndex(new Date(e.end - 1))),
    }))
    .sort((a, b) => (a.from - b.from) || ((b.to - b.from) - (a.to - a.from)));
  const laneEnds = []; // last column used in each lane
  for (const s of segs) {
    let lane = laneEnds.findIndex((end) => end < s.from);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(-1); }
    laneEnds[lane] = s.to;
    s.lane = lane;
  }
  return segs;
}

// --- Shared painting helpers (used by Month too) ------------------------------

/** Fill an element with the event's color and pick readable text for it. */
function paintEvent(node, ev) {
  node.style.background = ev.color;
  node.style.color = textOn(ev.color);
}

/** Dark text on light colors, white on dark ones. */
function textOn(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#10131a' : '#fff';
}

/** A filled chip/bar for all-day events (Week all-day row, Month, Agenda). */
function eventChip(ev, extraClass = '') {
  const c = el('div', `chip ${extraClass}`.trim(), ev.title);
  c.dataset.id = ev.id;
  c.dataset.cal = ev.calendarId;
  if (state.settleId === ev.id) c.classList.add('settle');
  if (!ev.canEdit) c.classList.add('readonly');
  paintEvent(c, ev);
  c.title = `${ev.title} · ${ev.calendarName}`;
  c.onclick = (e) => { e.stopPropagation(); openDetails(ev, c); };
  return c;
}
