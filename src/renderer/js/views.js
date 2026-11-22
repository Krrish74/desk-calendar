// views.js: the toolbar, choosing which view to draw, and the Agenda view.
// The Day/Week grid is in view-time.js, the Month grid in view-month.js.

function renderToolbar() {
  $('range-label').textContent = rangeLabel();
  for (const b of $('view-switch').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.view === state.view);
  }
}

$('view-switch').addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (view) setView(view);
});
$('btn-today').onclick = goToday;
$('btn-prev').onclick = () => step(-1);
$('btn-next').onclick = () => step(1);
$('btn-refresh').onclick = () => { loadCalendars(); loadEvents(); };

// ============================================================================
// Draw the current view
// ============================================================================

let lastDrawn = ''; // view + range: a change fades the new view in, a refresh doesn't
let deferredRender = false;

function renderView() {
  const key = `${state.view}|${ymd(viewRange().start)}`;
  deferredRender = false; // cleared first so closePopover() below can't call back in here
  if (key !== lastDrawn) closePopover();
  // Don't redraw under an open quick-create popover (you may be typing a title);
  // closePopover() calls us again when it closes.
  else if (openPop?.querySelector('.quick-create')) { deferredRender = true; return; }

  let content;
  if (state.view === 'day') content = renderTimeGrid(1);
  else if (state.view === 'week') content = renderTimeGrid(7);
  else if (state.view === 'month') content = renderMonth();
  else content = renderAgenda();

  if (key !== lastDrawn) content.classList.add('fade-in');
  lastDrawn = key;
  $('view').replaceChildren(content);
  flashHighlighted();
  state.settleId = null; // the "just dropped" bounce plays once
}

// Month cells depend on the window height: redraw when the window is resized.
let resizeTimer;
new ResizeObserver(() => {
  if (state.view !== 'month' || $('app').hidden) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderView, 120);
}).observe($('view'));

/** A just-created event: scroll to it and flash it once. */
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

// ============================================================================
// Agenda view (like Google's "Schedule")
// ============================================================================

let showEarlier = false; // "N earlier events" expanded?

function renderAgenda() {
  const { start, end } = viewRange();
  const now = new Date();
  const list = el('div', 'agenda');

  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const dayEnd = addDays(d, 1);
    // An event belongs to a day if it overlaps it (so multi-day events show on each day).
    const items = state.events.filter((e) => e.start < dayEnd && e.end > d);
    const allDay = items.filter((e) => e.allDay || e.end - e.start >= 24 * 3600 * 1000);
    let timed = items.filter((e) => !allDay.includes(e));

    const section = el('section', 'ag-day');
    if (isToday(d)) section.classList.add('today');
    if (dayEnd <= now) section.classList.add('past');

    // Sticky day label: big number + "NOV, SUN"
    const label = el('div', 'ag-label');
    label.append(
      el('span', 'ag-num', String(d.getDate())),
      el('span', 'ag-dow', `${d.toLocaleDateString([], { month: 'short' })}, ${d.toLocaleDateString([], { weekday: 'short' })}`),
    );
    label.title = 'Open this day';
    label.onclick = () => { state.anchor = startOfDay(d); setView('day'); };

    const body = el('div', 'ag-body');
    const dayTasks = agendaTasksFor(d); // tasks first, like Google Calendar
    if (dayTasks.length) body.append(agendaTaskList(dayTasks));
    if (allDay.length) {
      const chips = el('div', 'allday-chips');
      for (const ev of allDay) chips.append(eventChip(ev));
      body.append(chips);
    }

    // Today: events that already ended collapse into "N earlier events".
    if (isToday(d)) {
      const earlier = timed.filter((e) => e.end <= now);
      if (earlier.length && !showEarlier) {
        timed = timed.filter((e) => e.end > now);
        const more = el('button', 'ag-earlier', `${earlier.length} earlier event${earlier.length > 1 ? 's' : ''}`);
        more.prepend(icon('chevron_down'));
        more.onclick = () => { showEarlier = true; renderView(); };
        body.append(more);
      }
    }

    for (const ev of timed) body.append(agendaRow(ev, now));
    if (!items.length && !dayTasks.length) body.append(el('div', 'empty', 'Nothing scheduled'));

    section.append(label, body);
    list.append(section);
  }
  return list;
}

/** One agenda row: color dot · time · title (+ location · calendar) · Join. */
function agendaRow(ev, now) {
  const row = el('div', 'event');
  row.dataset.id = ev.id;
  row.dataset.cal = ev.calendarId;
  if (ev.end <= now) row.classList.add('past');
  else if (ev.start <= now) row.classList.add('now');

  const dot = el('span', 'dot');
  dot.style.background = ev.color;

  const what = el('div', 'what');
  what.append(el('div', 'name', ev.title));
  const meta = [ev.location, ev.calendarName].filter(Boolean).join(' · ');
  if (meta) what.append(el('div', 'meta', meta));

  const join = el('span');
  if (ev.meetLink && ev.end > now) {
    const b = el('button', 'btn subtle join-link');
    b.append(icon('video'), 'Join');
    b.onclick = (e) => { e.stopPropagation(); desk.openUrl(ev.meetLink); };
    join.append(b);
  }

  row.append(dot, el('span', 'when', fmtTimeRange(ev)), what, join);
  row.onclick = () => openDetails(ev, row);
  return row;
}
