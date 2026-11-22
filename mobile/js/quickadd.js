// quickadd.js: the "+" button. Type "gym tomorrow 6pm #fitness" and tap Add.
//
// While you type (after a short pause) the Worker parses the text with the same
// chrono-node rules as the desktop app and the preview shows what will be created:
//   Gym · Mon, Nov 23, 6:00 – 7:00 PM · ■ Fitness
// "#name" picks a calendar by name. "More options" opens the full editor pre-filled.

import { el, button, fmtDay, fmtTime, fromYmd } from './util.js';
import { openSheet, closeSheet } from './sheet.js';
import { openEditor } from './editor.js';
import { api } from './api.js';
import { state, emit, status, clearCache } from './state.js';

export function openQuickAdd() {
  const form = el('form');
  const inputBox = el('input', 'qa-input');
  inputBox.type = 'text';
  inputBox.placeholder = 'e.g. gym tomorrow 6pm #fitness';
  inputBox.autocomplete = 'off';
  inputBox.enterKeyHint = 'done';
  inputBox.setAttribute('autocapitalize', 'sentences');
  const preview = el('div', 'qa-preview');
  const hint = el('div', 'qa-hint', 'Say what and when: "lunch with Sam friday 12:30-2pm", "dentist dec 3 at 9", "mom\'s birthday saturday" (all day). Add "for 30 min" for a length, "#work" for a calendar.');
  const add = button('btn primary', 'Add');
  add.type = 'submit';
  add.disabled = true;
  const more = button('btn', 'More options', () => {
    const p = parsed;
    closeSheet(true);
    openEditor(null, p ? {
      title: p.title,
      allDay: p.allDay,
      start: p.allDay ? fromYmd(p.start) : new Date(p.start),
      end: p.allDay ? addOneDay(fromYmd(p.end)) : new Date(p.end),
      calendarId: p.calendarId,
    } : { title: inputBox.value.trim() });
  });
  const buttons = el('div', 'qa-buttons');
  buttons.append(more, add);
  form.append(inputBox, preview, hint, buttons);

  let parsed = null;
  let timer;
  let seq = 0;
  inputBox.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(updatePreview, 250); // wait until you pause typing
  });

  async function updatePreview() {
    const text = inputBox.value.trim();
    const mine = ++seq;
    preview.replaceChildren();
    preview.classList.remove('ok');
    parsed = null;
    add.disabled = true;
    if (!text) return;
    try {
      const p = await api.parseQuick(text);
      if (mine !== seq) return;
      if (!p) { preview.textContent = 'Add a day or time, e.g. "tomorrow 6pm"'; return; }
      parsed = p;
      const start = p.allDay ? fromYmd(p.start) : new Date(p.start);
      const end = p.allDay ? fromYmd(p.end) : new Date(p.end);
      const when = p.allDay
        ? (p.start === p.end ? `${fmtDay(start)} · all day` : `${fmtDay(start)} – ${fmtDay(end)} · all day`)
        : `${fmtDay(start)}, ${fmtTime(start)} – ${fmtTime(end)}`;
      const cal = el('span', 'qa-cal', p.calendarName);
      cal.style.setProperty('--c', p.calendarColor || '');
      preview.append(el('b', '', p.title), ` · ${when} · `, cal);
      if (p.tagUnmatched) preview.append(el('div', 'warn', `No calendar matches #${p.calendarTag}, so it goes to ${p.calendarName}.`));
      preview.classList.add('ok');
      add.disabled = false;
    } catch (err) {
      if (mine === seq) preview.textContent = err.message;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(timer);
    if (!parsed) await updatePreview();
    if (!parsed) return;
    add.disabled = true;
    try {
      const created = await api.quickAdd(inputBox.value.trim());
      closeSheet();
      clearCache();
      status(`Added “${created.title}” to ${created.calendarName}`);
      // Jump to the new event's day and flash it.
      state.highlightId = created.id;
      emit('goto', new Date(created.start));
    } catch (err) {
      status(err.message, true);
      add.disabled = false;
    }
  });

  openSheet({ title: 'Quick add', body: form });
  // Focus right away, still inside the tap: iPhone only opens the keyboard for focus()
  // calls made during a tap, not ones made later from a timer.
  inputBox.focus({ preventScroll: true });
}

const addOneDay = (d) => { const x = new Date(d); x.setDate(x.getDate() + 1); return x; };
