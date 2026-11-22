// mock-claude.js: a scripted stand-in for the Claude API, for local testing only.
//
// Used when the Worker runs with the fake calendar (MOCK_GOOGLE=1) and no
// ANTHROPIC_API_KEY is set. It answers the SDK's /v1/messages calls with canned
// tool calls so the assistant's tool loop, action cards, Undo and the "plan first,
// create after yes" flow can be tried on the phone without a key or any cost.
// It understands:
//   "plan …"            list_tasks + find_free_time together, then a 2-block plan and a question
//   "yes" / "ok"        after a plan: create_event for each block, linked to its task
//   "add task <title>"  create_task due today
//   "done <word>"       list_tasks, then update_task completed on the first match
//   "delete task <word>" list_tasks, then delete_task on the first match
//   "delete <word>"     list_events (7 days), then delete_event on the first match
//   "add <title>"       create_event tomorrow 10:00–11:00
//   anything else       list_events for today, then a short summary
// With a real key in .dev.vars, the real Claude is used instead.

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let n = 0;
// Plausible token counts, so the phone's cost display has something to show.
const usage = (cached) => ({ input_tokens: 60, cache_creation_input_tokens: cached ? 0 : 2600, cache_read_input_tokens: cached ? 2600 : 0, output_tokens: 90 });
const message = (content, stop_reason, cached) => ({
  id: `msg_mock_${++n}`, type: 'message', role: 'assistant', model: 'mock', content, stop_reason,
  stop_sequence: null, usage: usage(cached),
});
const toolUses = (calls, cached) => message(calls.map(([name, input]) => ({ type: 'tool_use', id: `toolu_mock_${++n}`, name, input })), 'tool_use', cached);
const text = (t, cached) => message([{ type: 'text', text: t }], 'end_turn', cached);

const ymd = (d) => d.toISOString().slice(0, 10);

/** The tool result for the most recent call to `name` anywhere in the conversation. */
function lastResult(msgs, name) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const call = Array.isArray(msgs[i].content) && msgs[i].content.find((b) => b.type === 'tool_use' && b.name === name);
    if (!call) continue;
    const res = msgs[i + 1]?.content?.find?.((b) => b.tool_use_id === call.id);
    try { return JSON.parse(res?.content); } catch { return null; }
  }
  return null;
}

