// prefcheck.js: what a valid value looks like for each setting that can arrive from outside
// the backend: the Settings page (main.js, "prefs:set") or the phone app (sync.js).
//
// Anything not listed here can't be changed that way. Settings with consequences (the phone
// app's address, the assistant's server addresses, calendar visibility) have their own
// channels with their own checks.

const isInt = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const oneOf = (...xs) => (v) => xs.includes(v);
const isBool = (v) => typeof v === 'boolean';
const idOrNull = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 500);
/** { id: true/false } */
const visibilityMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length <= 500 && Object.values(v).every(isBool);
const profileOrNull = (v) => v === null || (!!v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length <= 10000);

const CHECKS = {
  // Settings page
  view: oneOf('day', 'week', 'month', 'agenda'),
  startView: oneOf('last', 'day', 'week', 'month', 'agenda'),
  agendaDays: isInt(1, 31),
  weekStartsOn: isInt(0, 6),
  timeFormat: oneOf('system', '12', '24'),
  defaultEventMinutes: isInt(5, 1440),
  defaultCalendarId: idOrNull,
  defaultTaskListId: idOrNull,
  notifyEnabled: isBool,
  notifyMinutes: isInt(0, 1440),
  startWithWindows: isBool,
  startHidden: isBool,
  sidebarCollapsed: isBool,
  hotkey: (v) => typeof v === 'string' && v.length > 0 && v.length <= 100,
  // Only from the phone app (these have their own channels on this PC)
  calendarVisibility: visibilityMap,
  taskListVisibility: visibilityMap,
  userProfile: profileOrNull,
};

/** Keys the Settings page may change with "prefs:set". */
const SETTINGS_PAGE_KEYS = [
  'view', 'startView', 'agendaDays', 'weekStartsOn', 'timeFormat', 'defaultEventMinutes', 'defaultCalendarId',
  'defaultTaskListId', 'notifyEnabled', 'notifyMinutes', 'startWithWindows', 'startHidden', 'sidebarCollapsed', 'hotkey',
];

const isValid = (key, value) => !!CHECKS[key] && CHECKS[key](value);

/** Throws if any key isn't allowed or any value isn't valid. */
function checkSettingsPage(changes) {
  if (!changes || typeof changes !== 'object') throw new Error('Nothing to save.');
  for (const [k, v] of Object.entries(changes)) {
    if (!SETTINGS_PAGE_KEYS.includes(k)) throw new Error(`"${k}" can't be changed here.`);
    if (!isValid(k, v)) throw new Error(`That isn't a valid value for "${k}".`);
  }
}

module.exports = { isValid, checkSettingsPage, SETTINGS_PAGE_KEYS };
