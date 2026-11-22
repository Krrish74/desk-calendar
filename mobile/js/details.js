// details.js: the event details bottom sheet (tap any event).
//
//   ■ Design review
//     Tue, Nov 24 · 10:00 – 10:45 AM
//   [ Join meeting ]
//   📍 Room 4            (tap → Apple Maps)
//   🔔 10 minutes before
//   📅 Work
//   ≡  description…
//   [ Edit ] [ Delete ] [ Google ]
// Ported from openDetails() in src/renderer/js/interactions.js.

import { el, icon, button, whenText, htmlToText, linkify, openUrl } from './util.js';
import { openSheet, closeSheet } from './sheet.js';
import { openEditor, reminderLabel } from './editor.js';
import { deleteWithUndo } from './actions.js';
import { calendarById } from './state.js';

export function openDetails(ev) {
  const body = el('div');

  const head = el('div', 'dt-head');
  const swatch = el('span', 'dt-swatch');
  swatch.style.background = ev.color;
  const titles = el('div');
  titles.append(el('div', 'dt-title', ev.title), el('div', 'dt-when', whenText(ev)));
  head.append(swatch, titles);
  body.append(head);

  if (ev.meetLink && ev.end > new Date()) {
    let host = '';
    try { host = new URL(ev.meetLink).hostname; } catch { /* odd link: generic label */ }
    const join = button('btn primary block', [icon('video'), `Join ${host.includes('meet.google') ? 'Google Meet' : host.includes('zoom') ? 'Zoom' : 'meeting'}`],
      () => openUrl(ev.meetLink));
    body.append(join);
  }

  const row = (iconName, content) => {
    const r = el('div', 'dt-row');
    const text = el('div', 'dt-text');
    text.append(content);
    r.append(icon(iconName), text);
    body.append(r);
  };
  if (ev.location) {
    const a = el('a', '', ev.location);
    a.href = `https://maps.apple.com/?q=${encodeURIComponent(ev.location)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    row('location', a);
  }
  const reminders = remindersText(ev);
  if (reminders) row('alert', reminders);
  row('calendar_ltr', ev.calendarName + (ev.canEdit ? '' : ' (view only)'));
  const desc = htmlToText(ev.description);
  if (desc) row('text_description', linkify(desc));

  const actions = el('div', 'dt-actions');
  if (ev.canEdit) {
    actions.append(
      button('btn', [icon('edit'), 'Edit'], () => { closeSheet(true); openEditor(ev); }),
      button('btn danger', [icon('delete'), 'Delete'], () => { closeSheet(); deleteWithUndo(ev); }),
    );
  }
  actions.append(button('btn', [icon('open'), 'Google'], () => openUrl(ev.htmlLink)));
  if (!ev.canEdit) actions.style.gridTemplateColumns = '1fr';
  body.append(actions);

  openSheet({ title: '', body });
}

/** "10 minutes before, 1 hour before" (the event's own, or its calendar's defaults). */
function remindersText(ev) {
  const r = ev.reminders || { useDefault: true };
  const list = r.useDefault ? (calendarById(ev.calendarId)?.defaultReminders || []) : (r.overrides || []);
  return list.map((o) => reminderLabel(o.minutes)).join(', ');
}
