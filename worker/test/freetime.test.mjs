// Copied from test/unit/freetime.test.js (desktop) for the Worker's copy of freetime.js.
// Run: npm test (in worker/).

process.env.TZ = 'America/Chicago'; // fixed zone so the DST case is deterministic
import test from 'node:test';
import assert from 'node:assert/strict';
const { freeSlots, normalizeProfile } = await import('../src/freetime.js');

const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const LONG_AGO = local(2000, 1, 1);
const profile = { workDays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', lunchStart: '12:00', lunchEnd: '13:00', meetingBuffer: 0 };
const slotsOf = (day) => day.slots.map((s) => `${s.start}-${s.end}`);

test('an empty workday is free except lunch', () => {
  const [day] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 24), profile, now: LONG_AGO });
  assert.equal(day.date, '2026-11-23');
  assert.equal(day.weekday, 'Mon');
  assert.deepEqual(slotsOf(day), ['09:00-12:00', '13:00-17:00']);
  assert.equal(day.free_minutes, 420);
});

test('events and the meeting buffer are removed', () => {
  const events = [{ start: local(2026, 11, 23, 10), end: local(2026, 11, 23, 11) }];
  const [day] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 24), events, profile: { ...profile, meetingBuffer: 15 }, now: LONG_AGO });
  assert.deepEqual(slotsOf(day), ['09:00-09:45', '11:15-12:00', '13:00-17:00']);
});

test('overlapping and back-to-back events merge; short gaps are dropped', () => {
  const events = [
    { start: local(2026, 11, 23, 9), end: local(2026, 11, 23, 10) },
    { start: local(2026, 11, 23, 9, 30), end: local(2026, 11, 23, 11) },
    { start: local(2026, 11, 23, 11, 20), end: local(2026, 11, 23, 12) }, // leaves a 20-minute gap
    { start: local(2026, 11, 23, 14), end: local(2026, 11, 23, 15) },
  ];
  const [day] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 24), events, profile, now: LONG_AGO, minMinutes: 30 });
  assert.deepEqual(slotsOf(day), ['13:00-14:00', '15:00-17:00']);
});

test('all-day events do not block time', () => {
  const events = [{ start: local(2026, 11, 23), end: local(2026, 11, 24), allDay: true }];
  const [day] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 24), events, profile, now: LONG_AGO });
  assert.equal(day.free_minutes, 420);
});

test('weekends are skipped unless anyDay is set', () => {
  const week = freeSlots({ from: local(2026, 11, 22), to: local(2026, 11, 29), profile, now: LONG_AGO });
  assert.deepEqual(week.map((d) => d.weekday), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  const all = freeSlots({ from: local(2026, 11, 22), to: local(2026, 11, 29), profile, now: LONG_AGO, anyDay: true });
  assert.equal(all.length, 7);
});

test('time already past is not free, and edges round to 5 minutes', () => {
  const now = local(2026, 11, 23, 14, 7);
  const [day] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 24), profile, now });
  assert.deepEqual(slotsOf(day), ['14:10-17:00']);
});

test('an event spanning midnight blocks both days', () => {
  const events = [{ start: local(2026, 11, 23, 16), end: local(2026, 11, 24, 10) }];
  const [mon, tue] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 25), events, profile, now: LONG_AGO });
  assert.deepEqual(slotsOf(mon), ['09:00-12:00', '13:00-16:00']);
  assert.deepEqual(slotsOf(tue), ['10:00-12:00', '13:00-17:00']);
});

test('DST change day still gives exactly the working hours', () => {
  // US clocks fall back on Sunday 2026-11-01; 09:00-17:00 is still 8 hours.
  const [day] = freeSlots({ from: local(2026, 11, 1), to: local(2026, 11, 2), profile: { ...profile, lunchStart: '', lunchEnd: '' }, now: LONG_AGO, anyDay: true });
  assert.deepEqual(slotsOf(day), ['09:00-17:00']);
  assert.equal(day.free_minutes, 480);
});

test('normalizeProfile fills defaults and rejects junk', () => {
  const p = normalizeProfile({ dayStart: '25:00', workDays: [1, 1, 9, 3], blockMinutes: 'x', maxBlockMinutes: 30, blockColorId: '42', notes: 'x'.repeat(2000) });
  assert.equal(p.dayStart, '09:00');
  assert.deepEqual(p.workDays, [1, 3]);
  assert.equal(p.blockMinutes, 60);
  assert.equal(p.maxBlockMinutes, 60); // never shorter than the usual block
  assert.equal(p.blockColorId, '');
  assert.equal(p.notes.length, 1500);
});

test('no lunch when lunch is turned off', () => {
  const [day] = freeSlots({ from: local(2026, 11, 23), to: local(2026, 11, 24), profile: { ...profile, lunchStart: '', lunchEnd: '' }, now: LONG_AGO });
  assert.deepEqual(slotsOf(day), ['09:00-17:00']);
});
