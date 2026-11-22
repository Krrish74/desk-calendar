// assistant.js: the chatbot. Claude reads and changes your calendar and tasks through "tools".
// Ported from the desktop app's src/main/assistant.js (Claude only: the phone doesn't
// offer the desktop's other AI providers). Tools, instructions, planning rules, profile,
// caching and cost tracking are the same.
//
// WHY TOOLS, NOT RAG
// A calendar is live, structured data, so instead of stuffing it into the prompt we give
// Claude a few functions it may call (list_events, list_tasks, create_event,
// find_free_time, …). Claude decides which to call, we run them against Google (via
// calendar.js and tasks.js, the same code the phone UI uses), send back the results, and
// it replies in plain English.
//
// YOUR PROFILE ("About you" in Settings) IS CAG, NOT RAG
// It's small (well under 1,000 tokens), so it goes straight into the system prompt. With
// prompt caching, re-sending it costs about a tenth of the normal input price.
//
// THE LOOP (one call to send())
//   you: "move gym to 7pm"
//   → Claude: list_events(today..tomorrow)    → we run it, return JSON
//   → Claude: update_event(id, start=19:00)   → we run it, return OK
//   → Claude: "Done, Gym is now 7–8 PM tomorrow."
//
// KEEPING IT CHEAP
//   • Prompt caching: a breakpoint on the system prompt (tools + instructions + profile)
//     plus automatic caching of the growing conversation. The system prompt has no
//     timestamps: the current time goes in each user message.
//   • find_free_time does the scheduling arithmetic here (freetime.js), not in the model.
//   • Long calendar / task-list ids become c1, c2 / l1, l2 in tool results.
//   • A conversation restarts after 30 idle minutes (the cache has expired by then) or 20
//     messages, so old history isn't re-sent forever.
//
// WHAT'S DIFFERENT ON THE PHONE
//   • The Claude API key is a Worker secret (ANTHROPIC_API_KEY); it never reaches the phone.
//   • The conversation (and its short-id table) is saved in D1 between requests.
//   • "Local time" is the phone's time zone (c.tz); the Worker itself runs in UTC.
//
// SAFETY
//   • Deletes don't ask first, but they're undoable: the item is hidden right away and
//     really deleted a few seconds after the reply reaches the phone, unless you tap Undo.
//   • Plans with several time blocks are shown first and only created when you agree.

import Anthropic from '@anthropic-ai/sdk';
import * as calendar from './calendar.js';
import * as tasks from './tasks.js';
import { MODELS, DEFAULT_MODEL, FALLBACK_BETA, CACHE_WRITE_MULTIPLIER } from './models.js';
import { freeSlots, normalizeProfile, PROFILE_DEFAULTS } from './freetime.js';
import { localMidnight, addDaysYmd, localStamp, parseTime, ymdIn, toWall } from './tz.js';
import { patchPrefs } from './prefs.js';
import { HttpError, badRequest } from './http.js';
import { mockClaudeFetch } from './mock-claude.js';

