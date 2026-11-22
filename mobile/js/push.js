// push.js: turning reminders (push notifications) on and off for THIS device.
//
// HOW SUBSCRIBING WORKS
//   1. Ask permission to show notifications. iPhone only allows this from a tap, and only
//      for an app opened from its Home Screen icon (iOS 16.4 or later).
//   2. pushManager.subscribe() asks the phone's push service (Apple's) for an address
//      ("endpoint") that delivers to this phone, plus keys to encrypt messages for it.
//      We pass the Worker's VAPID public key, so only the Worker can push to it.
//   3. Send that subscription to the Worker (/api/push/subscribe). Its cron job then
//      pushes reminders there (worker/src/reminders.js); sw.js shows them.

import { api } from './api.js';

const iOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** iOS version from the user agent ("OS 17_2" → 17.2), or null. */
function iosVersion() {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) / 10 : null;
}

/**
 * Can this device get reminders? { ok: true } or { ok: false, why: '…' } with a sentence
 * for the Settings screen.
 */
export function pushSupport() {
  const v = iosVersion();
  if (iOS() && v !== null && v < 16.4) {
    return { ok: false, why: `This iPhone has iOS ${v.toFixed(1)}. Reminders need iOS 16.4 or later (Settings → General → Software Update).` };
  }
  if (iOS() && !installed()) {
    return { ok: false, why: 'Open Desk Calendar from its Home Screen icon to turn reminders on. In Safari: tap Share, then "Add to Home Screen", then open it from there.' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, why: 'This browser can\'t receive push notifications.' };
  }
  return { ok: true };
}

/**
 * The service worker registration, or an error. Never waits forever: if the service
 * worker couldn't be installed, `navigator.serviceWorker.ready` would never resolve.
 */
async function registration() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) throw new Error('Desk Calendar\'s background helper (service worker) isn\'t running. Close the app fully and open it again.');
  if (reg.active) return reg;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('The background helper is still starting. Try again in a moment.')), 5000)),
  ]);
}

export async function currentSubscription() {
  if (!pushSupport().ok) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * Turn reminders on for this device. MUST be called straight from a tap handler:
 * the permission request has to happen before anything else is awaited.
 */
export async function turnOn(vapidPublicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for Desk Calendar. Allow them in the iPhone Settings app → Notifications → Desk Cal, then try again.'
      : 'Notifications weren\'t allowed.');
  }
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different VAPID key (keys were replaced) won't work: renew it.
  if (sub && b64url(sub.options?.applicationServerKey) !== vapidPublicKey) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidPublicKey });
  return api.pushSubscribe(sub.toJSON());
}

/** Turn reminders off for this device (other devices keep theirs). */
export async function turnOff() {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return null;
  const { endpoint } = sub;
  await sub.unsubscribe().catch(() => {});
  return api.pushUnsubscribe(endpoint).catch(() => null);
}

function b64url(buf) {
  if (!buf) return '';
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
