// sync.js: keeps some settings the same on this PC and the phone app.
//
// OPTIONAL: does nothing until you enter a phone-app address in Settings → Account.
// The phone app's server (a small Cloudflare Worker, set up separately) holds the shared copy. This
// file reads it when the app starts, every few minutes and when the window comes forward,
// and sends a change there as soon as you make it here. The phone does the same from
// its side, so both follow one set of settings.
//
// SHARED: which calendars and task lists are shown, default calendar and task list,
// default event length, time format, week start, reminder minutes, and "About you".
// PER DEVICE (not shared): reminders on/off, view, window/tray/hotkey options, and the
// assistant's provider, model, keys and conversation.
//
// HOW THE PHONE APP'S SERVER KNOWS IT'S YOU
// No codes or extra sign-in: we send the Google access token this app already has. The
// server asks Google whether the token belongs to the same Google Cloud project and to
// an allowed account.
//
// THE FIRST TIME you link: settings you've already changed on the phone win; for the
// others this PC's values are sent. After that, the most recent change wins.
// Changes made while offline are remembered (prefs.syncDirty) and sent next time.

const { isValid } = require('./prefcheck');

const SHARED_KEYS = [
  'calendarVisibility', 'taskListVisibility', 'defaultCalendarId', 'defaultTaskListId',
  'defaultEventMinutes', 'timeFormat', 'weekStartsOn', 'notifyMinutes', 'userProfile',
];
const PERIOD_MS = 5 * 60 * 1000;   // regular check
const FOCUS_GAP_MS = 30 * 1000;    // at most this often when the window comes forward
const PUSH_DELAY_MS = 1000;        // group quick changes (e.g. several toggles) into one send

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The address must be https (or a local test server on this PC). */
function cleanUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https:\/\/[^\s/]+$/i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u)) {
    throw new Error('Enter the phone app\'s address, like https://desk-calendar.yourname.workers.dev');
  }
  return u;
}

/**
 * Build the sync engine. The parts are passed in so tests can use fakes:
 *   prefs     { get(key), set(changes) } (src/main/prefs.js)
 *   getToken  async () → a Google access token for this app's sign-in
 *   fetch     the fetch function
 *   onApplied (keys) → called after settings changed here because of the phone
 */
function createSync({ prefs, getToken, fetch: fetchFn = globalThis.fetch, onApplied = () => {} }) {
  let timer = null;
  let pushTimer = null;
  let running = null;
  let lastFocusSync = 0;
  let applying = false; // true while we write the server's values (those aren't "your" changes)
  let lastError = '';

  async function request(method, body) {
    const url = prefs.get('syncUrl');
    const token = await getToken();
    let res;
    try {
      res = await fetchFn(`${url}/api/sync`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Desk-Calendar': '1',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error(`Can't reach the phone app at ${url}.`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `The phone app answered ${res.status}.`);
    return data;
  }

  /**
   * Write the server's values here; tell the app which ones actually changed. Skipped: values
   * that aren't valid for the setting, and settings changed here that haven't been sent yet
   * (they're newer than what the server has).
   */
  function apply(values) {
    const changes = {};
    const dirty = new Set(prefs.get('syncDirty') || []);
    for (const k of SHARED_KEYS) {
      if (!values || !(k in values) || dirty.has(k) || same(values[k], prefs.get(k))) continue;
      if (isValid(k, values[k])) changes[k] = values[k];
    }
    if (!Object.keys(changes).length) return [];
    applying = true;
    try { prefs.set(changes); } finally { applying = false; }
    onApplied(Object.keys(changes));
    return Object.keys(changes);
  }

  /** After sending `sent`, forget the keys that haven't changed again since. */
  function markSent(sent) {
    const still = (prefs.get('syncDirty') || []).filter((k) => !(k in sent) || !same(sent[k], prefs.get(k)));
    prefs.set({ syncDirty: still });
  }

  /** Send local changes, then take the server's copy. Safe to call any time. */
  function syncNow() {
    if (running) return running;
    running = (async () => {
      if (!prefs.get('syncUrl')) return status();
      try {
        if (!prefs.get('syncLinked')) {
          // First link: the phone's own changes win; this PC fills in the rest.
          const server = await request('GET');
          const mine = Object.fromEntries(SHARED_KEYS
            .filter((k) => !server.setOnServer.includes(k) && prefs.get(k) !== null && prefs.get(k) !== undefined)
            .map((k) => [k, prefs.get(k)]));
          const merged = Object.keys(mine).length ? await request('PATCH', mine) : server;
          markSent(mine);
          apply(merged.values);
          prefs.set({ syncLinked: true });
        } else {
          const dirty = (prefs.get('syncDirty') || []).filter((k) => SHARED_KEYS.includes(k));
          if (dirty.length) {
            const sent = Object.fromEntries(dirty.map((k) => [k, prefs.get(k)]));
            await request('PATCH', sent);
            markSent(sent); // a key changed again meanwhile stays dirty and goes next time
          }
          apply((await request('GET')).values);
        }
        prefs.set({ syncLastAt: Date.now() });
        lastError = '';
        // Something changed here while this ran: send it soon.
        if ((prefs.get('syncDirty') || []).length) { clearTimeout(pushTimer); pushTimer = setTimeout(syncNow, PUSH_DELAY_MS); }
      } catch (err) {
        lastError = err.message;
      }
      return status();
    })().finally(() => { running = null; });
    return running;
  }

  /** Called by prefs.js after any change; shared ones made here are queued for sending. */
  function onLocalChange(changes) {
    if (applying || !prefs.get('syncUrl')) return;
    const keys = Object.keys(changes).filter((k) => SHARED_KEYS.includes(k));
    if (!keys.length) return;
    prefs.set({ syncDirty: [...new Set([...(prefs.get('syncDirty') || []), ...keys])] });
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, PUSH_DELAY_MS);
  }

  function status() {
    return { url: prefs.get('syncUrl') || '', linked: !!prefs.get('syncLinked'), lastAt: prefs.get('syncLastAt') || 0, error: lastError };
  }

  /** Settings → Phone app: save (or clear) the address. A new address starts a fresh link. */
  async function setUrl(url) {
    const clean = cleanUrl(url);
    prefs.set({ syncUrl: clean || null, syncLinked: false, syncDirty: [], syncLastAt: 0 });
    lastError = '';
    return clean ? syncNow() : status();
  }

  function start() {
    clearInterval(timer);
    timer = setInterval(syncNow, PERIOD_MS);
    if (timer.unref) timer.unref();
    syncNow();
  }

  /** The window came forward: catch up with changes made on the phone. */
  function onFocus() {
    if (Date.now() - lastFocusSync < FOCUS_GAP_MS) return;
    lastFocusSync = Date.now();
    syncNow();
  }

  return { syncNow, onLocalChange, status, setUrl, start, onFocus };
}

module.exports = { createSync, SHARED_KEYS, cleanUrl };
