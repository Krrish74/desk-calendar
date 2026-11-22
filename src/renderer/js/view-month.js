// view-month.js: the Month view: 6 weeks × 7 days, like Google Calendar.
//
// Each week row is a CSS grid: row 1 holds the date numbers, the rows below are
// "lanes" of events. Multi-day / all-day events are filled bars that span columns;
// single-day timed events are "● 6pm Title" lines. When a day has more events than
// fit, its last visible lane becomes "+N more", which opens a popover with all of them.

const LANE_H = 22; // ← height of one event line in a month cell

function renderMonth() {
  const { start, monthStart } = viewRange();
  const now = new Date();
  const root = el('div', 'mgrid');

  // Weekday names across the top
  const head = el('div', 'mg-head');
  for (let i = 0; i < 7; i++) head.append(el('div', '', addDays(start, i).toLocaleDateString([], { weekday: 'short' })));
  root.append(head);

  // How many lanes fit in a cell? (6 rows share the view's height.)
  const viewH = $('view').clientHeight || 700;
  const rowH = (viewH - 32) / 6;
  const maxLanes = Math.max(1, Math.floor((rowH - 30) / LANE_H));

  for (let w = 0; w < 6; w++) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i));
    const weekEnd = addDays(days[0], 7);
    const row = el('div', 'mg-week');
    // Date row, event lanes, then a stretchy row so the cells fill the week's height.
    row.style.gridTemplateRows = `28px repeat(${maxLanes}, ${LANE_H}px) 1fr`;

    // Background cells (date numbers, today circle, other-month dimming)
    days.forEach((d, i) => {
      const cell = el('div', 'mg-cell');
      cell.dataset.date = ymd(d);
      cell.style.gridColumn = String(i + 1);
      if (d.getMonth() !== monthStart.getMonth()) cell.classList.add('other');
      const num = el('button', 'mg-num', d.getDate() === 1
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : String(d.getDate()));
      num.type = 'button';
      if (isToday(d)) num.classList.add('today');
      num.title = 'Open this day';
      num.onclick = (e) => { e.stopPropagation(); state.anchor = startOfDay(d); setView('day'); };
      cell.append(num);
      row.append(cell);
    });

    // Events in this week: spanning bars first, then single-day timed events.
    const inWeek = state.events.filter((e) => e.start < weekEnd && e.end > days[0]);
    const spans = inWeek.filter((e) => e.allDay || !sameDay(e.start, new Date(e.end - 1)));
    const singles = inWeek.filter((e) => !spans.includes(e));

    const placed = spanSegments(spans, days);             // lanes for bars (view-time.js)
    const laneUse = days.map(() => new Set());            // which lanes are taken per day
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

    // A day "overflows" if any of its items lands in a lane that doesn't fit. Then its
    // last lane is used for "+N more" instead, so it may show one item fewer.
    const covers = (it, c) => it.from <= c && it.to >= c;
    const overflowing = days.map((_, c) => items.some((it) => covers(it, c) && it.lane >= maxLanes));
    const laneLimit = (c) => (overflowing[c] ? maxLanes - 1 : maxLanes);
    // An item is drawn only if its lane fits on every day it covers. Hiding a multi-day
    // bar can make another day need "+N more" too, so repeat until nothing changes.
    let drawn;
    for (let pass = 0; pass < 7; pass++) {
      drawn = items.filter((it) => {
        for (let c = it.from; c <= it.to; c++) if (it.lane >= laneLimit(c)) return false;
        return true;
      });
      let changed = false;
      days.forEach((_, c) => {
        const hiddenHere = items.some((it) => covers(it, c) && !drawn.includes(it));
        if (hiddenHere && !overflowing[c]) { overflowing[c] = true; changed = true; }
      });
      if (!changed) break;
    }

    for (const it of drawn) {
      const node = it.kind === 'bar' ? eventChip(it.ev, 'bar') : monthLine(it.ev, now);
      node.style.gridColumn = `${it.from + 1} / ${it.to + 2}`;
      node.style.gridRow = String(it.lane + 2);
      if (it.ev.end <= now) node.classList.add('past');
      row.append(node);
    }

    days.forEach((d, c) => {
      const hidden = items.filter((it) => covers(it, c)).length - drawn.filter((it) => covers(it, c)).length;
      if (hidden <= 0) return;
      const all = state.events.filter((e) => e.start < addDays(d, 1) && e.end > d);
      const more = el('button', 'mg-more', `+${hidden} more`);
      more.type = 'button';
      more.style.gridColumn = String(c + 1);
      more.style.gridRow = String(maxLanes + 1);
      more.onclick = (e) => { e.stopPropagation(); showDayPopover(d, all, more); };
      row.append(more);
    });

    root.append(row);
  }

  // Clicking / dragging (interactions.js): drag events between days, click a day to create.
  attachDayGrid(root, (x, y) => {
    const hit = [...root.querySelectorAll('.mg-cell')].find((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
    return hit ? new Date(hit.dataset.date + 'T00:00') : null;
  }, (day) => {
    for (const c of root.querySelectorAll('.mg-cell')) c.classList.toggle('drop-target', !!day && c.dataset.date === ymd(day));
  });
  return root;
}

/** "● 6:00 PM Title" line for a timed event in a month cell. */
function monthLine(ev, now) {
  const line = el('div', 'mg-line');
  line.dataset.id = ev.id;
  line.dataset.cal = ev.calendarId;
  if (state.settleId === ev.id) line.classList.add('settle');
  const dot = el('span', 'dot');
  dot.style.background = ev.color;
  line.append(dot, el('span', 'mg-time', fmtTime(ev.start)), el('span', 'mg-title', ev.title));
  line.title = `${ev.title}\n${fmtTimeRange(ev)}${ev.location ? '\n' + ev.location : ''}`;
  line.onclick = (e) => { e.stopPropagation(); openDetails(ev, line); };
  return line;
}

/** "+N more" popover: every event on that day. */
function showDayPopover(day, events, anchorEl) {
  const pop = el('div', 'day-popover');
  const head = el('div', 'dp-head');
  head.append(
    el('span', 'dp-dow', day.toLocaleDateString([], { weekday: 'short' }).toUpperCase()),
    el('span', `dp-num${isToday(day) ? ' today' : ''}`, String(day.getDate())),
  );
  pop.append(head);
  const now = new Date();
  for (const ev of events.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start))) {
    const item = ev.allDay || !sameDay(ev.start, new Date(ev.end - 1)) ? eventChip(ev, 'bar') : monthLine(ev, now);
    if (ev.end <= now) item.classList.add('past');
    pop.append(item);
  }
  openPopover(pop, anchorEl);
}
