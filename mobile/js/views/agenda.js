// views/agenda.js: the Agenda view (the default), like Google Calendar's "Schedule".
//
//   NOVEMBER
//   SUN 22 │ ▌Coffee with Sam          8:30 – 9:15 AM · Blue Bottle
//          │ ▌Design review   [Join]   10:00 – 10:45 AM · Work
//   MON 23 │ ▌Team standup …
//
// • Today is always shown (with "Nothing scheduled" if empty); other empty days are skipped.
// • Earlier events today fold into "N earlier events" (tap to show them).
// • Scrolling near the bottom loads more days automatically.
// • Google Tasks (tasks.js): "Today's tasks" sits at the top when today is in view;
//   every later day lists its tasks above its events.

import { el, icon, button, addDays, isToday, sameDay, fmtTimeRange, textOn, openUrl } from '../util.js';
import { state, viewRange, emit } from '../state.js';
import { openDetails } from '../details.js';
import { todayTasksCard, tasksForDay, taskRow } from '../tasks.js';

const MAX_AGENDA_DAYS = 84; // the Worker serves up to 100 days per request

let showEarlier = false;

export function renderAgenda() {
  const { start, end } = viewRange();
  const now = new Date();
  const list = el('div', 'agenda');
  let lastMonth = -1;
  // Today's tasks (with overdue ones rolled onto today) at the top.
  if (start <= now && end > now) list.append(todayTasksCard());

  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const dayEnd = addDays(d, 1);
    // An event belongs to a day if it overlaps it (so multi-day events show on each day).
    const items = state.events.filter((e) => e.start < dayEnd && e.end > d);
    const dayTasks = isToday(d) ? [] : tasksForDay(d); // today's are in the card above
    if (!items.length && !dayTasks.length && !isToday(d)) continue;

    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      const sameYear = d.getFullYear() === now.getFullYear();
      list.append(el('div', 'ag-month', d.toLocaleDateString([], { month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })));
    }

    const allDay = items.filter((e) => e.allDay || e.end - e.start >= 24 * 3600 * 1000);
    let timed = items.filter((e) => !allDay.includes(e));

    const section = el('section', 'ag-day');
    if (isToday(d)) section.classList.add('today');
    if (dayEnd <= now) section.classList.add('past');

    // Day label: "SUN" over a big "22". Tap → that day in Day view.
    const label = el('button', 'ag-label');
    label.type = 'button';
    label.append(el('span', 'ag-dow', d.toLocaleDateString([], { weekday: 'short' })), el('span', 'ag-num', String(d.getDate())));
    label.onclick = () => emit('goto', d, 'day');

    const body = el('div', 'ag-body');
    if (dayTasks.length) {
      const box = el('div', 'ag-tasks');
      for (const t of dayTasks) box.append(taskRow(t));
      body.append(box);
    }
    for (const ev of allDay) body.append(allDayRow(ev, d, now));

    // Today: events that already ended collapse into "N earlier events".
    if (isToday(d)) {
      const earlier = timed.filter((e) => e.end <= now);
      if (earlier.length && !showEarlier) {
        timed = timed.filter((e) => e.end > now);
        body.append(button('ag-earlier', [icon('chevron_down'), `${earlier.length} earlier event${earlier.length > 1 ? 's' : ''}`],
          () => { showEarlier = true; emit('render'); }));
      }
    }
    for (const ev of timed) body.append(eventRow(ev, d, now));
    if (!items.length && !dayTasks.length) body.append(el('div', 'empty', state.loading ? 'Loading…' : 'Nothing scheduled'));

    section.append(label, body);
    list.append(section);
  }

  // More days: automatic while scrolling, then a button once the range is long.
  const sentinel = el('div');
  if (state.agendaDays < MAX_AGENDA_DAYS) {
    sentinel.style.height = '1px';
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !state.loading) {
        io.disconnect();
        state.agendaDays = Math.min(MAX_AGENDA_DAYS, state.agendaDays + 14);
        emit('reload');
      }
    }, { root: document.getElementById('view'), rootMargin: '400px' });
    requestAnimationFrame(() => io.observe(sentinel));
    list.append(sentinel);
  } else {
    list.append(button('btn ag-more', 'Show later events', () => emit('goto', end, 'agenda')));
  }
  return list;
}

/** One timed event: colored edge · title · time · place/calendar · Join. */
function eventRow(ev, day, now) {
  const row = el('div', 'event');
  row.dataset.id = ev.id;
  row.dataset.cal = ev.calendarId;
  row.style.setProperty('--c', ev.color);
  if (ev.end <= now) row.classList.add('past');
  else if (ev.start <= now) row.classList.add('now');

  const what = el('div', 'what');
  what.append(el('div', 'name', ev.title));
  // Events that cross midnight show the part of the range that falls on this day.
  const when = sameDay(ev.start, ev.end) ? fmtTimeRange(ev)
    : sameDay(ev.start, day) ? `${fmtTimeRange(ev).split(' – ')[0]} – (next day)`
      : sameDay(ev.end, day) ? `until ${fmtTimeRange(ev).split(' – ')[1]}` : 'All day';
  what.append(el('div', 'when', when));
  const meta = [ev.location, ev.calendarName].filter(Boolean).join(' · ');
  if (meta) what.append(el('div', 'meta', meta));
  row.append(what);

  if (ev.meetLink && ev.end > now) {
    const join = button('btn join', [icon('video'), 'Join'], (e) => { e.stopPropagation(); openUrl(ev.meetLink); });
    row.append(join);
  }
  row.onclick = () => openDetails(ev);
  return row;
}

/** All-day (and 24 h+) events: a filled pill in the event's color. */
function allDayRow(ev, day, now) {
  const row = el('div', 'event allday');
  row.dataset.id = ev.id;
  row.dataset.cal = ev.calendarId;
  row.style.setProperty('--c', ev.color);
  row.style.setProperty('--fg', textOn(ev.color));
  if (ev.end <= now) row.classList.add('past');
  const what = el('div', 'what');
  const total = Math.round((ev.end - ev.start) / 86400000);
  const dayN = Math.floor((day - new Date(ev.start).setHours(0, 0, 0, 0)) / 86400000) + 1;
  what.append(el('div', 'name', total > 1 ? `${ev.title} (day ${dayN}/${total})` : ev.title));
  row.append(what);
  row.onclick = () => openDetails(ev);
  return row;
}

export const resetAgenda = () => { showEarlier = false; };