export async function mockClaudeFetch(_url, init) {
  const req = JSON.parse(init.body);
  const msgs = req.messages;
  const cached = msgs.length > 1; // the system prompt is "cached" after the first request
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
  const ask = lastUser.content.replace(/^\[Now:[^\]]*\]\n/, '').trim();
  const turnStart = msgs.lastIndexOf(lastUser);
  const inTurn = msgs.slice(turnStart + 1);
  const called = inTurn.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.name) : []));
  const today = new Date();
  const week = new Date(Date.now() + 6 * 864e5);

  // --- Planning: show the plan first, create only after "yes" ---------------------------
  if (/^plan\b/i.test(ask)) {
    if (!called.length) {
      return json(toolUses([
        ['list_tasks', { start_date: ymd(today), end_date: ymd(week), include_undated: true }],
        ['find_free_time', { start_date: ymd(today), end_date: ymd(week) }],
      ], cached));
    }
    const open = (lastResult(msgs, 'list_tasks') || []).filter((t) => !t.done).slice(0, 2);
    const slots = (lastResult(msgs, 'find_free_time')?.days || []).flatMap((d) => d.free.map((f) => `${d.date.slice(0, 10)} ${f}`)).slice(0, 2);
    if (!open.length || !slots.length) return json(text('(mock) Nothing to plan, or no free time this week.', cached));
    const lines = open.slice(0, slots.length).map((t, i) => `- **${t.title}**: ${slots[i]}`);
    return json(text(`(mock) Here's a plan:\n${lines.join('\n')}\nShall I add these blocks?`, cached));
  }
  if (/^(yes|ok|sure|do it)\b/i.test(ask) && !called.includes('create_event')) {
    const open = (lastResult(msgs, 'list_tasks') || []).filter((t) => !t.done).slice(0, 2);
    const slots = (lastResult(msgs, 'find_free_time')?.days || []).flatMap((d) => d.free.map((f) => ({ day: d.date.slice(0, 10), from: f.split('-')[0] }))).slice(0, 2);
    if (!open.length || !slots.length) return json(text('(mock) There is no plan to add.', cached));
    const blocks = open.slice(0, slots.length).map((t, i) => {
      const [h, m] = slots[i].from.split(':').map(Number);
      const end = `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      return ['create_event', { title: t.title, start: `${slots[i].day}T${slots[i].from}`, end: `${slots[i].day}T${end}`, task_id: t.task_id, list_id: t.list_id }];
    });
    return json(toolUses(blocks, cached));
  }

  // --- Tasks ---------------------------------------------------------------------------------
  const addTask = ask.match(/^add task\s+(.+)/i);
  if (addTask && !called.length) return json(toolUses([['create_task', { title: addTask[1], due_date: ymd(today) }]], cached));
  const doneTask = ask.match(/^done\s+(.+)/i);
  const delTask = ask.match(/^delete task\s+(.+)/i);
  if ((doneTask || delTask) && !called.length) return json(toolUses([['list_tasks', { start_date: ymd(today), end_date: ymd(week) }]], cached));
  if ((doneTask || delTask) && called.at(-1) === 'list_tasks') {
    const word = (doneTask || delTask)[1].toLowerCase();
    const hit = (lastResult(msgs, 'list_tasks') || []).find((t) => t.title.toLowerCase().includes(word));
    if (!hit) return json(text(`(mock) No task matches "${word}".`, cached));
    return json(toolUses([doneTask
      ? ['update_task', { list_id: hit.list_id, task_id: hit.task_id, completed: true }]
      : ['delete_task', { list_id: hit.list_id, task_id: hit.task_id, title: hit.title }]], cached));
  }

  // --- Events (the original script) ------------------------------------------------------------
  const del = ask.match(/^delete\s+(.+)/i);
  const add = ask.match(/^add\s+(.+)/i);
  if (!called.length) {
    if (del) return json(toolUses([['list_events', { start_date: ymd(today), end_date: ymd(week) }]], cached));
    if (add) {
      const t = new Date(Date.now() + 864e5);
      return json(toolUses([['create_event', { title: add[1], start: `${ymd(t)}T10:00`, end: `${ymd(t)}T11:00` }]], cached));
    }
    return json(toolUses([['list_events', { start_date: ymd(today), end_date: ymd(today) }]], cached));
  }

  const lastCall = called.at(-1);
  const results = msgs.at(-1).content;
  if (Array.isArray(results) && results.some((r) => r.is_error)) return json(text(`(mock) That failed: ${results.find((r) => r.is_error).content}`, cached));
  if (lastCall === 'list_events' && del) {
    const hit = (lastResult(msgs, 'list_events') || []).find((e) => e.title.toLowerCase().includes(del[1].toLowerCase()) && !e.read_only);
    if (!hit) return json(text(`(mock) I couldn't find "${del[1]}" in the next 7 days.`, cached));
    return json(toolUses([['delete_event', { calendar_id: hit.calendar_id, event_id: hit.event_id, title: hit.title }]], cached));
  }
  if (lastCall === 'delete_event' || lastCall === 'delete_task') return json(text('(mock) Deleted it. You can undo for a few seconds.', cached));
  if (lastCall === 'create_event') {
    const made = inTurn.filter((m) => m.role === 'user').flatMap((m) => m.content).map((r) => { try { return JSON.parse(r.content); } catch { return null; } }).filter(Boolean);
    return json(text(made.length > 1 ? `(mock) Added ${made.length} blocks.` : `(mock) Added **${made[0]?.title}**, ${made[0]?.start}.`, cached));
  }
  if (lastCall === 'create_task') return json(text('(mock) Added the task for today.', cached));
  if (lastCall === 'update_task') return json(text('(mock) Marked it done.', cached));
  if (lastCall === 'list_events') {
    const data = lastResult(msgs, 'list_events') || [];
    return json(text(data.length ? `(mock) Today you have:\n${data.map((e) => `- **${e.title}** ${e.start.slice(11, 16)}`).join('\n')}` : '(mock) Nothing today.', cached));
  }
  return json(text('(mock) Done.', cached));
}
