// assistant.js: the chatbot. An AI model reads and changes your calendar through "tools".
//
// WHY TOOLS, NOT RAG
// RAG (retrieval-augmented generation) means stuffing documents into the prompt.
// A calendar is live, structured data, so instead we give the model a few functions
// it may call: list_events, create_event, update_event, delete_event. The model
// decides which to call, we run them against Google (via calendar.js, the same code
// the UI uses), send back the results, and it replies in plain English. It always
// sees fresh data and can act, not just answer.
//
// THE LOOP (one call to send())
//   you: "move gym to 7pm"
//   → model: call list_events(today..tomorrow)    → we run it, return JSON
//   → model: call update_event(id, start=19:00)   → we run it, return OK
//   → model: "Done, Gym is now 7–8 PM tomorrow."  → shown in the chat
//
// WHICH MODEL
//   Settings → Assistant → Provider. Claude goes through the Anthropic SDK
//   (runClaude); everything else uses the OpenAI-compatible chat/completions format
//   (runOpenAI): OpenAI, Gemini, Groq, OpenRouter, Cerebras, Ollama, LM Studio or
//   any compatible server. The list of providers is in providers.js.
//
// SAFETY
//   • Deletes don't ask first, but they're undoable: the event is hidden right away and
//     really deleted a few seconds after the reply appears, unless you click "Undo".
//   • API keys are stored encrypted with DPAPI (see secureStore.js), never in prefs.json.

const Anthropic = require('@anthropic-ai/sdk');
const calendar = require('./calendar');
const store = require('./secureStore');
const prefs = require('./prefs');
const { PROVIDERS, DEFAULT_PROVIDER, keyName, publicList } = require('./providers');

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Claude models (Settings → Assistant → Model, when the provider is Claude).
// Approximate prices are in the labels; a typical request here is ~8k tokens in, ~1.5k out.
//   effort    how hard the model thinks: 'low' is faster and cheaper, 'high' more careful
//   fallback  if Claude declines a request (a rare false positive from its safety
//             classifiers), the API retries it on a suitable fallback model. Haiku 5.5
//             has no server-side fallback, so its requests leave this out.
const MODELS = {
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5 — fastest, about $0.002 per request', effort: 'medium', fallback: false },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 — about $0.03 per request', effort: 'medium', fallback: true },
  'claude-opus-5-5': { label: 'Claude Opus 5.5 — most capable, about $0.06 per request', effort: 'medium', fallback: true },
};
const DEFAULT_MODEL = 'claude-haiku-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM = `You are the assistant inside "Desk Calendar", a desktop app for the user's Google Calendar.
The user's timezone is ${TIMEZONE}. Each user message starts with the current local date and time.

