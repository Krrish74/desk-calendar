// interactions.js: clicking and dragging in the calendar, Google-style.
//
//   • Click an event                → details popover (Edit · Delete · Open in Google · Close)
//   • Click / drag an empty slot    → quick-create popover ("More options" → full editor)
//   • Drag an event                 → move it to another time or day (snaps to 15 min)
//   • Drag an event's bottom edge   → change its length
//   • Delete                        → "Event deleted · Undo" toast for 6 seconds
//
// Moves are "optimistic": the screen updates right away, then Google is told. If
// Google refuses, the event jumps back and the error shows in the status bar.
// Read-only events (holidays, others' calendars) can be opened but not dragged.

const SNAP_MIN = 15;            // ← drag/resize snapping, in minutes
const DRAG_THRESHOLD = 4;       // px the mouse must move before a press becomes a drag

const snap = (min) => Math.round(min / SNAP_MIN) * SNAP_MIN;
const localStamp = (d) => `${ymd(d)}T${hm(d)}`; // sent to the backend as local time

/** The event an element belongs to (elements carry data-id + data-cal). */
function eventOf(node) {
  const n = node.closest('[data-id]');
  if (!n) return null;
  return state.events.find((e) => e.id === n.dataset.id && e.calendarId === n.dataset.cal) || null;
}

// After a real drag the browser still fires a click; swallow that one click.
let swallowClick = false;
document.addEventListener('click', (e) => {
  if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
}, true);

