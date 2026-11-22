// sidebar.js: the left panel: countdown, Create, quick add, mini month, calendar lists,
// and the ☰ button that shows/hides the panel.

// ============================================================================
// Countdown (updates every second)
// ============================================================================

let renderedDay = new Date().toDateString(); // to notice when midnight passes

function tickCountdown() {
  positionNowLine(); // the red current-time line in Day/Week (view-time.js)

  // Past midnight? Re-fetch so "today" is right everywhere.
  if (new Date().toDateString() !== renderedDay) {
    renderedDay = new Date().toDateString();
    refreshScreen();
    return;
  }

  const now = new Date();
  const timed = state.soonEvents.filter((e) => !e.allDay);
  const current = timed.find((e) => e.start <= now && e.end > now);
  const next = timed.find((e) => e.start > now); // sorted by start

  // Something's happening now (and nothing starts within 5 min): count down to its end.
  const showNow = current && (!next || next.start - now > 5 * 60000);
  const ev = showNow ? current : next;

  const card = $('countdown');
  card.style.borderLeftColor = ev ? ev.color : '';
  $('cd-progress').hidden = !showNow;
  $('cd-location').hidden = !ev?.location;
  $('cd-join').hidden = !ev?.meetLink;

  if (!ev) {
    $('cd-label').textContent = 'Next';
    $('cd-title').textContent = 'Nothing else through tomorrow 🎉';
    $('cd-time').textContent = '';
    return;
  }

  if (showNow) {
    $('cd-label').textContent = 'Now';
    $('cd-time').textContent = `ends in ${duration(ev.end - now)}`;
    const done = (now - ev.start) / (ev.end - ev.start);
    $('cd-progress-bar').style.width = `${Math.min(100, done * 100).toFixed(1)}%`;
    $('cd-progress').style.color = ev.color;
  } else {
    const tomorrow = !isToday(ev.start) ? ' tomorrow' : '';
    $('cd-label').textContent = `Next · ${fmtTime(ev.start)}${tomorrow}`;
    $('cd-time').textContent = `in ${duration(ev.start - now)}`;
  }
  $('cd-title').textContent = ev.title;
  $('cd-location').querySelector('span').textContent = ev.location;
  $('cd-join').onclick = () => desk.openUrl(ev.meetLink);
  $('cd-title').onclick = () => openDetails(ev, $('countdown'));
}

// ============================================================================
// Create + quick add
// ============================================================================

$('btn-create').onclick = () => openEditor(null);

let previewTimer;
$('quick-input').addEventListener('input', () => {
  // Debounce: wait until you pause typing for 120 ms before parsing.
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 120);
});

async function updatePreview() {
  const text = $('quick-input').value;
  const p = $('quick-preview');
  p.replaceChildren();
  p.hidden = !text.trim();           // no text → no preview line → no gap
  if (p.hidden) return;
  const parsed = (await desk.parseQuick(text)).data;
  if (!parsed) {
    p.textContent = 'Add a day or time, e.g. "tomorrow 6pm"';
    p.classList.remove('ok');
    return;
  }
  // All-day results are 'YYYY-MM-DD'; T00:00 makes them local time.
  const start = new Date(parsed.allDay ? parsed.start + 'T00:00' : parsed.start);
  const end = new Date(parsed.allDay ? parsed.end + 'T00:00' : parsed.end);
  const when = parsed.allDay ? `${fmtDay(start)} (all day)` : `${fmtDay(start)}, ${fmtTime(start)} – ${fmtTime(end)}`;
  p.textContent = `↵ ${parsed.title} · ${when} · ${parsed.calendarName}`;
  if (parsed.tagUnmatched) p.append(el('span', 'warn', ` (no calendar matches #${parsed.calendarTag})`));
  p.classList.add('ok');
}