How to work:
- Use the tools for anything about the schedule. Never make up events, ids or times.
- Before editing or deleting, call list_events to find the exact event (you need its event_id and calendar_id). Don't guess IDs.
- If several events match, ask which one rather than picking.
- Times you send must be local ISO date-times without a timezone suffix, e.g. 2026-11-17T18:00. All-day events use YYYY-MM-DD, and for them "end" is the last day (inclusive).
- New events default to 1 hour unless the user gives a duration or end time.
- After changing something, confirm in one short sentence with the day and time (e.g. "Added Gym, Tue 6–7 PM").
- Keep replies brief; this is a side panel. You may use **bold** and simple "- " bullet lists. No tables or headers.`;

// ---------------------------------------------------------------------------
// Tool definitions: what the model sees. The descriptions matter: they're how
// the model knows when and how to use each tool.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List the user\'s calendars with ids, names and whether they are editable.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_events',
    description: 'List events in a date range (inclusive) across all of the user\'s calendars. Use this to answer questions about the schedule and to find event ids before editing or deleting.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Last day (inclusive), YYYY-MM-DD' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'Local start, e.g. 2026-11-17T18:00, or YYYY-MM-DD if all_day' },
        end: { type: 'string', description: 'Local end (optional; defaults to 1 hour). For all_day: last day inclusive' },
        all_day: { type: 'boolean' },
        calendar_id: { type: 'string', description: 'Defaults to the primary calendar' },
        location: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'update_event',
    description: 'Change an existing event. Only pass the fields that change. If you pass start without end, the event keeps its original duration.',
    input_schema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        event_id: { type: 'string' },
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        all_day: { type: 'boolean' },
        location: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['calendar_id', 'event_id'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete an event. It is removed right away; the user can undo for a few seconds.',
    input_schema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string' },
        event_id: { type: 'string' },
        title: { type: 'string', description: 'Event title, shown in the Undo message' },
      },
      required: ['calendar_id', 'event_id', 'title'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations: what actually runs when the model calls a tool.
// ---------------------------------------------------------------------------

async function runTool(name, input, { queueDelete }) {
  switch (name) {
    case 'list_calendars':
      return calendar.listCalendars();

    case 'list_events': {
      const from = localDate(input.start_date);
      const to = localDate(input.end_date);
      to.setDate(to.getDate() + 1); // make the end day inclusive
      const events = await calendar.listEvents(from, to);
      // Give the model compact, local-time data (it doesn't need colors or links).
      return events.map((e) => ({
        event_id: e.id,
        calendar_id: e.calendarId,
        calendar: e.calendarName,
        title: e.title,
        all_day: e.allDay,
        start: localStamp(new Date(e.start), e.allDay),
        end: e.allDay ? localStamp(addDays(new Date(e.end), -1), true) : localStamp(new Date(e.end)),
        location: e.location || undefined,
        editable: e.canEdit,
      }));
    }

    case 'create_event':
      return calendar.createEvent({
        calendarId: input.calendar_id || 'primary',
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: !!input.all_day,
        location: input.location,
        description: input.description,
      });

    case 'update_event': {
      let { start, end, all_day: allDay } = input;
      if (start !== undefined && (end === undefined || allDay === undefined)) {
        // Moving an event: look it up so we can keep its duration / all-day-ness.
        const current = await calendar.getEvent({ calendarId: input.calendar_id, eventId: input.event_id });
        const wasAllDay = !!current.start.date;
        if (allDay === undefined) allDay = wasAllDay;
        if (end === undefined && !allDay && !wasAllDay) {
          const ms = new Date(current.end.dateTime) - new Date(current.start.dateTime);
          end = new Date(new Date(start).getTime() + ms).toISOString();
        }
      }
      return calendar.updateEvent({
        calendarId: input.calendar_id,
        eventId: input.event_id,
        title: input.title,
        start, end, allDay,
        location: input.location,
        description: input.description,
      });
    }

    case 'delete_event': {
      // No dialog: hide it now and let main.js delete it after the Undo window.
      const token = queueDelete({ calendarId: input.calendar_id, eventId: input.event_id });
      return { deleted: true, undoToken: token };
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Which provider / model / server is in use (from prefs.json)
// ---------------------------------------------------------------------------

/**
 * { id, p, model, baseUrl }: the provider id, its entry in providers.js, the model,
 * and (for OpenAI-compatible providers) the API root without a trailing slash.
 */
function config() {
  const id = PROVIDERS[prefs.get('assistantProvider')] ? prefs.get('assistantProvider') : DEFAULT_PROVIDER;
  const p = PROVIDERS[id];
  if (p.kind === 'anthropic') {
    const model = MODELS[prefs.get('assistantModel')] ? prefs.get('assistantModel') : DEFAULT_MODEL;
    return { id, p, model, baseUrl: '' };
  }
  const model = (prefs.get('assistantModels') || {})[id] ?? p.model;
  const baseUrl = ((prefs.get('assistantBaseUrls') || {})[id] || p.baseUrl || '').replace(/\/+$/, '');
  return { id, p, model, baseUrl };
}

/** The saved key for a provider, else its environment variable, else ''. */
async function getKey(id) {
  const saved = await store.load(keyName(id));
  return saved || (PROVIDERS[id].keyEnv && process.env[PROVIDERS[id].keyEnv]) || '';
}

/** True when the current provider has everything it needs to chat. */
async function hasKey() {
  const { id, p, model, baseUrl } = config();
  if (!model || (p.kind === 'openai' && !baseUrl)) return false;
  return !p.keyRequired || !!(await getKey(id));
}

/** Save a key for the current provider (encrypted). */
async function setKey(key) {
  const { id, p } = config();
  key = String(key || '').trim();
  if (p.keyPattern && !p.keyPattern.test(key)) throw new Error(`That doesn't look like a ${p.name} API key (it should look like ${p.keyHint}).`);
  if (key.length < 8 || /\s/.test(key)) throw new Error("That doesn't look like an API key.");
  await store.save(keyName(id), key);
  return true;
}

