// chat.js: the Assistant, as a full-height bottom sheet (ported from src/renderer/js/chat.js).
//
// Claude runs on the Worker (the API key never reaches the phone). Replies may use
// **bold** and "- " bullet lists; they're turned into elements safely (never inserted
// as HTML). When the assistant changes your calendar, small cards appear under its
// reply; tap one to jump to that event. Deletes happen without asking, with the same
// "Undo" toast as deleting by hand.
//
// The conversation stays on screen while the app is open; the Worker keeps its own
// copy (see worker/src/assistant.js) so Claude remembers context between messages.

import { el, icon, button, fmtDay, fmtTime, fromYmd } from './util.js';
import { openSheet, closeSheet, showToast } from './sheet.js';
import { api } from './api.js';
import { state, emit, status, clearCache } from './state.js';

const SUGGESTIONS = ["What's tomorrow?", 'Plan my tasks for this week', 'Find 2 hours for deep work tomorrow', 'Summarize my week'];

const log = el('div');           // kept between openings
log.id = 'chat-log';
let busy = false;

/** Open the assistant. { prefill } puts text in the box ("Schedule with assistant" on a task). */
export function openAssistant({ prefill = '' } = {}) {
  const modelPill = el('span', 'model-pill', modelName(state.prefs.assistantModel));
  const reset = button('icon', [icon('history')], async () => {
    try { await api.chatReset(); } catch (err) { status(err.message, true); }
    log.replaceChildren();
    welcome();
  });
  reset.setAttribute('aria-label', 'New chat');

  const form = el('form');
  form.id = 'chat-form';
  const input = el('textarea');
  input.id = 'chat-input';
  input.rows = 1;
  input.placeholder = 'Ask about your calendar…';
  input.enterKeyHint = 'send';
  const send = button('icon', [icon('send-filled')]);
  send.id = 'chat-send';
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send');
  form.append(input, send);
  // Grow the box with its text (up to max-height in CSS).
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
  // Return sends (iPhone "send" key); Shift+Return adds a line on a hardware keyboard.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); sendChat(input.value, input); });

  const title = el('span');
  title.append(el('span', '', 'Assistant '), modelPill);
  const sheet = openSheet({ title, body: log, foot: form, full: true, actions: [reset] });
  if (!log.children.length) welcome();
  scrollDown(sheet.body);
  if (prefill) {
    input.value = prefill;
    input.dispatchEvent(new Event('input'));
    input.focus({ preventScroll: true }); // still inside the tap, so iPhone shows the keyboard
  }
}

/** Forget the conversation on screen (the Worker started a new one, e.g. after a profile change). */
export function clearChatLog() { log.replaceChildren(); }

const modelName = (id) => ({ 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' })[id] || id;

function welcome() {
  if (state.me && !state.me.assistantReady) {
    addMsg('bot', "The assistant isn't set up yet: the Claude API key hasn't been added to the Worker (ANTHROPIC_API_KEY). See SETUP-IPHONE.md.");
    return;
  }
  addMsg('bot', 'Hi! I can add, move or delete events and tasks, plan your tasks into time blocks, and answer questions about your schedule.');
  const chips = el('div', 'chips');
  chips.id = 'chat-chips';
  for (const s of SUGGESTIONS) chips.append(button('chip-suggest', s, () => sendChat(s, document.getElementById('chat-input'))));
  log.append(chips);
}

function addMsg(who, text, extra = '') {
  const m = el('div', `msg ${who} ${extra}`.trim());
  if (who === 'bot' && !extra) m.append(...richText(text));
  else m.textContent = text;
  log.append(m);
  scrollDown();
  return m;
}

const scrollDown = (box = log.parentElement) => { if (box) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; }); };

/** Minimal, safe formatting: paragraphs, "- " bullets, **bold**. Built from text nodes. */
function richText(text) {
  const out = [];
  let list = null;
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (!list) { list = el('ul'); out.push(list); }
      const li = el('li');
      li.append(...inline(bullet[1]));
      list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const p = el('p');
    p.append(...inline(line));
    out.push(p);
  }
  return out;
}

