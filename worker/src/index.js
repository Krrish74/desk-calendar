// index.js: the Worker's front door. Every request and every cron tick starts here.
//
// It plays the role src/main/main.js plays in the desktop app: the list of things the
// phone is allowed to ask the backend to do. Static files (the app itself, from
// ../mobile) are served by Cloudflare before this code runs; only /api/* and /auth/*
// reach it (see run_worker_first in wrangler.toml).
//
// ROUTES
//   GET  /auth/login               → Google sign-in
//   GET  /auth/callback            ← Google sends you back here
//   POST /auth/logout              sign this phone out ({ everywhere: true } = revoke + forget tokens)
//   GET  /auth/dev-login           local testing only (fake calendar), see auth.js
//
//   GET  /api/me                   who's signed in + settings
//   GET  /api/prefs                settings              PATCH /api/prefs  change some
//   GET  /api/calendars            calendars with color/visibility/canEdit
//   PATCH /api/calendars/visibility { id, visible }
//   GET  /api/events?start=&end=   events in [start, end) from visible calendars
//   POST /api/events               create   (title, start, end, allDay, calendarId, location,
//   PATCH /api/events              update    description, colorId, reminders, meet)
//   POST /api/events/delete        { calendarId, eventId } → { token }  (delete with Undo)
//   POST /api/events/undo          { token } → { restored }
//   POST /api/quick/parse          { text } → preview of what quick add would create
//   POST /api/quick/add            { text } → creates it
//   POST /api/chat                 { text } → { reply, actions }  (the assistant)
//   POST /api/chat/reset           start a new conversation
//   GET  /api/chat/models          model picker list
//   POST /api/push/subscribe       turn reminders on for this device (a PushSubscription)
//   POST /api/push/unsubscribe     { endpoint } → off for this device
//   POST /api/push/test            send a test reminder to every device
//   GET/PATCH /api/sync            the Windows app reads/saves the shared settings (sync.js;
//                                  Google-token auth instead of the cookie)
//
// EVERY /api REQUEST
//   • must carry the session cookie (else 401 { code: 'NOT_SIGNED_IN' })
//   • may send X-Time-Zone: America/New_York (the phone's zone; remembered for reminders)
//   • if it changes something (POST/PATCH), must send "X-Desk-Calendar: 1" and, when the
//     browser sends an Origin, come from this same site. Other websites can't add custom
//     headers to requests without our permission, so this blocks cross-site request forgery.

import { HttpError, json, errorResponse, readJson, badRequest } from './http.js';
import * as auth from './auth.js';
import * as calendar from './calendar.js';
import * as quickadd from './quickadd.js';
import * as assistant from './assistant.js';
import * as tasks from './tasks.js';
import * as sync from './sync.js';
import * as deletes from './deletes.js';
import * as reminders from './reminders.js';
import { getPrefs, setPrefs } from './prefs.js';
import { safeTimeZone, ymdIn } from './tz.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // The fake calendar must never be served from a real deployment.
      if (env.MOCK_GOOGLE === '1' && !auth.isLocalDev(url)) {
        throw new HttpError(500, 'MOCK_GOOGLE is on: that only works on localhost. Remove it from the deployed Worker.');
      }
      if (url.pathname.startsWith('/auth/')) return await authRoute(request, env, url);
      if (url.pathname.startsWith('/api/')) return await apiRoute(request, env, ctx, url);
      return env.ASSETS.fetch(request); // anything else: a static file
    } catch (err) {
      return errorResponse(err);
    }
  },

  // Cron (every minute): finish deletes whose Undo window has passed, and send reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(deletes.runDue(env).catch((err) => console.error('[cron] deletes:', err.message)));
    ctx.waitUntil(reminders.runReminders(env, event.scheduledTime || Date.now())
      .catch((err) => console.error('[cron] reminders:', err.message)));
  },
};

// ---------------------------------------------------------------------------
// /auth/*
// ---------------------------------------------------------------------------