/** Everything Settings → Assistant shows. Never includes a key itself. */
async function getSettings() {
  const { id, p, model, baseUrl } = config();
  const saved = !!(await store.load(keyName(id)));
  return {
    provider: id,
    providers: publicList(),
    claudeModels: Object.entries(MODELS).map(([mid, m]) => ({ id: mid, label: m.label })),
    model,
    baseUrl,
    keySaved: saved,
    keyFromEnv: !saved && !!(p.keyEnv && process.env[p.keyEnv]),
    keyEnv: p.keyEnv || '',
    ready: await hasKey(),
  };
}

/** Change provider, model or server address. Any change starts a new chat. */
function setSettings({ provider, model, baseUrl } = {}) {
  if (provider !== undefined) {
    if (!PROVIDERS[provider]) throw new Error(`Unknown provider ${provider}`);
    prefs.set({ assistantProvider: provider });
  }
  const { id, p } = config();
  if (model !== undefined) {
    model = String(model).trim();
    if (p.kind === 'anthropic') {
      if (!MODELS[model]) throw new Error(`Unknown Claude model ${model}`);
      prefs.set({ assistantModel: model });
    } else {
      prefs.set({ assistantModels: { ...(prefs.get('assistantModels') || {}), [id]: model } });
    }
  }
  if (baseUrl !== undefined && p.kind === 'openai') {
    baseUrl = String(baseUrl).trim().replace(/\/+$/, '');
    if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new Error('The server address should start with http:// or https://');
    // Saving the provider's own default clears the override.
    prefs.set({ assistantBaseUrls: { ...(prefs.get('assistantBaseUrls') || {}), [id]: baseUrl === p.baseUrl ? '' : baseUrl } });
  }
  reset();
  return getSettings();
}

/** "Load models": ask the server which models this key can use. */
async function fetchModels() {
  const cfg = config();
  if (cfg.p.kind === 'anthropic') return Object.keys(MODELS);
  if (!cfg.baseUrl) throw new Error('Enter the server address first.');
  try {
    const data = await openaiRequest(cfg, await getKey(cfg.id), '/models');
    const list = Array.isArray(data) ? data : (data?.data || data?.models || []);
    return [...new Set(list.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean))].sort();
  } catch (err) {
    throw new Error(friendlyError(err, cfg));
  }
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

let messages = []; // history in the current provider's format: user turns, model turns, tool calls and results
let chatIdentity = null; // provider|model|server this history belongs to

function reset() { messages = []; chatIdentity = null; }

/**
 * Send one user message and run the tool loop until the model gives a final answer.
 *   onChanged(): called after any create/update/delete so the UI refreshes.
 *   queueDelete({ calendarId, eventId }): hides an event and queues its deletion; returns an undo token.
 * Returns { reply, actions }: actions are what changed, for the little cards in the
 * chat ({ kind: 'created' | 'updated' | 'deleted', id, title, start, end, allDay }).
 */
async function send(text, ctx) {
  const cfg = config();
  if (!cfg.model) throw new Error('Choose a model in Settings → Assistant first.');
  if (cfg.p.kind === 'openai' && !cfg.baseUrl) throw new Error('Enter the server address in Settings → Assistant first.');
  if (!(await hasKey())) throw new Error(`Add your ${cfg.p.name} API key in Settings → Assistant first.`);

  // A conversation stays on one provider and model: switching starts a new chat
  // (each provider stores history in its own format).
  const identity = `${cfg.id}|${cfg.model}|${cfg.baseUrl}`;
  if (chatIdentity !== identity) messages = [];
  chatIdentity = identity;

  // If anything goes wrong mid-turn, roll history back so the next message
  // starts from a clean, valid conversation.
  const checkpoint = messages.length;
  const turn = { cfg, ctx, actions: [], checkpoint, userText: `[Now: ${nowLabel()}]\n${text}` };
  try {
    return cfg.p.kind === 'anthropic' ? await runClaude(turn) : await runOpenAI(turn);
  } catch (err) {
    messages.length = checkpoint;
    throw new Error(friendlyError(err, cfg));
  }
}