// Conversation limits (see "KEEPING IT CHEAP").
const IDLE_RESET_MS = 30 * 60 * 1000;
const MAX_USER_TURNS = 20;
const MAX_HISTORY_CHARS = 300_000; // a D1 row stays well under its size limit
export const MAX_RANGE_DAYS = 31;
const MAX_STEPS = 10; // hard cap so a tool loop can't run forever
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function currentModel(c) {
  const id = c.prefs.assistantModel;
  return MODELS[id] ? id : DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// System prompt = fixed instructions + your profile. Deterministic text (no
// timestamps, fixed order) so it stays cached until you edit your profile.
// The "Tasks and planning" rules are the desktop app's, word for word.
// ---------------------------------------------------------------------------

const instructions = (tz) => `You are the assistant inside "Desk Calendar", an iPhone app for the user's Google Calendar and Google Tasks.
The user's timezone is ${tz}. Each user message starts with the current local date and time.

How to work:
- Use the tools for anything about the schedule or tasks. Never make up events, tasks, ids or times.
- Before editing or deleting, find the exact item first (list_events or list_tasks); you need its ids. Don't guess IDs.
- If several items match, ask which one rather than picking.
- Make independent tool calls together in one turn (for example list_tasks and find_free_time), not one after another.
- Times you send must be local ISO date-times without a timezone suffix, e.g. 2026-11-17T18:00. All-day events use YYYY-MM-DD, and for them "end" is the last day (inclusive).
- New events default to 1 hour unless the user gives a duration or end time.
- After changing something, confirm in one short sentence with the day and time (e.g. "Added Gym, Tue 6–7 PM").
- Keep replies brief; this is a small phone screen. You may use **bold** and simple "- " bullet lists. No tables or headers.

Tasks and planning:
- Google Tasks have a due date but no time. "Today's tasks" means list_tasks for today; overdue tasks come with it.
- To plan or schedule tasks ("plan my week", "find time for X"): call list_tasks (include_undated true when planning several days) and find_free_time in the same turn. Then fit the tasks into the free slots:
  - hardest or most important work in the user's best focus time;
  - blocks of about the usual length, never longer than the maximum, with the break between blocks;
  - nothing outside working hours unless the user asks;
  - finish each task before its due date; overdue tasks first.
- If your plan has two or more blocks, reply with it as a short bullet list (day, time, task) and ask whether to add them. Create nothing until the user agrees. A single block the user asked for directly: just create it.
- When creating a block for a task, call create_event with its task_id and list_id so the block is linked, and use the task's title. Don't mark tasks done when scheduling them.
- If the tasks don't fit, say what didn't fit and suggest what to move or drop.`;

/** The "About the user" section, rendered from Settings → About you (same as desktop). */
export function profileText(raw) {
  const p = normalizeProfile(raw);
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = p.workDays.length ? p.workDays.map((d) => DAY[d]).join(', ') : 'no fixed days';
  const lines = [
    `- Working days: ${days}; working hours ${p.dayStart}–${p.dayEnd}.`,
    p.lunchStart && p.lunchEnd ? `- Lunch ${p.lunchStart}–${p.lunchEnd}: keep it free.` : '- No fixed lunch break.',
    p.focusTime === 'none' ? '- No preferred focus time.' : `- Best focus time: ${p.focusTime}. Put demanding work there.`,
    `- Work blocks: usually ${p.blockMinutes} min, at most ${p.maxBlockMinutes} min, with ${p.breakMinutes} min between blocks.`,
    `- Keep ${p.meetingBuffer} min clear before and after meetings.`,
  ];
  if (p.notes.trim()) lines.push(`- In their own words: ${p.notes.trim().replace(/\s*\n\s*/g, ' / ')}`);
  return `About the user (from their settings; follow it when planning):\n${lines.join('\n')}`;
}

export const buildSystem = (tz, profile) => `${instructions(tz)}\n\n${profileText(profile)}`;

// ---------------------------------------------------------------------------
// Tool definitions: what Claude sees (same as desktop). The descriptions matter: they're
// how Claude knows when and how to use each tool. Order is fixed (it's part of the
// cached prompt).
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List the user\'s calendars with ids, names and whether they are editable.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_events',
    description: `List events in a date range (inclusive, at most ${MAX_RANGE_DAYS} days) across the user's calendars. Use it to answer questions about the schedule and to find event ids before editing or deleting.`,
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
    description: 'Create a calendar event. To block time for a task, pass its task_id and list_id.',
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
        task_id: { type: 'string', description: 'Google Task this block is for (from list_tasks)' },
        list_id: { type: 'string', description: 'That task\'s list_id' },
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
  {
    name: 'list_tasks',
    description: `List the user's Google Tasks due in a date range (inclusive, at most ${MAX_RANGE_DAYS} days; default today..7 days ahead). Unfinished overdue tasks are always included. Set include_undated to also get open tasks without a due date (do this when planning).`,
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Last day (inclusive), YYYY-MM-DD' },
        include_undated: { type: 'boolean' },
        include_completed: { type: 'boolean', description: 'Also list ticked-off tasks (default false)' },
      },
    },
  },
  {
    name: 'create_task',
    description: 'Add a Google Task. Tasks have a due date but no time.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD; omit for no due date' },
        notes: { type: 'string' },
        list_id: { type: 'string', description: 'Defaults to the user\'s default list' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Change a task: rename, move its due date, edit notes, or mark it done / not done. Only pass what changes.',
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        task_id: { type: 'string' },
        title: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, or "none" to remove the due date' },
        notes: { type: 'string' },
        completed: { type: 'boolean' },
      },
      required: ['list_id', 'task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task. It is removed right away; the user can undo for a few seconds.',
    input_schema: {
      type: 'object',
      properties: {
        list_id: { type: 'string' },
        task_id: { type: 'string' },
        title: { type: 'string', description: 'Task title, shown in the Undo message' },
      },
      required: ['list_id', 'task_id', 'title'],
    },
  },
  {
    name: 'find_free_time',
    description: 'Free time within the user\'s working hours (from their profile), after removing events, meeting buffers, lunch and time already past. Use it to plan time blocks.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day, YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Last day (inclusive), YYYY-MM-DD' },
        min_minutes: { type: 'integer', description: 'Shortest gap worth listing (default 30)' },
        include_non_work_days: { type: 'boolean', description: 'Also check days that are not working days (e.g. the user asked about the weekend)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
];