async function authRoute(request, env, url) {
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /auth/login': return auth.login(request, env);
    case 'GET /auth/callback': return auth.callback(request, env);
    case 'GET /auth/dev-login': return auth.devLogin(request, env);
    case 'POST /auth/logout': {
      checkCsrf(request, url);
      const body = await readJson(request);
      return auth.logout(request, env, { everywhere: body.everywhere === true });
    }
    default: throw new HttpError(404, 'Not found.');
  }
}

// ---------------------------------------------------------------------------
// /api/*
// ---------------------------------------------------------------------------

function checkCsrf(request, url) {
  if (request.headers.get('X-Desk-Calendar') !== '1') throw new HttpError(403, 'Missing X-Desk-Calendar header.');
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked.');
}

async function apiRoute(request, env, ctx, url) {
  const writes = request.method !== 'GET' && request.method !== 'HEAD';
  if (writes) checkCsrf(request, url);

  // The Windows app's settings sync: authenticated with its Google token, not a cookie,
  // and limited to these two routes (see sync.js).
  if (url.pathname === '/api/sync') {
    const bearer = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
    const email = await sync.desktopEmail(env, bearer, url);
    const prefs = await getPrefs(env.DB, email);
    const c = { env, email, tz: safeTimeZone(prefs.timeZone), prefs, waitUntil: (p) => ctx.waitUntil(p) };
    if (request.method === 'GET') return json(await sync.getShared(c));
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      const result = await sync.setShared(c, body);
      if (body.userProfile) await assistant.reset(c); // new profile → fresh assistant chat (as on the phone)
      return json(result);
    }
    throw new HttpError(405, 'Use GET or PATCH.');
  }

  const session = await auth.requireSession(request, env);
  const c = await context(request, env, ctx, session.email);
  const res = await handleApi(request, c, url);
  if (session.renewCookie) res.headers.append('Set-Cookie', session.renewCookie);
  return res;
}

/** The per-request context every module receives: who, which time zone, which settings. */
async function context(request, env, ctx, email) {
  let prefs = await getPrefs(env.DB, email);
  const header = request.headers.get('X-Time-Zone');
  const tz = header ? safeTimeZone(header) : safeTimeZone(prefs.timeZone);
  // Remember the phone's zone so background jobs (reminders) can format times for you.
  if (header && tz === header && tz !== prefs.timeZone) prefs = await setPrefs(env.DB, email, { timeZone: tz });
  return { env, email, tz, prefs, waitUntil: (p) => ctx.waitUntil(p) };
}