const MAX_STEPS = 10; // hard cap so a tool loop can't run forever
const TOO_MANY = 'That took too many steps. Could you break it into smaller requests?';

/** Run one tool call; record a chat card if it changed something. Returns the JSON for the model. */
async function useTool(name, input, { ctx, actions }) {
  const output = await runTool(name, input || {}, ctx);
  const action = toAction(name, input || {}, output);
  if (action) actions.push(action);
  return { changed: /^(create|update|delete)_event$/.test(name), json: JSON.stringify(forModel(output) ?? null) };
}

// --- Claude (Anthropic Messages API) ---------------------------------------

async function runClaude(turn) {
  const { cfg, ctx, actions, checkpoint } = turn;
  const claude = new Anthropic({ apiKey: (await getKey(cfg.id)) || undefined });
  const { effort, fallback } = MODELS[cfg.model];
  messages.push({ role: 'user', content: turn.userText });

  const request = { model: cfg.model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages, output_config: { effort } };

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = fallback
      ? await claude.beta.messages.create({ ...request, betas: [FALLBACK_BETA], fallbacks: 'default' })
      : await claude.messages.create(request);

    if (res.stop_reason === 'refusal') {
      messages.length = checkpoint;
      return { reply: "Sorry, I can't help with that request.", actions: [] };
    }

    // Keep Claude's whole reply (text, thinking and tool calls) in history, unchanged.
    messages.push({ role: 'assistant', content: res.content });

    const toolCalls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || toolCalls.length === 0) {
      const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: reply || 'Done.', actions };
    }

    // Run every tool Claude asked for, then send ALL results back in one message.
    const results = [];
    let changed = false;
    for (const call of toolCalls) {
      try {
        const r = await useTool(call.name, call.input, turn);
        changed ||= r.changed;
        results.push({ type: 'tool_result', tool_use_id: call.id, content: r.json });
      } catch (err) {
        // Tell Claude what failed so it can explain or try something else.
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: err.message });
      }
    }
    messages.push({ role: 'user', content: results });
    if (changed) ctx.onChanged();
  }
  return { reply: TOO_MANY, actions };
}

// --- OpenAI-compatible chat/completions (OpenAI, Gemini, Groq, Ollama, …) ---