// ---------------------------------------------------------------------------
// Short ids. Google calendar and task-list ids are long and repeat on every item, so
// Claude sees c1, c2… and l1, l2… instead; we translate back. The table is saved with
// the conversation (D1), because each message is a separate request to the Worker.
// ---------------------------------------------------------------------------

class Aliases {
  constructor(saved = {}) {
    this.fwd = { cal: new Map(saved.cal || []), list: new Map(saved.list || []) };
    this.back = { cal: new Map(), list: new Map() };
    for (const kind of ['cal', 'list']) for (const [id, alias] of this.fwd[kind]) this.back[kind].set(alias, id);
  }
  short(kind, id) {
    if (!id) return id;
    if (!this.fwd[kind].has(id)) {
      const alias = `${kind === 'cal' ? 'c' : 'l'}${this.fwd[kind].size + 1}`;
      this.fwd[kind].set(id, alias);
      this.back[kind].set(alias, id);
    }
    return this.fwd[kind].get(id);
  }
  /** Alias → real id. Real ids (or 'primary') pass through unchanged. */
  long(kind, id) { return (id && this.back[kind].get(id)) || id; }
  toJSON() { return { cal: [...this.fwd.cal], list: [...this.fwd.list] }; }
}

// ---------------------------------------------------------------------------
// Tool implementations: what actually runs when Claude calls a tool.
//   t = { c, aliases, queueDelete, hidden, hiddenTasks }
// ---------------------------------------------------------------------------

/** Inclusive YYYY-MM-DD range → days and instants, capped at MAX_RANGE_DAYS. */
function dayRange(c, startDate, endDate) {
  const fromDay = String(startDate || '').slice(0, 10);
  const lastDay = String(endDate || startDate || '').slice(0, 10);
  if (!YMD.test(fromDay) || !YMD.test(lastDay)) throw new Error(`Dates should look like 2026-11-24, got "${startDate}"${endDate ? ` / "${endDate}"` : ''}.`);
  if (lastDay < fromDay) throw new Error('end_date must not be before start_date.');
  const toDay = addDaysYmd(lastDay, 1); // make the end day inclusive
  const days = Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 864e5);
  if (days > MAX_RANGE_DAYS) throw new Error(`That range is too long; ask for at most ${MAX_RANGE_DAYS} days at a time.`);
  return { fromDay, toDay, from: localMidnight(fromDay, c.tz), to: localMidnight(toDay, c.tz) };
}

const stamp = (c, iso, dateOnly = false) => localStamp(new Date(iso), c.tz, dateOnly);
const dueStamp = (c, due) => (due ? localStamp(localMidnight(due, c.tz), c.tz, true) : null);
// The last day of an all-day event (its end is the exclusive next midnight).
const lastDayStamp = (c, endIso) => localStamp(new Date(new Date(endIso).getTime() - 12 * 3600e3), c.tz, true);