async function handleApi(request, c, url) {
  const route = `${request.method} ${url.pathname}`;
  const body = request.method === 'POST' || request.method === 'PATCH' ? await readJson(request) : {};

  switch (route) {
    // --- account & settings ---
    case 'GET /api/me':
      return json({
        email: c.email,
        prefs: c.prefs,
        timeZone: c.tz,
        assistantReady: assistant.hasKey(c.env),
        sample: c.env.MOCK_GOOGLE === '1', // true = fake calendar (local testing)
        push: { ...reminders.pushConfig(c.env), devices: await reminders.deviceCount(c) },
        tasks: { connected: await tasks.hasTasksScope(c) }, // false = offer "Connect Google Tasks"
      });
    case 'GET /api/prefs':
      return json(c.prefs);
    case 'PATCH /api/prefs': {
      const saved = await setPrefs(c.env.DB, c.email, body);
      // A new profile changes the assistant's instructions: start a fresh conversation (as on desktop).
      if (body.userProfile) await assistant.reset(c);
      return json(saved);
    }

    // --- calendars ---
    case 'GET /api/calendars':
      return json(await calendar.listCalendars(c, { fresh: url.searchParams.get('fresh') === '1' }));
    case 'PATCH /api/calendars/visibility':
      if (typeof body.id !== 'string' || typeof body.visible !== 'boolean') throw badRequest('Send { id, visible }.');
      return json(await calendar.setCalendarVisible(c, body.id, body.visible));

    // --- events ---
    // Events in [start, end) from every visible calendar. The phone asks for whatever
    // range the current view shows, plus today/tomorrow for the countdown.
    case 'GET /api/events': {
      const start = new Date(url.searchParams.get('start'));
      const end = new Date(url.searchParams.get('end'));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw badRequest('Send ?start=ISO&end=ISO.');
      if (end - start > 100 * 24 * 3600e3) throw badRequest('Ask for at most 100 days at a time.');
      const [events, hidden] = await Promise.all([calendar.listEvents(c, start, end), deletes.pendingKeys(c)]);
      // Events waiting out their "Undo" window stay hidden even though Google still has them.
      return json(events.filter((e) => !hidden.has(`${e.calendarId}|${e.id}`)));
    }
    case 'POST /api/events':
      return json(await calendar.createEvent(c, eventInput(body, { create: true })));
    case 'PATCH /api/events':
      return json(await calendar.updateEvent(c, eventInput(body, { create: false })));

    // --- delete with Undo (see deletes.js) ---
    case 'POST /api/events/delete': {
      const { calendarId, eventId } = ids(body);
      return json({ token: await deletes.queueDelete(c, { calendarId, eventId }), undoMs: deletes.UNDO_MS });
    }
    case 'POST /api/events/undo':
      if (typeof body.token !== 'string') throw badRequest('Send { token }.');
      return json({ restored: await deletes.cancelDelete(c, body.token) });

    // --- quick add ---
    case 'POST /api/quick/parse':
      return json(await parseQuick(c, quickText(body)));
    case 'POST /api/quick/add': {
      const parsed = await parseQuick(c, quickText(body));
      if (!parsed) throw badRequest("Couldn't find a date/time in that. Try e.g. \"gym tomorrow 6pm\".");
      const created = await calendar.createEvent(c, parsed);
      // Tell the phone where the new event is, so it can jump there and highlight it.
      return json({ ...created, calendarId: parsed.calendarId, calendarName: parsed.calendarName });
    }

    // --- assistant ---
    // Assistant deletes don't ask first: the event is hidden right away, and the Undo
    // window starts as this reply goes out, so you have time to see it.
    case 'POST /api/chat': {
      assistant.checkLimits(c); // spending cap and messages-per-minute (assistant.js)
      const queued = [];
      const queueDelete = async (ev) => { const t = await deletes.queueDelete(c, ev, { startNow: false }); queued.push(t); return t; };
      const [hidden, hiddenTasks] = await Promise.all([deletes.pendingKeys(c), deletes.pendingTaskKeys(c)]);
      let result;
      try {
        result = await assistant.send(c, body.text, { queueDelete, hidden, hiddenTasks });
      } catch (err) {
        await deletes.cancelDeletes(c, queued); // the turn failed: don't delete anything behind your back
        throw err;
      }
      const reported = new Set(result.actions.filter((a) => a.kind === 'deleted').map((a) => a.token));
      await deletes.startDeleteTimers(c, queued.filter((t) => reported.has(t)));
      await deletes.cancelDeletes(c, queued.filter((t) => !reported.has(t)));
      return json({ ...result, undoMs: deletes.ASSISTANT_UNDO_MS });
    }
    case 'POST /api/chat/reset':
      return json(await assistant.reset(c));
    case 'GET /api/chat/models': // models, the About-you profile and this month's spending
      return json(assistant.getSettings(c));

    // --- Google Tasks (see tasks.js) ---
    case 'GET /api/tasks/lists':
      return json(await tasks.listTaskLists(c, { fresh: url.searchParams.get('fresh') === '1' }));
    case 'PATCH /api/tasks/lists/visibility':
      if (typeof body.id !== 'string' || typeof body.visible !== 'boolean') throw badRequest('Send { id, visible }.');
      return json(await tasks.setListVisible(c, body.id, body.visible));
    // ?from=YYYY-MM-DD&to=YYYY-MM-DD (to is exclusive) &overdue=1 &undated=1 &completed=0
    case 'GET /api/tasks': {
      const q = url.searchParams;
      const fromDay = q.get('from'), toDay = q.get('to');
      if ((fromDay || toDay) && !(YMD.test(fromDay) && YMD.test(toDay) && toDay > fromDay)) throw badRequest('Send ?from=YYYY-MM-DD&to=YYYY-MM-DD.');
      if (fromDay && Date.parse(toDay) - Date.parse(fromDay) > 100 * 864e5) throw badRequest('Ask for at most 100 days at a time.');
      const [list, hiddenTasks] = await Promise.all([tasks.listTasks(c, {
        fromDay: fromDay || undefined, toDay: toDay || undefined,
        includeOverdue: q.get('overdue') === '1', includeUndated: q.get('undated') === '1', includeCompleted: q.get('completed') !== '0',
      }), deletes.pendingTaskKeys(c)]);
      // Tasks waiting out their Undo window stay hidden.
      return json(list.filter((t) => !hiddenTasks.has(`${t.listId}|${t.id}`)));
    }
    case 'POST /api/tasks':
      return json(await tasks.createTask(c, taskInput(body, { create: true })));
    case 'PATCH /api/tasks':
      return json(await tasks.updateTask(c, taskInput(body, { create: false })));
    case 'POST /api/tasks/delete': {
      const { listId, taskId } = taskInput(body, { create: false });
      return json({ token: await deletes.queueDelete(c, { kind: 'task', listId, taskId }), undoMs: deletes.UNDO_MS });
    }
    // "call mom friday" → { title: 'Call mom', due: '2026-11-27', dateFound }. No date → due today.
    case 'POST /api/tasks/parse':
      return json(parseTask(c, quickText(body)));

    // --- reminders (push notifications, see reminders.js) ---
    case 'POST /api/push/subscribe':
      return json(await reminders.subscribe(c, body, {
        origin: url.origin,
        userAgent: request.headers.get('User-Agent'),
        allowLocal: c.env.MOCK_GOOGLE === '1' && auth.isLocalDev(url), // a local fake push service, for testing
      }));
    case 'POST /api/push/unsubscribe':
      return json(await reminders.unsubscribe(c, body.endpoint));
    case 'POST /api/push/test':
      return json(await reminders.sendTest(c));

    default:
      throw new HttpError(404, 'Not found.');
  }
}