/** Track a press: calls onDrag(moveEvent) once it's a real drag, onEnd(moved, upEvent). */
function trackPointer(down, { onDrag, onEnd }) {
  const target = down.currentTarget;
  let moved = false;
  const move = (m) => {
    if (!moved && Math.hypot(m.clientX - down.clientX, m.clientY - down.clientY) < DRAG_THRESHOLD) return;
    if (!moved) {
      moved = true;
      // Capture only once it's a real drag: capturing on every press would send the
      // following click to the container instead of the event you clicked.
      target.setPointerCapture(m.pointerId);
      closePopover();
      document.body.classList.add('dragging');
    }
    onDrag(m);
  };
  const up = (u) => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    document.body.classList.remove('dragging');
    if (moved) {
      // Swallow the click the browser may fire right after this drop, but only that one:
      // if no click comes (e.g. the dragged element was redrawn), forget it.
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
    }
    onEnd(moved, u);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

// ============================================================================
// Day / Week grid
// ============================================================================

/** Called by renderTimeGrid() after it builds the grid. */
function attachTimeGrid(root, dayList) {
  const body = root.querySelector('.tg-body');
  const cols = [...body.querySelectorAll('.tg-col')];
  const colAt = (x) => {
    const i = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
    if (i !== -1) return i;
    return x < cols[0].getBoundingClientRect().left ? 0 : cols.length - 1;
  };
  const minuteAt = (y) => clamp(((y - cols[0].getBoundingClientRect().top) / HOUR_H) * 60, 0, 24 * 60);

  body.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    const block = down.target.closest('.tblock');
    if (block) return dragBlock(down, block);
    const col = down.target.closest('.tg-col');
    if (col) return dragCreate(down, cols.indexOf(col));
  });

  // --- Move / resize an existing event -------------------------------------
  function dragBlock(down, block) {
    const ev = eventOf(block);
    if (!ev || !ev.canEdit || block.classList.contains('ghost')) return; // click still opens details
    const resizing = down.target.classList.contains('tb-resize');
    const fromCol = cols.indexOf(block.parentElement);
    const top0 = parseFloat(block.style.top);
    const h0 = parseFloat(block.style.height);
    let newStart = ev.start, newEnd = ev.end;

    trackPointer(down, {
      onDrag(m) {
        block.classList.add('dragging');
        const dMin = snap(((m.clientY - down.clientY) / HOUR_H) * 60);
        if (resizing) {
          newEnd = new Date(Math.max(+ev.start + SNAP_MIN * 60000, +ev.end + dMin * 60000));
          block.style.height = `${Math.max(MIN_BLOCK_H, h0 + ((newEnd - ev.end) / 3600000) * HOUR_H)}px`;
        } else {
          const toCol = clamp(fromCol + colAt(m.clientX) - colAt(down.clientX), 0, cols.length - 1);
          const dDay = toCol - fromCol;
          newStart = new Date(+addDays(ev.start, dDay) + dMin * 60000);
          newEnd = new Date(+newStart + (ev.end - ev.start));
          if (block.parentElement !== cols[toCol]) cols[toCol].append(block);
          block.style.top = `${clamp(top0 + (dMin / 60) * HOUR_H, 0, 24 * HOUR_H - MIN_BLOCK_H)}px`;
          block.style.left = '1px';
          block.style.width = 'calc(100% - 8px)';
        }
        const t = block.querySelector('.tb-time');
        if (t) t.textContent = `${fmtTime(newStart)} – ${fmtTime(newEnd)}`;
      },
      onEnd(moved) {
        if (!moved) return; // a plain click: the block's onclick opens the details popover
        if (+newStart === +ev.start && +newEnd === +ev.end) { renderView(); return; }
        moveEvent(ev, newStart, newEnd, false);
      },
    });
  }

  // --- Click or drag on empty space: create --------------------------------
  function dragCreate(down, colIndex) {
    const day = dayList[colIndex];
    const m0 = Math.floor(minuteAt(down.clientY) / SNAP_MIN) * SNAP_MIN;
    const len = state.prefs.defaultEventMinutes; // Settings → Default event length
    let a = m0, b = m0 + len;
    const ghost = el('div', 'tblock ghost');
    ghost.append(el('div', 'tb-title', '(No title)'), el('div', 'tb-time', ''));
    const place = () => {
      ghost.style.top = `${(a / 60) * HOUR_H}px`;
      ghost.style.height = `${Math.max(MIN_BLOCK_H, ((b - a) / 60) * HOUR_H - 2)}px`;
      ghost.style.left = '1px';
      ghost.style.width = 'calc(100% - 8px)';
      ghost.querySelector('.tb-time').textContent = `${fmtTime(at(a))} – ${fmtTime(at(b))}`;
    };
    const at = (min) => new Date(+day + min * 60000);

    trackPointer(down, {
      onDrag(m) {
        const m1 = Math.ceil(minuteAt(m.clientY) / SNAP_MIN) * SNAP_MIN;
        a = Math.min(m0, m1); b = Math.max(m0 + SNAP_MIN, m1);
        if (m1 <= m0) { a = Math.floor(minuteAt(m.clientY) / SNAP_MIN) * SNAP_MIN; b = m0 + SNAP_MIN; }
        if (!ghost.isConnected) cols[colIndex].append(ghost);
        place();
      },
      onEnd(moved) {
        if (!moved) { a = m0; b = Math.min(24 * 60, m0 + len); }
        if (!ghost.isConnected) cols[colIndex].append(ghost);
        place();
        openQuickCreate({ start: at(a), end: at(b), allDay: false }, ghost, () => ghost.remove());
      },
    });
  }
}

// ============================================================================
// Day-based dragging: Week all-day row and Month grid
// ============================================================================

/**
 * `dayAt(x, y)` returns the Date under the pointer (or null).
 * Dragging a chip/line moves its event by whole days (times kept);
 * clicking empty space starts an all-day event on that day.
 */
