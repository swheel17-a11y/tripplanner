import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTrip, nextOccurrence } from '../planner.js';

const at = (hhmm, day = 20) => { const [h, m] = hhmm.split(':').map(Number); return new Date(2026, 9, day, h, m); };
const hm = (d) => d.toTimeString().slice(0, 5);

// home -> daycare -> school -> work
const stops = [
  { name: 'Daycare', dwellMin: 10 },
  { name: 'School', dwellMin: 5, deadline: '08:15', earlyMin: 5 },
  { name: 'Work', dwellMin: 0 },
];
const fixed = [10, 15, 20]; // minutes per leg

test('constant traffic works backward to an exact leave time', async () => {
  const plan = await planTrip({ stops, now: at('06:00'), getDuration: async (k) => fixed[k] * 60 });
  assert.equal(plan.mode, 'ontime');
  assert.equal(hm(plan.leaveAt), '07:35');
  assert.equal(hm(plan.rows[0].arrive), '07:45');
  assert.equal(hm(plan.rows[0].leave), '07:55');
  assert.equal(hm(plan.rows[1].arrive), '08:10');
  assert.equal(hm(plan.rows[1].leave), '08:15');
  assert.equal(hm(plan.rows[2].arrive), '08:35');
  assert.equal(plan.minutesEarly, 5);
});

test('traffic that worsens later still lands on time, in a few calls', async () => {
  let calls = 0;
  // Each leg gets 1 extra minute for every 2 minutes after 7:30.
  const getDuration = async (k, depart) => {
    calls++;
    const past = Math.max(0, (depart - at('07:30')) / 60000);
    return (fixed[k] + past / 2) * 60;
  };
  const plan = await planTrip({ stops, now: at('06:00'), getDuration });
  const target = at('08:10');
  assert.ok(plan.rows[1].arrive <= target, 'not late');
  assert.ok(target - plan.rows[1].arrive <= 2 * 60000, 'not wastefully early');
  // Dwell time is respected at daycare.
  assert.equal(plan.rows[0].leave - plan.rows[0].arrive, 10 * 60000);
  assert.ok(calls <= 12, `used ${calls} calls`);
});

test('too late to follow the plan: leave now and report how late', async () => {
  const plan = await planTrip({ stops, now: at('07:50'), getDuration: async (k) => fixed[k] * 60 });
  assert.equal(plan.mode, 'late');
  assert.equal(hm(plan.leaveAt), '07:50');
  assert.equal(hm(plan.rows[1].arrive), '08:25');
  assert.equal(plan.minutesEarly, -10);
});

test('no deadline: plans forward from now', async () => {
  const plan = await planTrip({
    stops: [{ name: 'A', dwellMin: 5 }, { name: 'B' }],
    now: at('09:00'),
    getDuration: async () => 600,
  });
  assert.equal(plan.mode, 'nodeadline');
  assert.equal(hm(plan.rows[1].arrive), '09:25');
});

test('deadline already passed today rolls to tomorrow', () => {
  assert.equal(nextOccurrence('08:15', at('09:00')).getDate(), 21);
  assert.equal(nextOccurrence('08:15', at('07:00')).getDate(), 20);
});