// ---------------------------------------------------------------------------
// Input checks: only known fields of the right type get through to Google.
// ---------------------------------------------------------------------------

const str = (v, max) => typeof v === 'string' && v.length <= max;

function ids(body) {
  if (!str(body.calendarId, 300) || !body.calendarId || !str(body.eventId, 1024) || !body.eventId) {
    throw badRequest('Send { calendarId, eventId }.');
  }
  return { calendarId: body.calendarId, eventId: body.eventId };
}

function eventInput(body, { create }) {
  const out = create ? { calendarId: str(body.calendarId, 300) && body.calendarId ? body.calendarId : 'primary' } : ids(body);
  const optionalText = { title: 500, location: 1000, description: 8000 };
  for (const [key, max] of Object.entries(optionalText)) {
    if (body[key] === undefined) continue;
    if (!str(body[key], max)) throw badRequest(`"${key}" must be text (max ${max} characters).`);
    out[key] = body[key];
  }
  if (create && !out.title?.trim()) out.title = '(No title)';
  if (body.start !== undefined || create) {
    if (!str(body.start, 40) || !body.start) throw badRequest('"start" is required.');
    if (body.end !== undefined && body.end !== null && !str(body.end, 40)) throw badRequest('"end" must be a date/time.');
    out.start = body.start;
    out.end = body.end || undefined;
    out.allDay = body.allDay === true;
  }
  if (body.colorId !== undefined) {
    if (!(body.colorId === '' || /^([1-9]|1[01])$/.test(String(body.colorId)))) throw badRequest('"colorId" must be "" or "1"–"11".');
    out.colorId = String(body.colorId);
  }
  if (body.reminders !== undefined) {
    const ok = body.reminders === 'default' || (Array.isArray(body.reminders) && body.reminders.length <= 5
      && body.reminders.every((m) => Number.isInteger(m) && m >= 0 && m <= 40320));
    if (!ok) throw badRequest('"reminders" must be "default" or up to 5 minute values (0–40320).');
    out.reminders = body.reminders;
  }
  if (body.meet !== undefined) {
    if (!['add', 'remove'].includes(body.meet)) throw badRequest('"meet" must be "add" or "remove".');
    out.meet = body.meet;
  }
  return out;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Task fields from the phone: { listId, taskId, title, notes, due ('YYYY-MM-DD' | null), completed }. */
function taskInput(body, { create }) {
  const out = {};
  if (!create) {
    if (!str(body.listId, 300) || !body.listId || !str(body.taskId, 300) || !body.taskId) throw badRequest('Send { listId, taskId }.');
    out.listId = body.listId;
    out.taskId = body.taskId;
  } else if (body.listId !== undefined) {
    if (!str(body.listId, 300)) throw badRequest('"listId" must be text.');
    out.listId = body.listId || undefined;
  }
  for (const [key, max] of Object.entries({ title: 1024, notes: 8192 })) {
    if (body[key] === undefined) continue;
    if (!str(body[key], max)) throw badRequest(`"${key}" must be text (max ${max} characters).`);
    out[key] = body[key];
  }
  if (body.due !== undefined) {
    if (body.due !== null && !YMD.test(String(body.due))) throw badRequest('"due" must be YYYY-MM-DD or null.');
    out.due = body.due;
  }
  if (body.completed !== undefined) {
    if (typeof body.completed !== 'boolean') throw badRequest('"completed" must be true or false.');
    out.completed = body.completed;
  }
  return out;
}

/** Same parser as quick add; a task keeps only the DATE (tasks have no times). */
function parseTask(c, text) {
  const p = quickadd.parse(text, { tz: c.tz, defaultMinutes: c.prefs.defaultEventMinutes });
  if (!p || !p.title) return { title: String(text || '').trim(), due: ymdIn(new Date(), c.tz), dateFound: false };
  return { title: p.title, due: p.allDay ? p.start : ymdIn(new Date(p.start), c.tz), dateFound: true };
}

function quickText(body) {
  if (!str(body.text, 500)) throw badRequest('Send { text } (max 500 characters).');
  return body.text;
}

/**
 * Parse quick-add text and pick its calendar: a "#tag" is matched against the names
 * of calendars you can write to (exact name, then starts-with, then contains,
 * ignoring case). No tag, or no match → your default calendar (Settings), else primary.
 */
async function parseQuick(c, text) {
  const parsed = quickadd.parse(text, { tz: c.tz, defaultMinutes: c.prefs.defaultEventMinutes });
  if (!parsed) return null;
  const writable = (await calendar.listCalendars(c)).filter((cal) => cal.canEdit);
  const primary = writable.find((cal) => cal.id === c.prefs.defaultCalendarId)
    || writable.find((cal) => cal.primary) || writable[0];
  let cal = primary;
  let tagUnmatched = false;
  if (parsed.calendarTag) {
    const tag = parsed.calendarTag.toLowerCase();
    const name = (x) => x.name.toLowerCase();
    cal = writable.find((x) => name(x) === tag)
      || writable.find((x) => name(x).startsWith(tag))
      || writable.find((x) => name(x).includes(tag));
    if (!cal) { cal = primary; tagUnmatched = true; }
  }
  return { ...parsed, calendarId: cal?.id || 'primary', calendarName: cal?.name || '', calendarColor: cal?.color || '', tagUnmatched };
}
