// sw.js: the service worker. It runs in the background of the browser, between the app
// and the network, and makes the app start (and show your last-loaded events) offline.
//
// WHAT IT DOES WITH EACH REQUEST
//   App files (HTML, CSS, JS, icons)   Saved on install. Served from the saved copy right
//                                      away, then refreshed in the background, so the next
//                                      launch has the newest version ("stale-while-revalidate").
//   /api/me, /api/calendars, /api/tasks Network first. Every good answer is saved; if the
//   /api/events, /api/tasks/lists      network fails, the saved copy is used and marked with
//                                      an "X-Desk-Offline" header so the app can say so.
//                                      For events, if the exact date range was never loaded,
//                                      the most recent events answer is used instead.
//   Everything else (/auth/*, changes, the assistant)
//                                      Straight to the network, never saved.
//
// PRIVACY: the saved calendar data stays on this phone, in this app's storage, and is
// deleted when you sign out (the app sends "clear-data") or the Worker says you're
// signed out (any 401).
//
// UPDATES: worker/scripts/build-mobile-assets.mjs rewrites the generated block below with
// a fingerprint of the app files. A changed fingerprint = a new service worker, which
// installs the new files and removes the old copy.

// BEGIN GENERATED (worker/scripts/build-mobile-assets.mjs)
const VERSION = '9867ac6ec446';
const SHELL_FILES = [
  "/",
  "/about",
  "/css/app.css",
  "/css/icons.css",
  "/css/page.css",
  "/icon.svg",
  "/icons/LICENSE",
  "/icons/add_24_filled.svg",
  "/icons/add_24_regular.svg",
  "/icons/alert_24_filled.svg",
  "/icons/alert_24_regular.svg",
  "/icons/arrow_clockwise_24_filled.svg",
  "/icons/arrow_clockwise_24_regular.svg",
  "/icons/arrow_undo_24_filled.svg",
  "/icons/arrow_undo_24_regular.svg",
  "/icons/calendar_3_day_24_filled.svg",
  "/icons/calendar_3_day_24_regular.svg",
  "/icons/calendar_agenda_24_filled.svg",
  "/icons/calendar_agenda_24_regular.svg",
  "/icons/calendar_clock_24_filled.svg",
  "/icons/calendar_clock_24_regular.svg",
  "/icons/calendar_day_24_filled.svg",
  "/icons/calendar_day_24_regular.svg",
  "/icons/calendar_ltr_24_filled.svg",
  "/icons/calendar_ltr_24_regular.svg",
  "/icons/calendar_month_24_filled.svg",
  "/icons/calendar_month_24_regular.svg",
  "/icons/calendar_today_24_filled.svg",
  "/icons/calendar_today_24_regular.svg",
  "/icons/chat_24_filled.svg",
  "/icons/chat_24_regular.svg",
  "/icons/checkmark_24_filled.svg",
  "/icons/checkmark_24_regular.svg",
  "/icons/checkmark_circle_24_filled.svg",
  "/icons/checkmark_circle_24_regular.svg",
  "/icons/chevron_down_24_filled.svg",
  "/icons/chevron_down_24_regular.svg",
  "/icons/chevron_left_24_filled.svg",
  "/icons/chevron_left_24_regular.svg",
  "/icons/chevron_right_24_filled.svg",
  "/icons/chevron_right_24_regular.svg",
  "/icons/circle_24_filled.svg",
  "/icons/circle_24_regular.svg",
  "/icons/clock_24_filled.svg",
  "/icons/clock_24_regular.svg",
  "/icons/color_24_filled.svg",
  "/icons/color_24_regular.svg",
  "/icons/copy_24_filled.svg",
  "/icons/copy_24_regular.svg",
  "/icons/delete_24_filled.svg",
  "/icons/delete_24_regular.svg",
  "/icons/dismiss_24_filled.svg",
  "/icons/dismiss_24_regular.svg",
  "/icons/edit_24_filled.svg",
  "/icons/edit_24_regular.svg",
  "/icons/history_24_filled.svg",
  "/icons/history_24_regular.svg",
  "/icons/link_24_filled.svg",
  "/icons/link_24_regular.svg",
  "/icons/location_24_filled.svg",
  "/icons/location_24_regular.svg",
  "/icons/open_24_filled.svg",
  "/icons/open_24_regular.svg",
  "/icons/person_24_filled.svg",
  "/icons/person_24_regular.svg",
  "/icons/send_24_filled.svg",
  "/icons/send_24_regular.svg",
  "/icons/settings_24_filled.svg",
  "/icons/settings_24_regular.svg",
  "/icons/sign_out_24_filled.svg",
  "/icons/sign_out_24_regular.svg",
  "/icons/sparkle_24_filled.svg",
  "/icons/sparkle_24_regular.svg",
  "/icons/task_list_ltr_24_filled.svg",
  "/icons/task_list_ltr_24_regular.svg",
  "/icons/text_description_24_filled.svg",
  "/icons/text_description_24_regular.svg",
  "/icons/video_24_filled.svg",
  "/icons/video_24_regular.svg",
  "/img/apple-touch-icon.png",
  "/img/icon-192.png",
  "/img/icon-512.png",
  "/js/actions.js",
  "/js/api.js",
  "/js/app.js",
  "/js/chat.js",
  "/js/details.js",
  "/js/editor.js",
  "/js/push.js",
  "/js/quickadd.js",
  "/js/settings.js",
  "/js/sheet.js",
  "/js/state.js",
  "/js/tasks.js",
  "/js/touch.js",
  "/js/util.js",
  "/js/views/agenda.js",
  "/js/views/month.js",
  "/js/views/timegrid.js",
  "/manifest.webmanifest",
  "/privacy",
  "/terms"
];
// END GENERATED

