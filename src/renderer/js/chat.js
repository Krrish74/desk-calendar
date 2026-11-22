// chat.js: the Assistant side panel.
//
// The panel slides in from the right (CSS class "open") and the calendar shrinks to
// make room, like Google Calendar's side panel. Replies may use **bold** and "- "
// bullet lists; they're turned into elements safely (never inserted as HTML).
// When the assistant changes your calendar, small cards appear under its reply;
// click one to jump to that event.

const SUGGESTIONS = ["What's tomorrow?", 'Plan my tasks for this week', 'Find 2 hours for deep work tomorrow', 'Summarize my week'];

function toggleChat(open = !$('chat').classList.contains('open')) {
  $('chat').classList.toggle('open', open);
  $('btn-chat').classList.toggle('active', open);
  $('btn-chat').querySelector('.ico').className = `ico ${open ? 'i-chat-filled' : 'i-chat'}`;
  if (open) {
    if (!$('chat-log').children.length) showWelcome();
    setTimeout(() => $('chat-input').focus(), 200);
  }
  // Month cells depend on the width: redraw once the slide has finished.
  setTimeout(() => { if (state.view === 'month') renderView(); }, 260);
}

$('btn-chat').onclick = () => toggleChat();
$('btn-chat-close').onclick = () => toggleChat(false);

async function showWelcome() {
  const hasKey = (await desk.chatKeyStatus()).data;
  if (!hasKey) {
    const m = addMsg('bot', 'Set me up in Settings → Assistant: pick a provider (Claude, Gemini, OpenAI, Groq, a local model with Ollama…) and add its API key.');
    const go = el('button', 'btn small', 'Open Settings');
    go.type = 'button';
    go.onclick = openSettings;
    m.append(el('div', 'msg-actions'), go);
    return;
  }
  addMsg('bot', "Hi! I can add, move or delete events and tasks, plan your tasks into time blocks, and answer questions about your schedule.");
  const chips = el('div', 'chips');
  chips.id = 'chat-chips';
  for (const s of SUGGESTIONS) {
    const c = el('button', 'chip-suggest', s);
    c.type = 'button';
    c.onclick = () => sendChat(s);
    chips.append(c);
  }
  $('chat-log').append(chips);
}

/** Add a message bubble. Bot text gets basic formatting. */
function addMsg(who, text, extra = '') {
  const m = el('div', `msg ${who} ${extra}`.trim());
  if (who === 'bot' && !extra) m.append(...richText(text));
  else m.textContent = text;
  $('chat-log').append(m);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  return m;
}

/**
 * Minimal, safe formatting: paragraphs, "- " / "* " bullet lists, **bold**.
 * Builds DOM nodes with textContent, so nothing in the reply can run as HTML.
 */
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

function inline(s) {
  return s.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) =>
    (part.startsWith('**') && part.endsWith('**') ? el('b', '', part.slice(2, -2)) : document.createTextNode(part)));
}

/** "✓ Created Gym · Tue 6:00 – 7:00 PM": click to jump to it. */
function actionCard(a) {
  const card = el('button', `action-card ${a.kind}`);
  card.type = 'button';
  const verb = {
    created: 'Created', updated: 'Updated', deleted: 'Deleted',
    'task-created': 'Added task', 'task-updated': 'Updated task', 'task-completed': 'Completed', 'task-reopened': 'Reopened',
  }[a.kind] || 'Changed';
  const isTask = a.kind.startsWith('task-') || a.isTask;
  card.append(icon(a.kind === 'deleted' ? 'delete' : a.kind === 'task-completed' ? 'checkmark_circle' : isTask ? 'task_list_ltr' : 'checkmark'));
  const text = el('span', 'ac-text');
  text.append(el('b', '', `${verb} ${a.title}`));
  if (isTask && a.due) {
    const [y, m, d] = a.due.split('-').map(Number);
    text.append(el('span', 'ac-when', `Due ${fmtDay(new Date(y, m - 1, d))}`));
  } else if (a.start) {
    const s = new Date(a.start), e = new Date(a.end);
    text.append(el('span', 'ac-when', a.allDay ? fmtDay(s) : `${fmtDay(s)}, ${fmtTime(s)} – ${fmtTime(e)}`));
  }
  card.append(text);
  if (a.kind === 'deleted') card.disabled = true;
  else if (isTask) {
    card.title = "Show in Today's tasks";
    card.onclick = () => document.querySelector(`.task-row[data-task-id="${CSS.escape(a.id)}"]`)?.scrollIntoView({ block: 'center' });
  } else {
    card.title = 'Show in calendar';
    card.onclick = () => { state.highlightId = a.id; goToDate(new Date(a.start)); };
  }
  return card;
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  $('chat-chips')?.remove();
  $('chat-input').value = '';
  addMsg('user', text);
  const pending = addMsg('bot', 'Thinking…', 'thinking');
  $('chat-send').disabled = true;
  try {
    const { reply, actions, freshStart } = unwrap(await desk.chatSend(text));
    if (freshStart) {
      // The backend started a new conversation (long pause or a long chat), so earlier
      // messages are no longer remembered. Say so where it happened.
      pending.before(el('div', 'chat-divider', 'New conversation: earlier messages are not remembered'));
    }
    pending.className = 'msg bot';
    pending.replaceChildren(...richText(reply));
    if (actions?.length) {
      const cards = el('div', 'action-cards');
      for (const a of actions) cards.append(actionCard(a));
      $('chat-log').append(cards);
      offerUndo(actions.filter((a) => a.kind === 'deleted' && a.token), cards);
    }
  } catch (err) {
    pending.textContent = err.message;
    pending.className = 'msg bot error';
  } finally {
    $('chat-send').disabled = false;
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    $('chat-input').focus();
  }
}

/**
 * The assistant deletes without asking; instead you get the same "Undo" toast as
 * deleting from the calendar. The backend starts the countdown when this reply arrives.
 */
function offerUndo(deleted, cards) {
  if (!deleted.length) return;
  const label = deleted.length === 1 ? `Deleted “${deleted[0].title}”` : `Deleted ${deleted.length} items`;
  showToast(label, 'Undo', async () => {
    let restored = 0;
    for (const a of deleted) if ((await desk.undoDelete(a.token)).data) restored++;
    status(restored ? `Restored ${restored === 1 ? `“${deleted[0].title}”` : `${restored} events`}` : 'Too late to undo.', !restored);
    if (restored) {
      for (const card of cards.querySelectorAll('.action-card.deleted')) {
        card.classList.replace('deleted', 'restored');
        card.querySelector('b').textContent = card.querySelector('b').textContent.replace(/^Deleted/, 'Restored');
        card.querySelector('.ico').className = 'ico i-arrow_undo';
      }
    }
    loadEvents(); // also reloads tasks
  });
}

$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('chat-input').value); });

// Enter sends, Shift+Enter adds a new line.
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); }
});

$('btn-chat-reset').onclick = async () => {
  await desk.chatReset();
  $('chat-log').replaceChildren();
  showWelcome();
};

// The backend pings us when the assistant changed something.
desk.onEventsChanged(() => loadEvents());