function attachDayGrid(container, dayAt, highlight) {
  container.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    if (down.target.closest('.mg-num, .mg-more, .tg-dayhead')) return;
    const item = down.target.closest('.chip, .mg-line');
    const startDay = dayAt(down.clientX, down.clientY);
    if (!startDay) return;

    if (item) {
      const ev = eventOf(item);
      if (!ev || !ev.canEdit) return;
      let floater = null;
      let target = startDay;
      trackPointer(down, {
        onDrag(m) {
          if (!floater) {
            floater = item.cloneNode(true);
            floater.classList.add('drag-floater');
            floater.style.width = `${Math.min(item.offsetWidth, 260)}px`;
            document.body.append(floater);
            item.classList.add('drag-source');
          }
          floater.style.left = `${m.clientX + 8}px`;
          floater.style.top = `${m.clientY - 10}px`;
          target = dayAt(m.clientX, m.clientY) || target;
          highlight(target);
        },
        onEnd(moved) {
          floater?.remove();
          item.classList.remove('drag-source');
          highlight(null);
          if (!moved) return; // plain click: details popover via onclick
          const dDays = Math.round((startOfDay(target) - startOfDay(startDay)) / 86400000);
          if (dDays) moveEvent(ev, addDays(ev.start, dDays), addDays(ev.end, dDays), ev.allDay);
        },
      });
      return;
    }

    // Empty space: click to create an all-day event on that day.
    trackPointer(down, {
      onDrag() {},
      onEnd(moved, up) {
        if (moved) return;
        const day = dayAt(up.clientX, up.clientY);
        if (!day) return;
        highlight(day);
        const anchor = el('div', 'anchor-point');
        anchor.style.left = `${up.clientX}px`;
        anchor.style.top = `${up.clientY}px`;
        document.body.append(anchor);
        openQuickCreate({ start: startOfDay(day), end: addDays(startOfDay(day), 1), allDay: true }, anchor,
          () => { anchor.remove(); highlight(null); });
      },
    });
  });
}

// ============================================================================
// Saving a move
// ============================================================================

async function moveEvent(ev, start, end, allDay) {
  const before = { start: ev.start, end: ev.end };
  ev.start = start; ev.end = end;          // optimistic: show it moved right away
  state.settleId = ev.id;
  renderView();
  try {
    unwrap(await desk.updateEvent({
      calendarId: ev.calendarId,
      eventId: ev.id,
      allDay,
      // All-day: send dates, with "end" as the last day (inclusive).
      start: allDay ? ymd(start) : localStamp(start),
      end: allDay ? ymd(addDays(end, -1)) : localStamp(end),
    }));
    status(`Moved “${ev.title}” to ${fmtDay(start)}${allDay ? '' : ', ' + fmtTime(start)}`);
    loadEvents();
  } catch (err) {
    Object.assign(ev, before);             // put it back
    renderView();
    status(`Couldn't move “${ev.title}”: ${err.message}`, true);
  }
}

// ============================================================================
// Event details popover
// ============================================================================

function openDetails(ev, anchorEl) {
  const pop = el('div', 'details');

  const bar = el('div', 'dt-actions');
  const action = (iconName, title, fn) => {
    const b = el('button', 'icon');
    b.type = 'button';
    b.title = title;
    b.append(icon(iconName));
    b.onclick = fn;
    bar.append(b);
  };
  if (ev.canEdit) {
    action('edit', 'Edit', () => { closePopover(); openEditor(ev); });
    action('delete', 'Delete', () => { closePopover(); deleteWithUndo(ev); });
  }
  action('open', 'Open in Google Calendar', () => desk.openUrl(ev.htmlLink));
  action('dismiss', 'Close', closePopover);
  pop.append(bar);

  const head = el('div', 'dt-head');
  const swatch = el('span', 'dt-swatch');
  swatch.style.background = ev.color;
  const titles = el('div');
  titles.append(el('div', 'dt-title', ev.title), el('div', 'dt-when', whenText(ev)));
  head.append(swatch, titles);
  pop.append(head);

  if (ev.meetLink) {
    const row = el('div', 'dt-row');
    const join = el('button', 'btn primary');
    join.type = 'button';
    join.append(icon('video'), 'Join meeting');
    join.onclick = () => desk.openUrl(ev.meetLink);
    row.append(icon('video'), join);
    row.firstChild.classList.add('dt-ico');
    pop.append(row);
  }
  const detailRow = (iconName, text, cls = '') => {
    const row = el('div', `dt-row ${cls}`.trim());
    const i = icon(iconName);
    i.classList.add('dt-ico');
    row.append(i, el('div', 'dt-text', text));
    pop.append(row);
  };
  if (ev.location) detailRow('location', ev.location);
  const desc = htmlToText(ev.description);
  if (desc) detailRow('text_description', desc, 'dt-desc');
  detailRow('calendar_ltr', ev.calendarName + (ev.canEdit ? '' : ' (view only)'));

  openPopover(pop, anchorEl);
}