const SHELL = `dc-shell-${VERSION}`;
const DATA = 'dc-data';
const CACHED_API = ['/api/me', '/api/calendars', '/api/events', '/api/tasks', '/api/tasks/lists'];
const LATEST_EVENTS = '/api/events?latest';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // cache: 'reload' skips the browser's HTTP cache so we save fresh copies.
    await cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting(); // take over without waiting for every tab to close
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('dc-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-data') event.waitUntil(caches.delete(DATA));
});

// ---------------------------------------------------------------------------------------
// Reminders (push notifications). The Worker's cron sends an encrypted push; the phone
// wakes this service worker with it, even when the app is closed.
//   message: { title, body, tag, url, meetLink? }  (see worker/src/reminders.js)
// iPhone requires every push to show a notification, so we always do.
// ---------------------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data?.json() || {}; } catch { msg = { title: 'Desk Calendar', body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Desk Calendar', {
    body: msg.body || '',
    tag: msg.tag,                       // the same event never stacks twice
    silent: true,                       // like the desktop app: no sound (where the OS allows it)
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    timestamp: Date.now(),
    data: { url: msg.url || '/', meetLink: msg.meetLink || '' },
    // Buttons, where supported (Android / desktop). iPhone shows none: tapping opens the app.
    actions: msg.meetLink ? [{ action: 'join', title: 'Join' }] : [],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, meetLink } = event.notification.data || {};
  event.waitUntil((async () => {
    // Join: only an https meeting link. Anything else opens this app, never another site.
    if (event.action === 'join' && /^https:\/\//i.test(meetLink || '')) return self.clients.openWindow(meetLink);
    let target = new URL(url || '/', self.location.origin);
    if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
    target = target.href;
    // App already open? Bring it forward and tell it which event to show.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open', url: target });
      return undefined;
    }
    return self.clients.openWindow(target);
  })());
});

// The browser replaced the push subscription (keys rotated or expired): subscribe again
// with the same VAPID key and tell the Worker, so reminders keep arriving.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!me?.push?.publicKey || !me.prefs?.notifyEnabled) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: me.push.publicKey });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Desk-Calendar': '1' },
      body: JSON.stringify(sub.toJSON()),
    });
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // network as usual
  if (url.pathname.startsWith('/auth/')) return;
  if (url.pathname.startsWith('/api/')) {
    if (CACHED_API.includes(url.pathname)) event.respondWith(networkFirst(req, url));
    return;
  }
  if (req.mode === 'navigate') { event.respondWith(page(req)); return; }
  event.respondWith(staleWhileRevalidate(req, event));
});

/**
 * A page: try the network (so you get updates), fall back to the saved copy. Each page is
 * saved under its own address: the app is "/" (and anything else unknown opens the app);
 * /about, /privacy and /terms are saved as themselves.
 */
async function page(req) {
  const path = new URL(req.url).pathname;
  const key = SHELL_FILES.includes(path) ? path : '/';
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected && key === path) (await caches.open(SHELL)).put(key, res.clone());
    return res;
  } catch {
    return (await caches.match(key, { cacheName: SHELL })) || (await caches.match('/', { cacheName: SHELL })) || offlineText();
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => {
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { event.waitUntil(update); return cached; }
  return (await update) || new Response('', { status: 504 });
}

async function networkFirst(req, url) {
  const data = await caches.open(DATA);
  try {
    const res = await fetch(req);
    if (res.status === 401) { await caches.delete(DATA); return res; } // signed out: forget everything
    if (res.ok) {
      await data.put(req, res.clone());
      if (url.pathname === '/api/events') await data.put(LATEST_EVENTS, res.clone());
      await trim(data);
    }
    return res;
  } catch {
    const saved = (await data.match(req)) || (url.pathname === '/api/events' ? await data.match(LATEST_EVENTS) : null);
    if (!saved) {
      return new Response(JSON.stringify({ error: "You're offline and this hasn't been loaded before.", code: 'OFFLINE' }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'X-Desk-Offline': '1' } });
    }
    const headers = new Headers(saved.headers);
    headers.set('X-Desk-Offline', '1');
    return new Response(await saved.blob(), { status: saved.status, headers });
  }
}

/** Keep the saved answers to the newest 40 (each date range you visit is its own entry). */
async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.filter((k) => !k.url.endsWith(LATEST_EVENTS)).slice(0, Math.max(0, keys.length - 40));
  await Promise.all(extra.map((k) => cache.delete(k)));
}

function offlineText() {
  return new Response('Desk Calendar is offline and has no saved copy yet. Open it once while online.',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