const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
  .map((part) => (part.startsWith('**') && part.endsWith('**') ? el('b', '', part.slice(2, -2)) : document.createTextNode(part)));

/** "✓ Created Gym · Tue, Nov 24, 6:00 – 7:00 PM": tap to jump to it. */
function actionCard(a) {
  const verb = {
    created: 'Created', updated: 'Updated', deleted: 'Deleted',
    'task-created': 'Added task', 'task-updated': 'Updated task', 'task-completed': 'Completed', 'task-reopened': 'Reopened',
  }[a.kind] || 'Changed';
  const isTask = a.kind.startsWith('task-') || a.isTask;
  const text = el('span', 'ac-text');
  text.append(el('b', '', `${verb} ${a.title}`));
  if (isTask && a.due) {
    text.append(el('span', 'ac-when', `Due ${fmtDay(fromYmd(a.due))}`));
  } else if (a.start) {
    const s = new Date(a.start), e = new Date(a.end);
    text.append(el('span', 'ac-when', a.allDay ? fmtDay(s) : `${fmtDay(s)}, ${fmtTime(s)} – ${fmtTime(e)}`));
  }
  const ico = a.kind === 'deleted' ? 'delete' : a.kind === 'task-completed' ? 'checkmark_circle' : isTask ? 'task_list_ltr' : 'checkmark';
  const card = button(`action-card ${a.kind}`, [icon(ico), text]);
  if (a.kind === 'deleted') card.disabled = true;
  else if (isTask) card.onclick = () => { closeSheet(); emit('goto', new Date(), 'agenda'); }; // tasks live in the Agenda
  else card.onclick = () => { closeSheet(); state.highlightId = a.id; emit('goto', new Date(a.start)); };
  return card;
}

async function sendChat(text, input) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  document.getElementById('chat-chips')?.remove();
  if (input) { input.value = ''; input.style.height = 'auto'; }
  addMsg('user', text);
  const pending = addMsg('bot', 'Thinking…', 'thinking');
  try {
    const { reply, actions, freshStart, undoMs } = await api.chat(text);
    if (freshStart) {
      // The Worker started a new conversation (a long pause or a long chat), so earlier
      // messages are no longer remembered. Say so where it happened.
      pending.before(el('div', 'chat-divider', 'New conversation: earlier messages are not remembered'));
    }
    pending.className = 'msg bot';
    pending.replaceChildren(...richText(reply));
    if (actions?.length) {
      const cards = el('div', 'action-cards');
      for (const a of actions) cards.append(actionCard(a));
      log.append(cards);
      clearCache();
      emit('reload');
      offerUndo(actions.filter((a) => a.kind === 'deleted' && a.token), cards, undoMs);
    }
  } catch (err) {
    pending.textContent = err.message;
    pending.className = 'msg bot error';
  } finally {
    busy = false;
    scrollDown();
  }
}

/** Assistant deletes get the same "Undo" toast as deleting by hand. */
function offerUndo(deleted, cards, ms) {
  if (!deleted.length) return;
  const label = deleted.length === 1 ? `Deleted “${deleted[0].title}”` : `Deleted ${deleted.length} items`;
  // The toast stays up as long as the server's Undo window (a little less, to be safe).
  showToast(label, 'Undo', async () => {
    let restored = 0;
    for (const a of deleted) {
      try { if ((await api.undoDelete(a.token)).restored) restored++; } catch { /* counted as not restored */ }
    }
    status(restored ? `Restored ${restored === 1 ? `“${deleted[0].title}”` : `${restored} events`}` : 'Too late to undo.', !restored);
    if (restored) {
      for (const card of cards.querySelectorAll('.action-card.deleted')) {
        card.classList.replace('deleted', 'restored');
        card.querySelector('b').textContent = card.querySelector('b').textContent.replace(/^Deleted/, 'Restored');
        card.querySelector('.ico').className = 'ico i-arrow_undo';
      }
    }
    emit('reload');
  }, Math.max(6000, (Number(ms) || 6000) - 1000));
}