async function runTool(t, name, input) {
  const { c, aliases } = t;
  switch (name) {
    case 'list_calendars':
      return (await calendar.listCalendars(c)).map((cal) => ({
        calendar_id: aliases.short('cal', cal.id), name: cal.name, ...(cal.primary ? { primary: true } : {}), ...(cal.canEdit ? {} : { read_only: true }),
      }));

    case 'list_events': {
      const { from, to } = dayRange(c, input.start_date, input.end_date);
      const events = (await calendar.listEvents(c, from, to)).filter((e) => !t.hidden.has(`${e.calendarId}|${e.id}`));
      // Compact, local-time data (no colors or links; only the fields Claude needs).
      return events.map((e) => ({
        event_id: e.id,
        calendar_id: aliases.short('cal', e.calendarId),
        calendar: e.calendarName,
        title: e.title,
        ...(e.allDay ? { all_day: true } : {}),
        start: stamp(c, e.start, e.allDay),
        end: e.allDay ? lastDayStamp(c, e.end) : stamp(c, e.end),
        ...(e.location ? { location: e.location } : {}),
        ...(e.canEdit ? {} : { read_only: true }),
        ...(e.taskLink ? { for_task: true } : {}),
      }));
    }

    case 'create_event': {
      const extras = {};
      let description = input.description;
      if (input.task_id && input.list_id) {
        extras.taskLink = `${aliases.long('list', input.list_id)}|${input.task_id}`;
        description = [input.description, `Time block for task: ${input.title}`].filter(Boolean).join('\n\n');
        const color = normalizeProfile(c.prefs.userProfile).blockColorId;
        if (color) extras.colorId = color;
      }
      return calendar.createEvent(c, {
        calendarId: aliases.long('cal', input.calendar_id) || 'primary',
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: !!input.all_day,
        location: input.location,
        description,
        ...extras,
      });
    }

    case 'update_event': {
      const calendarId = aliases.long('cal', input.calendar_id);
      let { start, end, all_day: allDay } = input;
      if (start !== undefined && (end === undefined || allDay === undefined)) {
        // Moving an event: look it up so we can keep its duration / all-day-ness.
        const current = await calendar.getEvent(c, { calendarId, eventId: input.event_id });
        const wasAllDay = !!current.start.date;
        if (allDay === undefined) allDay = wasAllDay;
        if (end === undefined && !allDay && !wasAllDay) {
          const ms = new Date(current.end.dateTime) - new Date(current.start.dateTime);
          end = new Date(parseTime(start, c.tz).getTime() + ms).toISOString();
        }
      }
      return calendar.updateEvent(c, {
        calendarId,
        eventId: input.event_id,
        title: input.title,
        start, end, allDay,
        location: input.location,
        description: input.description,
      });
    }

    case 'delete_event': {
      // No dialog: hide it now; the /api/chat handler starts the Undo countdown.
      const calendarId = aliases.long('cal', input.calendar_id);
      const token = await t.queueDelete({ calendarId, eventId: input.event_id });
      t.hidden.add(`${calendarId}|${input.event_id}`);
      return { deleted: true, undoToken: token };
    }

    case 'list_tasks': {
      const start = input.start_date || ymdIn(new Date(), c.tz);
      const { fromDay, toDay } = dayRange(c, start, input.end_date || addDaysYmd(String(start).slice(0, 10), 7));
      const list = (await tasks.listTasks(c, {
        fromDay, toDay,
        includeOverdue: true,
        includeUndated: !!input.include_undated,
        includeCompleted: !!input.include_completed,
      })).filter((x) => !t.hiddenTasks.has(`${x.listId}|${x.id}`));
      return list.map((x) => ({
        task_id: x.id,
        list_id: aliases.short('list', x.listId),
        title: x.title,
        due: dueStamp(c, x.due),
        ...(x.overdue ? { overdue: true } : {}),
        ...(x.completed ? { done: true } : {}),
        ...(x.notes ? { notes: x.notes.length > 200 ? `${x.notes.slice(0, 200)}…` : x.notes } : {}),
      }));
    }

    case 'create_task':
      return tasks.createTask(c, { title: input.title, notes: input.notes, due: input.due_date || null, listId: aliases.long('list', input.list_id) });

    case 'update_task':
      return tasks.updateTask(c, {
        listId: aliases.long('list', input.list_id),
        taskId: input.task_id,
        title: input.title,
        notes: input.notes,
        // "none" (or an empty string) removes the due date; leaving it out keeps it.
        due: input.due_date === undefined ? undefined : (/^(none|null)?$/i.test(String(input.due_date).trim()) ? null : input.due_date),
        completed: input.completed,
      });

    case 'delete_task': {
      const listId = aliases.long('list', input.list_id);
      const token = await t.queueDelete({ kind: 'task', listId, taskId: input.task_id });
      t.hiddenTasks.add(`${listId}|${input.task_id}`);
      return { deleted: true, undoToken: token };
    }

    case 'find_free_time': {
      const { from, to, fromDay, toDay } = dayRange(c, input.start_date, input.end_date);
      const events = (await calendar.listEvents(c, from, to)).filter((e) => !t.hidden.has(`${e.calendarId}|${e.id}`));
      const profile = normalizeProfile(c.prefs.userProfile);
      const days = freeSlotsInZone(c.tz, {
        fromDay, toDay, events, profile,
        minMinutes: Math.max(5, Number(input.min_minutes) || 30),
        anyDay: !!input.include_non_work_days,
      });
      return {
        working_hours: `${profile.dayStart}-${profile.dayEnd}`,
        days: days.map((d) => ({ date: `${d.date} (${d.weekday})`, free: d.slots.map((s) => `${s.start}-${s.end}`) })),
      };
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/**
 * freetime.js (copied unchanged from the desktop app) works in "local time". A Worker's
 * local time is UTC, so we hand it every time as the phone's WALL CLOCK dressed up as
 * UTC (tz.toWall): 9:00 in Chicago becomes 09:00 UTC. Its answers ('09:00-12:00' on
 * '2026-11-24') are then the phone's own times, daylight saving included.
 */
export function freeSlotsInZone(tz, { fromDay, toDay, events, profile, minMinutes, anyDay, now = new Date() }) {
  const wallDay = (ymd) => new Date(`${ymd}T00:00:00Z`);
  return freeSlots({
    from: wallDay(fromDay),
    to: wallDay(toDay),
    events: events.map((e) => ({ start: toWall(new Date(e.start), tz), end: toWall(new Date(e.end), tz), allDay: e.allDay })),
    profile,
    now: toWall(now, tz),
    minMinutes,
    anyDay,
  });
}

// ---------------------------------------------------------------------------
// Usage and cost
// ---------------------------------------------------------------------------

const ZERO = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const readUsage = (u = {}) => ({
  input: u.input_tokens || 0,
  cacheWrite: u.cache_creation_input_tokens || 0,
  cacheRead: u.cache_read_input_tokens || 0,
  output: u.output_tokens || 0,
});
const addUsage = (a, b) => ({ input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output });

/** US$ for a usage total (MODELS[].price is per million tokens). */
export function costOf(usage, model) {
  const price = MODELS[model]?.price;
  if (!price) return null;
  return (usage.input * price.in + usage.cacheWrite * price.in * CACHE_WRITE_MULTIPLIER
    + usage.cacheRead * price.cacheRead + usage.output * price.out) / 1e6;
}

const monthKey = () => new Date().toISOString().slice(0, 7);

/** Running total for this month, saved with your settings (no secrets in it). */
async function recordUsage(c, usage, cost, requests) {
  const prev = c.prefs.assistantUsage;
  const cur = prev && prev.month === monthKey() ? prev : { month: monthKey(), cost: 0, messages: 0, requests: 0, tokens: { ...ZERO } };
  const next = {
    month: cur.month,
    cost: cur.cost + (cost || 0),
    messages: cur.messages + 1,
    requests: cur.requests + requests,
    tokens: addUsage(cur.tokens, usage),
    last: { ...usage, cost, requests },
  };
  c.prefs = await patchPrefs(c.env.DB, c.email, { assistantUsage: next });
  return next;
}

export function currentUsage(prefs) {
  const u = prefs.assistantUsage;
  return u && u.month === monthKey() ? u : null;
}

// ---------------------------------------------------------------------------
// The conversation (saved in D1, one per account)
// ---------------------------------------------------------------------------

/** Saved form: { v: 2, messages, aliases, userTurns }. Older rows (a bare array) start fresh. */
async function loadChat(c) {
  const row = await c.env.DB.prepare('SELECT model, messages, updated_at FROM chats WHERE email = ?').bind(c.email).first();
  if (!row) return null;
  try {
    const saved = JSON.parse(row.messages);
    if (saved?.v !== 2) return null;
    return { model: row.model, updatedAt: row.updated_at, size: row.messages.length, ...saved };
  } catch { return null; }
}

async function saveChat(c, model, chat) {
  const json = JSON.stringify({ v: 2, messages: chat.messages, aliases: chat.aliases.toJSON(), userTurns: chat.userTurns });
  await c.env.DB.prepare(`INSERT INTO chats (email, model, messages, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(email) DO UPDATE SET model = ?2, messages = ?3, updated_at = ?4`)
    .bind(c.email, model, json, Date.now()).run();
}

export async function reset(c) {
  await c.env.DB.prepare('DELETE FROM chats WHERE email = ?').bind(c.email).run();
  return true;
}

/** For Settings: models, the About-you profile and this month's spending. */
export function getSettings(c) {
  return {
    current: currentModel(c),
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
    profile: normalizeProfile(c.prefs.userProfile),
    profileDefaults: PROFILE_DEFAULTS,
    usage: currentUsage(c.prefs),
  };
}

// Local testing with the fake calendar and no key → the scripted stand-in in mock-claude.js.
const useMockClaude = (env) => env.MOCK_GOOGLE === '1' && !env.ANTHROPIC_API_KEY;
export const hasKey = (env) => !!env.ANTHROPIC_API_KEY || useMockClaude(env);

/**
 * Send one user message and run the tool loop until Claude gives a final answer.
 *   queueDelete(item): hides an event ({ calendarId, eventId }) or a task
 *                      ({ kind: 'task', listId, taskId }) and queues its deletion; returns a token
 *   hidden / hiddenTasks: Sets of "calendarId|eventId" / "listId|taskId" already pending deletion
 * Returns { reply, actions, usage, cost, requests, freshStart }:
 *   actions     what changed, for the little cards in the chat
 *   usage/cost  tokens used by this message (all its requests) and US$
 *   freshStart  true when this message started a new conversation (idle or too long)
 */
export async function send(c, text, { queueDelete, hidden, hiddenTasks }) {
  if (!hasKey(c.env)) throw new HttpError(503, 'The Claude API key hasn\'t been added to the Worker yet (ANTHROPIC_API_KEY).', 'NO_KEY');
  text = String(text || '').trim();
  if (!text) throw badRequest('Type a message first.');
  if (text.length > 4000) throw badRequest('That message is too long.');

  const claude = useMockClaude(c.env)
    ? new Anthropic({ apiKey: 'mock', fetch: mockClaudeFetch, maxRetries: 0 })
    : new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const model = currentModel(c);
  const { effort, fallback } = MODELS[model];

  // A conversation stays on one model, and restarts after a long pause or many messages
  // to keep requests small.
  const saved = await loadChat(c);
  const stale = !!saved?.messages?.length && (Date.now() - saved.updatedAt > IDLE_RESET_MS
    || saved.userTurns >= MAX_USER_TURNS || saved.size > MAX_HISTORY_CHARS);
  const keep = saved && saved.model === model && !stale;
  const chat = {
    messages: keep ? saved.messages : [],
    aliases: new Aliases(keep ? saved.aliases : {}),
    userTurns: keep ? saved.userTurns : 0,
  };

  const turn = { c, aliases: chat.aliases, queueDelete, hidden, hiddenTasks, actions: [] };
  let usage = { ...ZERO };
  let requests = 0;
  chat.messages.push({ role: 'user', content: `[Now: ${localStamp(new Date(), c.tz)}, ${c.tz}]\n${text}` });

  // Caching: a breakpoint on the system prompt caches tools + system (the big, fixed
  // part), and top-level automatic caching moves a second breakpoint along the growing
  // conversation, so each tool round trip re-reads earlier turns at ~10% of the price.
  const request = {
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: buildSystem(c.tz, c.prefs.userProfile), cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages: chat.messages,
    output_config: { effort },
    cache_control: { type: 'ephemeral' },
  };

  const finish = async (reply) => {
    chat.userTurns++;
    await saveChat(c, model, chat);
    const cost = costOf(usage, model);
    await recordUsage(c, usage, cost, requests);
    return { reply, actions: turn.actions, usage, cost, requests, freshStart: stale };
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = fallback
        ? await claude.beta.messages.create({ ...request, betas: [FALLBACK_BETA], fallbacks: 'default' })
        : await claude.messages.create(request);
      requests++;
      usage = addUsage(usage, readUsage(res.usage));

      if (res.stop_reason === 'refusal') {
        // Nothing from this turn is kept (the saved conversation stays as it was).
        await recordUsage(c, usage, costOf(usage, model), requests);
        return { reply: "Sorry, I can't help with that request.", actions: [], usage, cost: costOf(usage, model), requests, freshStart: stale };
      }

      // Keep Claude's whole reply (text, thinking and tool calls) in history, unchanged.
      chat.messages.push({ role: 'assistant', content: res.content });

      const toolCalls = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || toolCalls.length === 0) {
        const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        return await finish(reply || 'Done.');
      }

      // Run every tool Claude asked for (in parallel), then send ALL results back in one message.
      const results = await Promise.all(toolCalls.map(async (call) => {
        try {
          const output = await runTool(turn, call.name, call.input || {});
          const action = toAction(call.name, call.input || {}, output);
          if (action) turn.actions.push(action);
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(forModel(turn, output) ?? null) };
        } catch (err) {
          if (err.code === 'NOT_SIGNED_IN') throw err;
          // Tell Claude what failed so it can explain or try something else.
          return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: err.message };
        }
      }));
      chat.messages.push({ role: 'user', content: results });
    }
    return await finish('That took too many steps. Could you break it into smaller requests?');
  } catch (err) {
    if (requests) await recordUsage(c, usage, costOf(usage, model), requests).catch(() => {}); // failed turns still cost something
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, friendlyError(err), 'CLAUDE');
  }
}