$('quick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('quick-input').value.trim();
  if (!text) return;
  try {
    const created = unwrap(await desk.quickAdd(text));
    $('quick-input').value = '';
    $('quick-preview').hidden = true;
    status(`Added “${created.title}” to ${created.calendarName}`);
    // Jump to the new event's day/week and flash it.
    state.highlightId = created.id;
    goToDate(new Date(created.start));
  } catch (err) { status(err.message, true); }
});

// ============================================================================
// Mini month (click a date to jump there)
// ============================================================================

let miniMonth = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
let miniFollowsAnchor = true; // ‹ › in the mini month browse freely until you navigate the main view

function renderMiniMonth() {
  if (miniFollowsAnchor) miniMonth = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
  miniFollowsAnchor = true;
  $('mm-label').textContent = miniMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const grid = $('mm-grid');
  grid.replaceChildren();
  const first = startOfWeek(miniMonth, state.weekStartsOn);
  for (let i = 0; i < 7; i++) {
    const dow = addDays(first, i).toLocaleDateString([], { weekday: 'narrow' });
    grid.append(el('div', 'mm-dow', dow));
  }
  const { start, end } = viewRange();
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i);
    const b = el('button', '', String(d.getDate()));
    b.type = 'button';
    b.title = d.toLocaleDateString([], { dateStyle: 'full' });
    if (d.getMonth() !== miniMonth.getMonth()) b.classList.add('other');
    if (d >= start && d < end && state.view !== 'month') b.classList.add('in-range');
    if (isToday(d)) b.classList.add('today');
    b.onclick = () => goToDate(d);
    grid.append(b);
  }
}

$('mm-prev').onclick = () => { miniMonth = addMonths(miniMonth, -1); miniFollowsAnchor = false; renderMiniMonth(); };
$('mm-next').onclick = () => { miniMonth = addMonths(miniMonth, 1); miniFollowsAnchor = false; renderMiniMonth(); };

// ============================================================================
// My calendars / Other calendars (tick to show, untick to hide)
// ============================================================================

function renderCalendarList() {
  const mine = state.calendars.filter((c) => c.canEdit);
  const other = state.calendars.filter((c) => !c.canEdit);
  $('cal-mine').replaceChildren(...mine.map(calendarRow));
  $('cal-other').replaceChildren(...other.map(calendarRow));
  $('cal-other-group').hidden = other.length === 0;
}

function calendarRow(cal) {
  const li = el('li');
  const label = el('label');
  const box = el('input', 'cal-check');
  box.type = 'checkbox';
  box.checked = cal.visible;
  box.style.setProperty('--cal', cal.color);
  box.onchange = async () => {
    cal.visible = box.checked;
    await desk.setCalendarVisible(cal.id, box.checked);
    loadEvents();
  };
  label.append(box, el('span', '', cal.name));
  label.title = cal.name;
  li.append(label);
  return li;
}

// ============================================================================
// Show / hide the sidebar (☰). Narrow windows (< 900 px) collapse it automatically
// and open it as an overlay instead.
// ============================================================================

const narrowQuery = matchMedia('(max-width: 899px)');
let sidebarPref = false; // collapsed? (saved preference for wide windows)

function applySidebar() {
  const narrow = narrowQuery.matches;
  document.body.classList.toggle('narrow', narrow);
  document.body.classList.toggle('sidebar-collapsed', narrow ? !sidebarOverlayOpen : sidebarPref);
}

let sidebarOverlayOpen = false;
$('btn-sidebar').onclick = () => {
  if (narrowQuery.matches) sidebarOverlayOpen = !sidebarOverlayOpen;
  else { sidebarPref = !sidebarPref; desk.setPrefs({ sidebarCollapsed: sidebarPref }); }
  applySidebar();
};
narrowQuery.addEventListener('change', () => { sidebarOverlayOpen = false; applySidebar(); });
// Clicking the calendar closes the overlay.
$('view').addEventListener('mousedown', () => {
  if (narrowQuery.matches && sidebarOverlayOpen) { sidebarOverlayOpen = false; applySidebar(); }
});
