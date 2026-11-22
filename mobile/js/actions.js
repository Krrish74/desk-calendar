// actions.js: changes made from the calendar itself: moving an event (after a
// long-press drag) and deleting with Undo. Ported from src/renderer/js/interactions.js.
//
// Moves are "optimistic": the screen updates right away, then the Worker tells Google.
// If Google refuses, the event jumps back and the error shows.
// Deletes don't ask first: the event disappears, and a toast offers "Undo" for 6 seconds
// (the Worker waits that long before really deleting it).

import { api } from './api.js';
import { state, emit, status, clearCache } from './state.js';
import { showToast } from './sheet.js';
import { ymd, addDays, fmtDay, fmtTime } from './util.js';

/** Move `ev` to [start, end). For all-day events, start/end are local midnights. */
export async function moveEvent(ev, start, end) {
  const before = { start: ev.start, end: ev.end };
  ev.start = start; ev.end = end;
  state.settleId = ev.id;
  emit('render');
  try {
    await api.updateEvent({
      calendarId: ev.calendarId,
      eventId: ev.id,
      allDay: ev.allDay,
      // All-day: dates, with "end" as the last day (inclusive). Timed: exact instants.
      start: ev.allDay ? ymd(start) : start.toISOString(),
      end: ev.allDay ? ymd(addDays(end, -1)) : end.toISOString(),
    });
    status(`Moved to ${fmtDay(start)}${ev.allDay ? '' : `, ${fmtTime(start)}`}`);
    clearCache();
    emit('reload');
  } catch (err) {
    Object.assign(ev, before); // put it back
    emit('render');
    status(`Couldn't move “${ev.title}”: ${err.message}`, true);
  }
}

/** Delete with an "Undo" toast. */
export async function deleteWithUndo(ev) {
  let token;
  try {
    ({ token } = await api.deleteLater(ev.calendarId, ev.id));
  } catch (err) { status(err.message, true); return; }

  const same = (e) => e.id === ev.id && e.calendarId === ev.calendarId;
  state.events = state.events.filter((e) => !same(e));
  state.soonEvents = state.soonEvents.filter((e) => !same(e));
  clearCache();
  emit('render');
  emit('countdown');

  showToast('Event deleted', 'Undo', async () => {
    try {
      const { restored } = await api.undoDelete(token);
      status(restored ? `Restored “${ev.title}”` : 'Too late to undo: it was already deleted.', !restored);
    } catch (err) { status(err.message, true); }
    emit('reload');
  });
}