// ---------------------------------------------------------------------------
// Results → chat cards and model-friendly JSON (same as desktop)
// ---------------------------------------------------------------------------

/** A card for the chat when a tool changed the calendar or a task (or null). */
function toAction(name, input, output) {
  if (name === 'create_event' || name === 'update_event') {
    return { kind: name === 'create_event' ? 'created' : 'updated', ...output };
  }
  if ((name === 'delete_event' || name === 'delete_task') && output?.deleted) {
    return { kind: 'deleted', title: input.title, token: output.undoToken, isTask: name === 'delete_task' };
  }
  if (name === 'create_task') return { kind: 'task-created', id: output.id, title: output.title, due: output.due };
  if (name === 'update_task') {
    const kind = input.completed === true ? 'task-completed' : input.completed === false ? 'task-reopened' : 'task-updated';
    return { kind, id: output.id, title: output.title, due: output.due };
  }
  return null;
}

/** Results trimmed for Claude: no undo tokens, local times, short ids. */
function forModel({ c, aliases }, output) {
  if (output?.undoToken) return { deleted: true }; // the undo token is for the phone, not Claude
  if (output?.kind === 'task') {
    return {
      task_id: output.id, list_id: aliases.short('list', output.listId), title: output.title,
      due: dueStamp(c, output.due), ...(output.completed ? { done: true } : {}),
    };
  }
  if (!output?.start || !output.id) return output;
  return {
    event_id: output.id,
    title: output.title,
    ...(output.allDay ? { all_day: true } : {}),
    start: stamp(c, output.start, output.allDay),
    end: output.allDay ? lastDayStamp(c, output.end) : stamp(c, output.end),
    ...(output.meetLink ? { meet_link: output.meetLink } : {}),
  };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Claude API key was rejected. Check ANTHROPIC_API_KEY on the Worker.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting requests. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach Claude right now. Try again shortly.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}
