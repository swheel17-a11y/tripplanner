// planner.js — the "work backward from the deadline" math.
//
// This file knows nothing about Google. It is handed a getDuration(legIndex, departDate)
// function that returns drive seconds for one leg, so it can be tested with fake traffic.
//
// Terms:
//   point 0 is the start, point k+1 is stops[k].
//   leg k drives from point k to point k+1, so leg k ARRIVES at stops[k].

const MIN = 60 * 1000;
const MAX_TRIES = 5;          // Google calls per leg, at most, while homing in
const CLOSE_ENOUGH = 30 * 1000; // stop adjusting once we land within 30 seconds

export const floorToMinute = (d) => new Date(Math.floor(d.getTime() / MIN) * MIN);
export const ceilToMinute = (d) => new Date(Math.ceil(d.getTime() / MIN) * MIN);

/** The next time the clock reads "HH:MM" — today if still ahead, otherwise tomorrow. */
export function nextOccurrence(hhmm, now) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Find a departure time for one leg so that we arrive at (or just before) arriveBy.
 * Traffic changes with the departure time, so we guess, check, and adjust.
 */
async function solveDeparture(leg, arriveBy, getDuration) {
  let depart = new Date(arriveBy.getTime() - 15 * MIN); // first rough guess
  let dur = 0;
  for (let i = 0; i < MAX_TRIES; i++) {
    dur = (await getDuration(leg, depart)) * 1000;
    const arrival = depart.getTime() + dur;
    if (arrival <= arriveBy.getTime() && arriveBy.getTime() - arrival <= CLOSE_ENOUGH + MIN) break;
    depart = floorToMinute(new Date(arriveBy.getTime() - dur));
  }
  // Safety net: if the last check still has us late, leave earlier by the difference.
  const lateBy = depart.getTime() + dur - arriveBy.getTime();
  if (lateBy > 0) depart = floorToMinute(new Date(depart.getTime() - lateBy));
  return { depart, driveSec: dur / 1000 };
}

/** Drive legs fromLeg..end in order, starting at `leaveAt`. Fills rows in place. */
async function driveForward(rows, stops, fromLeg, leaveAt, getDuration) {
  let t = leaveAt;
  for (let k = fromLeg; k < stops.length; k++) {
    const driveSec = await getDuration(k, t);
    const arrive = new Date(t.getTime() + driveSec * 1000);
    const leave = new Date(arrive.getTime() + (stops[k].dwellMin || 0) * MIN);
    rows[k] = { arrive, leave, driveSec };
    t = leave;
  }
}

/**
 * Plan a trip.
 * @param stops       [{ name, dwellMin, deadline: "HH:MM" | null, earlyMin }]
 * @param now         Date
 * @param getDuration async (legIndex, departDate) => seconds
 * @returns {
 *   mode: 'ontime' | 'late' | 'nodeadline',
 *   leaveAt, rows: [{arrive, leave, driveSec}] (one per stop),
 *   deadlineIndex, deadline, targetArrival, minutesEarly (negative = late)
 * }
 */
export async function planTrip({ stops, now, getDuration }) {
  if (!stops.length) throw new Error('Add at least one stop.');
  const rows = new Array(stops.length);
  const d = stops.findIndex((s) => s.deadline);

  // No deadline: just "if I leave now, when do I get everywhere?"
  if (d === -1) {
    await driveForward(rows, stops, 0, now, getDuration);
    return { mode: 'nodeadline', leaveAt: now, rows, deadlineIndex: -1 };
  }

  const deadline = nextOccurrence(stops[d].deadline, now);
  const targetArrival = new Date(deadline.getTime() - (stops[d].earlyMin || 0) * MIN);

  // Backward pass: from the deadline stop back to the start.
  let arriveBy = targetArrival;
  let leaveAt;
  for (let k = d; k >= 0; k--) {
    const { depart, driveSec } = await solveDeparture(k, arriveBy, getDuration);
    const arrive = new Date(depart.getTime() + driveSec * 1000);
    rows[k] = { arrive, leave: rows[k]?.leave ?? null, driveSec };
    if (k > 0) {
      rows[k - 1] = { leave: depart };
      // To leave stop k-1 at `depart`, we must arrive there `dwell` minutes earlier.
      arriveBy = new Date(depart.getTime() - (stops[k - 1].dwellMin || 0) * MIN);
    } else {
      leaveAt = depart;
    }
  }

  // Too late to follow the plan? Re-plan forward from right now.
  if (leaveAt < now) {
    await driveForward(rows, stops, 0, now, getDuration);
    return finish('late', now);
  }

  // Forward pass: stops after the deadline stop.
  rows[d].leave = new Date(rows[d].arrive.getTime() + (stops[d].dwellMin || 0) * MIN);
  await driveForward(rows, stops, d + 1, rows[d].leave, getDuration);
  return finish('ontime', leaveAt);

  function finish(mode, leave) {
    const minutesEarly = Math.floor((deadline - rows[d].arrive) / MIN);
    return { mode, leaveAt: leave, rows, deadlineIndex: d, deadline, targetArrival, minutesEarly };
  }
}
