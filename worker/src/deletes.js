// deletes.js: delete with Undo (ported from queueDelete/startDeleteTimer/cancelDelete
// in src/main/main.js).
//
// Deleting doesn't call Google right away. The event is queued in D1 and hidden from
// the event list, and the real delete happens UNDO_MS later unless you tap "Undo".
// Undo just removes the queue row, so the event comes back exactly as it was
// (guests, Meet link, everything).
//
// WHO RUNS THE DELETE WHEN TIME'S UP?
// A Worker has no long-running process, so two things do:
//   1. The request that started the countdown keeps running in the background
//      (ctx.waitUntil) for UNDO_MS, then deletes. This is the normal path.
//   2. The every-minute cron (index.js → sweep) deletes anything overdue, in case #1
//      was cut short.
// Both "claim" a row with one atomic DELETE … RETURNING, so an event is never deleted
// twice, and an Undo that arrives first always wins.
//
// Assistant deletes are queued with due_at = NULL (no countdown yet). The countdown
// starts when the reply is sent to the phone, so you have time to see it and undo.
//
// Google Tasks use the same queue (kind = 'task'; the list id and task id are stored in
// the calendar_id / event_id columns), exactly like the desktop app's main.js.

import * as calendar from './calendar.js';
import * as tasks from './tasks.js';
import { getPrefs } from './prefs.js';
import { safeTimeZone } from './tz.js';

export const UNDO_MS = 6000;
// Assistant deletes: a longer window, since you first have to read the reply to notice one.
export const ASSISTANT_UNDO_MS = 20000;
const ABANDON_MS = 10 * 60 * 1000; // assistant-queued deletes whose reply never went out

/**
 * Hide an event ({ calendarId, eventId }) or a task ({ kind: 'task', listId, taskId }) and
 * queue its deletion. Returns the undo token.
 */
export async function queueDelete(c, item, { startNow = true } = {}) {
  const isTask = item.kind === 'task';
  const token = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO pending_deletes (token, email, kind, calendar_id, event_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(token, c.email, isTask ? 'task' : 'event', isTask ? item.listId : item.calendarId, isTask ? item.taskId : item.eventId,
      startNow ? now + UNDO_MS : null, now).run();
  if (startNow) c.waitUntil(runLater(c.env, token));
  return token;
}

/** Start the countdown for deletes the assistant queued (one D1 call for all of them). */
export async function startDeleteTimers(c, tokens, ms = ASSISTANT_UNDO_MS) {
  if (!tokens.length) return;
  const due = Date.now() + ms;
  await c.env.DB.batch(tokens.map((t) =>
    c.env.DB.prepare('UPDATE pending_deletes SET due_at = ? WHERE token = ? AND email = ? AND due_at IS NULL').bind(due, t, c.email)));
  for (const t of tokens) c.waitUntil(runLater(c.env, t, ms));
}

/** Undo. Returns false if it's too late (already deleted). */
export async function cancelDelete(c, token) {
  const row = await c.env.DB.prepare('DELETE FROM pending_deletes WHERE token = ? AND email = ? RETURNING token')
    .bind(String(token), c.email).first();
  return !!row;
}

export async function cancelDeletes(c, tokens) {
  if (!tokens.length) return;
  await c.env.DB.batch(tokens.map((t) =>
    c.env.DB.prepare('DELETE FROM pending_deletes WHERE token = ? AND email = ?').bind(t, c.email)));
}

/** "calendarId|eventId" of events waiting out their Undo window, to hide from lists. */
export async function pendingKeys(c) {
  const { results } = await c.env.DB.prepare("SELECT calendar_id, event_id FROM pending_deletes WHERE email = ? AND kind = 'event'").bind(c.email).all();
  return new Set(results.map((r) => `${r.calendar_id}|${r.event_id}`));
}

/** "listId|taskId" of tasks waiting out their Undo window. */
export async function pendingTaskKeys(c) {
  const { results } = await c.env.DB.prepare("SELECT calendar_id, event_id FROM pending_deletes WHERE email = ? AND kind = 'task'").bind(c.email).all();
  return new Set(results.map((r) => `${r.calendar_id}|${r.event_id}`));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runLater(env, token, ms = UNDO_MS) {
  await sleep(ms + 300);
  await runDue(env, token);
}

/**
 * Delete what's due. With a token: just that one (if it's due). Without: everything
 * overdue (the cron sweep), plus cleaning up abandoned assistant-queued rows.
 */
export async function runDue(env, token) {
  const now = Date.now();
  const claimed = token
    ? await env.DB.prepare('DELETE FROM pending_deletes WHERE token = ? AND due_at IS NOT NULL AND due_at <= ? RETURNING *').bind(token, now).all()
    : await env.DB.prepare('DELETE FROM pending_deletes WHERE due_at IS NOT NULL AND due_at <= ? RETURNING *').bind(now).all();
  if (!token) {
    await env.DB.prepare('DELETE FROM pending_deletes WHERE due_at IS NULL AND created_at < ?').bind(now - ABANDON_MS).run();
  }

  for (const row of claimed.results) {
    // Background jobs have no request, so build the context from what's stored.
    const prefs = await getPrefs(env.DB, row.email);
    const c = { env, email: row.email, tz: safeTimeZone(prefs.timeZone), prefs, waitUntil: () => {} };
    try {
      if (row.kind === 'task') await tasks.deleteTask(c, { listId: row.calendar_id, taskId: row.event_id });
      else await calendar.deleteEvent(c, { calendarId: row.calendar_id, eventId: row.event_id });
    } catch (err) {
      console.error('[delete] failed:', err.message);
    }
  }
  return claimed.results.length;
}