/** "Monday, November 23 · 10:00 – 11:30 AM" (or the date range for all-day events). */
function whenText(ev) {
  const long = (d) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (ev.allDay) {
    const last = addDays(ev.end, -1);
    return sameDay(ev.start, last) ? long(ev.start) : `${long(ev.start)} – ${long(last)}`;
  }
  if (sameDay(ev.start, new Date(ev.end - 1))) return `${long(ev.start)} · ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
  return `${long(ev.start)}, ${fmtTime(ev.start)} – ${long(ev.end)}, ${fmtTime(ev.end)}`;
}

/** Google descriptions may contain HTML. Turn it into plain text (never inserted as HTML). */
function htmlToText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
  return doc.body.textContent.trim();
}

// ============================================================================
// Quick-create popover
// ============================================================================

function openQuickCreate({ start, end, allDay }, anchorEl, onClose) {
  const pop = el('form', 'quick-create');
  pop.autocomplete = 'off';

  const title = el('input', 'qc-title');
  title.placeholder = 'Add title';

  const when = el('div', 'dt-row');
  const clockIcon = icon('clock');
  clockIcon.classList.add('dt-ico');
  when.append(clockIcon, el('div', 'dt-text', whenText({ start, end, allDay })));

  const calRow = el('div', 'dt-row');
  const calIcon = icon('calendar_ltr');
  calIcon.classList.add('dt-ico');
  const sel = el('select');
  for (const c of state.calendars.filter((x) => x.canEdit)) {
    const o = el('option', '', c.name);
    o.value = c.id;
    sel.append(o);
  }
  sel.value = defaultCalendarId();
  calRow.append(calIcon, sel);

  const buttons = el('div', 'dialog-buttons');
  const more = el('button', 'btn subtle', 'More options');
  more.type = 'button';
  const save = el('button', 'btn primary', 'Save');
  save.type = 'submit';
  buttons.append(el('span', 'spacer'), more, save);

  pop.append(title, when, calRow, buttons);

  more.onclick = () => {
    closePopover();
    openEditor(null, { title: title.value.trim(), start, end, allDay, calendarId: sel.value });
  };
  pop.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const created = unwrap(await desk.createEvent({
        calendarId: sel.value,
        title: title.value.trim() || '(No title)',
        allDay,
        start: allDay ? ymd(start) : localStamp(start),
        end: allDay ? ymd(addDays(end, -1)) : localStamp(end),
      }));
      closePopover();
      state.highlightId = created.id;
      status(`Created “${created.title}”`);
      loadEvents();
    } catch (err) {
      save.disabled = false;
      status(err.message, true);
    }
  };

  openPopover(pop, anchorEl, { onClose, side: true });
  title.focus();
}

// ============================================================================
// Delete with Undo
// ============================================================================

async function deleteWithUndo(ev) {
  let token;
  try {
    token = unwrap(await desk.deleteLater({ calendarId: ev.calendarId, eventId: ev.id }));
  } catch (err) { status(err.message, true); return; }

  const same = (e) => e.id === ev.id && e.calendarId === ev.calendarId;
  state.events = state.events.filter((e) => !same(e));
  state.soonEvents = state.soonEvents.filter((e) => !same(e));
  renderView();
  tickCountdown();

  showToast(`Event deleted`, 'Undo', async () => {
    const undone = unwrap(await desk.undoDelete(token));
    status(undone ? `Restored “${ev.title}”` : 'Too late to undo: it was already deleted.', !undone);
    loadEvents();
  });
}

// ============================================================================
// Toast (bottom-center message with an action button)
// ============================================================================

let toastTimer;

function showToast(text, actionLabel, onAction, ms = 6000) {
  $('toast')?.remove();
  clearTimeout(toastTimer);
  const t = el('div', 'toast');
  t.id = 'toast';
  t.append(el('span', '', text));
  if (actionLabel) {
    const b = el('button', 'btn subtle', actionLabel);
    b.type = 'button';
    b.onclick = () => { t.remove(); onAction(); };
    t.append(b);
  }
  const x = el('button', 'icon small');
  x.type = 'button';
  x.title = 'Dismiss';
  x.append(icon('dismiss'));
  x.onclick = () => t.remove();
  t.append(x);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), ms);
}