// Same tools, in the OpenAI "function" format.
const OPENAI_TOOLS = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function runOpenAI(turn) {
  const { cfg, ctx, actions } = turn;
  const key = await getKey(cfg.id);
  messages.push({ role: 'user', content: turn.userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await openaiRequest(cfg, key, '/chat/completions', {
      model: cfg.model,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: OPENAI_TOOLS,
    });
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error('The model sent back an empty response.');

    const calls = msg.tool_calls || [];
    calls.forEach((c, i) => { c.id ||= `call_${step}_${i}`; }); // a few local servers leave ids out
    // Keep the tool calls exactly as returned (Gemini attaches data to them that it needs back).
    messages.push(calls.length
      ? { role: 'assistant', content: msg.content ?? null, tool_calls: calls }
      : { role: 'assistant', content: textOf(msg.content) });

    if (!calls.length) return { reply: cleanReply(textOf(msg.content)) || msg.refusal || 'Done.', actions };

    let changed = false;
    for (const call of calls) {
      let content;
      try {
        const r = await useTool(call.function?.name, parseArgs(call.function?.arguments), turn);
        changed ||= r.changed;
        content = r.json;
      } catch (err) {
        content = JSON.stringify({ error: err.message });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
    if (changed) ctx.onChanged();
  }
  return { reply: TOO_MANY, actions };
}

/** POST (with a body) or GET an OpenAI-compatible endpoint. Throws Error with .status on HTTP errors. */
async function openaiRequest(cfg, key, path, body) {
  let res;
  try {
    res = await fetch(cfg.baseUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(cfg.id === 'openrouter' ? { 'X-Title': 'Desk Calendar' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Local models on a CPU can be slow; hosted ones shouldn't take this long.
      signal: AbortSignal.timeout(cfg.p.local ? 300000 : 90000),
    });
  } catch (err) {
    const e = new Error(err.message);
    e.network = err.name === 'TimeoutError' ? 'timeout' : 'connect';
    throw e;
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (!res.ok) {
    const info = (Array.isArray(data) ? data[0] : data)?.error ?? data;
    const message = (typeof info === 'string' ? info : info?.message) || raw.slice(0, 300) || res.statusText;
    const e = new Error(message);
    e.status = res.status;
    throw e;
  }
  if (data === null) throw new Error(`The server at ${cfg.baseUrl} didn't answer with JSON. Check the server address.`);
  return data;
}

/** Tool arguments arrive as a JSON string (sometimes already an object, sometimes empty). */
function parseArgs(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch { throw new Error('The tool arguments were not valid JSON.'); }
}

/** Message content can be a string or a list of parts. */
const textOf = (content) => (Array.isArray(content)
  ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
  : content || '');

/** Some open models put their reasoning in <think>…</think>; don't show it. */
const cleanReply = (text) => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// ---------------------------------------------------------------------------
// Results → chat cards and model-friendly JSON
// ---------------------------------------------------------------------------

/** A card for the chat when a tool changed the calendar (or null). */
function toAction(name, input, output) {
  if (name === 'create_event' || name === 'update_event') {
    return { kind: name === 'create_event' ? 'created' : 'updated', ...output };
  }
  if (name === 'delete_event' && output?.deleted) return { kind: 'deleted', title: input.title, token: output.undoToken };
  return null;
}

/** Created/updated events come back with UTC timestamps; give the model local times instead. */
function forModel(output) {
  if (output?.undoToken) return { deleted: true }; // the undo token is for the UI, not the model
  if (!output?.start || !output.id) return output;
  const start = new Date(output.start);
  const end = new Date(output.end);
  return {
    event_id: output.id,
    title: output.title,
    all_day: output.allDay,
    start: localStamp(start, output.allDay),
    end: output.allDay ? localStamp(addDays(end, -1), true) : localStamp(end),
    meet_link: output.meetLink || undefined,
  };
}

function friendlyError(err, { id, p, model, baseUrl }) {
  const name = p.name;
  if (err instanceof Anthropic.AuthenticationError) return 'Your Claude API key was rejected. Check it in Settings → Assistant.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting requests. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach Claude. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  if (err.network === 'timeout') return `${name} took too long to answer.${p.local ? ' Local models can be slow; try a smaller one.' : ''}`;
  if (err.network === 'connect') {
    return p.local
      ? `Can't reach ${name} at ${baseUrl}. Is it running?`
      : `Can't reach ${baseUrl}. Check your internet connection and the server address.`;
  }
  if (err.status === 401 || err.status === 403) return `${name} rejected the API key (${err.status}). Check it in Settings → Assistant.${err.message ? ` Details: ${err.message}` : ''}`;
  if (err.status === 429) return `${name} says you've hit a rate limit or quota. Wait a bit, or check your plan. Details: ${err.message}`;
  if (err.status === 404) return `${name} returned "not found" for model "${model}". Check the model name (Settings → Assistant → Load models) and the server address.`;
  if (err.status) return `${name} error ${err.status}: ${err.message}${/tool|function/i.test(err.message) ? ' (this model may not support tool calling; try another)' : ''}`;
  if (id) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Small date helpers
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const localDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
const weekday = (d) => d.toLocaleDateString('en-US', { weekday: 'short' });

/** '2026-11-17T18:00 (Tue)' or, for all-day, '2026-11-17 (Tue)'. */
function localStamp(d, dateOnly = false) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? `${date} (${weekday(d)})` : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())} (${weekday(d)})`;
}
const nowLabel = () => `${localStamp(new Date())}, ${TIMEZONE}`;

module.exports = { send, reset, hasKey, setKey, getSettings, setSettings, fetchModels };
