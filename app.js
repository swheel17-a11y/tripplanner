// app.js — screens, saved trips, and wiring the planner to Google.
import { planTrip, floorToMinute, ceilToMinute } from './planner.js';
import {
  loadGoogleMaps, makeDurationFn, createPlacePicker, getCurrentPosition, googleMapsUrl,
  requestsToday, DAILY_LIMIT,
} from './maps.js';

const MIN = 60 * 1000;
const AUTO_REFRESH_EVERY = 5 * MIN;   // re-check traffic this often...
const AUTO_REFRESH_WITHIN = 60 * MIN; // ...once leave time is less than an hour away

// ---------- Saved data (lives only on this phone) ----------

const store = {
  get(name, fallback) {
    try { return JSON.parse(localStorage.getItem('tp.' + name)) ?? fallback; } catch { return fallback; }
  },
  set(name, value) { localStorage.setItem('tp.' + name, JSON.stringify(value)); },
};

const blankStop = () => ({ place: null, dwellMin: 0, deadline: null, earlyMin: 5 });
const blankTrip = () => ({ name: '', start: { type: 'gps' }, stops: [blankStop()] });

const state = {
  view: 'plan',
  apiKey: store.get('key', ''),
  settings: store.get('settings', { traffic: 'auto' }),
  trip: store.get('current', blankTrip()),
  saved: store.get('saved', []),
  result: null,   // { plan, checkedAt, models, startName }
  busy: '',       // message while working
  notice: '',     // short confirmation, e.g. "Saved"
  error: '',
  mapsReady: false,
  lastGps: null,
};

const saveTrip = () => store.set('current', state.trip);

// ---------- Small helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const leaveTime = (d) => fmtTime(floorToMinute(d)); // round leave times down: never late
const arriveTime = (d) => fmtTime(ceilToMinute(d)); // round arrivals up: honest
const fmtHHMM = (hhmm) => { const [h, m] = hhmm.split(':'); const d = new Date(); d.setHours(h, m); return fmtTime(d); };
const mins = (sec) => `${Math.round(sec / 60)} min`;
const isToday = (d) => d.toDateString() === new Date().toDateString();
const dayLabel = (d) => isToday(d) ? 'Today' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

function untilText(d) {
  const m = Math.round((d - Date.now()) / MIN);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

function tripSummary(trip) {
  const names = trip.stops.map((s) => s.place?.name || '?');
  const start = trip.start.type === 'gps' ? 'My location' : trip.start.place?.name || '?';
  const dl = trip.stops.find((s) => s.deadline);
  return `${[start, ...names].join(' → ')}${dl ? ` · by ${fmtHHMM(dl.deadline)}` : ''}`;
}

// ---------- Rendering ----------

function render() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
  const main = $('main');
  main.innerHTML = ({ plan: planView, result: resultView, saved: savedView, settings: settingsView })[state.view]();
  if (state.view === 'plan') fillPlaceSlots();
}

function banner() {
  const info = state.busy || state.notice;
  return (info ? `<div class="banner busy">${esc(info)}</div>` : '')
    + (state.error ? `<div class="banner error">${esc(state.error)}</div>` : '');
}

function planView() {
  const t = state.trip;
  const start = t.start.type === 'gps'
    ? '<p class="hint">Uses your GPS each time you calculate.</p>'
    : '<div class="slot" data-slot="start"></div>';
  return `${banner()}
    ${t.name ? `<p class="trip-name">${esc(t.name)}</p>` : ''}
    <section class="card">
      <h2>Start</h2>
      <div class="seg">
        <button data-act="start-gps" class="${t.start.type === 'gps' ? 'on' : ''}">📍 My location</button>
        <button data-act="start-place" class="${t.start.type === 'place' ? 'on' : ''}">🏠 Address</button>
      </div>
      ${start}
    </section>
    <ol class="stops">${t.stops.map(stopCard).join('')}</ol>
    <button class="wide" data-act="add-stop">+ Add stop</button>
    <button class="wide primary" data-act="calculate" ${state.busy ? 'disabled' : ''}>When do I leave?</button>
    <div class="row">
      <button data-act="save-trip">💾 Save trip</button>
      <button data-act="new-trip">New trip</button>
    </div>`;
}

function stopCard(s, i) {
  const n = state.trip.stops.length;
  return `<li class="card stop ${s.deadline ? 'has-deadline' : ''}">
    <div class="stop-head">
      <span class="num">${i + 1}</span>
      <div class="slot" data-slot="${i}"></div>
    </div>
    <label class="field">Time at this stop
      <span><input type="number" inputmode="numeric" min="0" max="240" data-i="${i}" data-field="dwellMin" value="${s.dwellMin || 0}"> min</span>
    </label>
    <label class="check"><input type="checkbox" data-i="${i}" data-field="hasDeadline" ${s.deadline ? 'checked' : ''}> Must arrive by a set time</label>
    ${s.deadline ? `
      <label class="field">Arrive by
        <input type="time" data-i="${i}" data-field="deadline" value="${s.deadline}">
      </label>
      <label class="field">Arrive early by
        <span><input type="number" inputmode="numeric" min="0" max="120" data-i="${i}" data-field="earlyMin" value="${s.earlyMin || 0}"> min</span>
      </label>` : ''}
    <div class="stop-actions">
      <button data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button data-act="down" data-i="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button data-act="remove" data-i="${i}" ${n === 1 ? 'disabled' : ''} aria-label="Remove stop">✕</button>
    </div>
  </li>`;
}

/** Each address spot shows either the chosen place or a Google search box. */
function fillPlaceSlots() {
  document.querySelectorAll('.slot').forEach(async (slot) => {
    const key = slot.dataset.slot;
    const target = key === 'start' ? state.trip.start : state.trip.stops[key];
    if (target.place) {
      slot.innerHTML = `<div class="chip"><div><b>${esc(target.place.name)}</b><small>${esc(target.place.address)}</small></div>
        <button data-act="change-place" data-slot="${key}">Change</button></div>`;
      return;
    }
    if (!state.mapsReady) {
      slot.innerHTML = '<p class="hint">Add your Google Maps key in Settings to search addresses.</p>';
      return;
    }
    const picker = await createPlacePicker((place) => {
      target.place = place;
      saveTrip();
      render();
    }, state.lastGps);
    slot.replaceChildren(picker);
  });
}

function resultView() {
  const r = state.result;
  if (!r) return `${banner()}<p class="hint">Plan a trip first.</p>`;
  const { plan } = r;
  const stops = state.trip.stops;
  const late = plan.mode === 'late';
  const d = plan.deadlineIndex;
  const live = r.models.includes('BEST_GUESS');
  const pess = r.models.includes('PESSIMISTIC');
  const trafficText = live && pess ? 'Live traffic soon, pessimistic later' : live ? 'Live traffic' : 'Pessimistic traffic (planning)';

  let status = '';
  if (d >= 0) {
    const dl = `${esc(stops[d].place.name)} by ${fmtTime(plan.deadline)}`;
    status = plan.minutesEarly >= 0
      ? `<div class="status ok">✓ ${dl} — ${plan.minutesEarly} min early</div>`
      : `<div class="status bad">⚠ ${dl} — about ${-plan.minutesEarly} min late</div>`;
  }

  let rows = `<li class="tl"><time>${leaveTime(plan.leaveAt)}</time><div>Leave <b>${esc(r.startName)}</b></div></li>`;
  stops.forEach((s, i) => {
    const row = plan.rows[i];
    const last = i === stops.length - 1;
    const extra = [
      s.dwellMin && !last ? `${s.dwellMin} min here · leave ${leaveTime(row.leave)}` : '',
      i === d ? `Deadline ${fmtTime(plan.deadline)}${s.earlyMin ? ` · aiming ${s.earlyMin} min early` : ''}` : '',
    ].filter(Boolean).join('<br>');
    rows += `<li class="drive">🚗 ${mins(row.driveSec)}</li>
      <li class="tl ${i === d ? 'deadline' : ''}"><time>${arriveTime(row.arrive)}</time>
        <div>Arrive <b>${esc(s.place.name)}</b>${extra ? `<small>${extra}</small>` : ''}</div></li>`;
  });

  const autoOn = shouldAutoRefresh();
  return `${banner()}
    <section class="leave ${late ? 'late' : ''}">
      <div class="label">${late ? 'Running late' : 'Leave at'}</div>
      <div class="big">${late ? 'Now' : leaveTime(plan.leaveAt)}</div>
      <div class="sub">${late ? 'Leave right away' : `${untilText(plan.leaveAt)} · ${dayLabel(plan.leaveAt)}`}</div>
      ${status}
    </section>
    ${r.change ? `<div class="banner ${r.change > 0 ? 'error' : 'busy'}">Traffic changed: leave ${Math.abs(r.change)} min ${r.change > 0 ? 'EARLIER' : 'later'} than the last check.</div>` : ''}
    <p class="hint center">${trafficText} · checked ${fmtTime(r.checkedAt)}${autoOn ? ' · auto-updating every 5 min' : ''}</p>
    <ol class="timeline">${rows}</ol>
    <a class="wide primary button" href="${esc(googleMapsUrl(stops.map((s) => s.place)))}" target="_blank" rel="noopener">Open in Google Maps</a>
    <div class="row">
      <button data-act="refresh" ${state.busy ? 'disabled' : ''}>↻ Refresh traffic</button>
      <button data-act="go-plan">Edit trip</button>
    </div>
    ${state.trip.name ? '' : '<button class="wide" data-act="save-trip">💾 Save this trip</button>'}`;
}

function savedView() {
  if (!state.saved.length) {
    return '<p class="hint">No saved trips yet. Build a trip, then tap “Save trip”.</p>';
  }
  return `<ul class="saved">${state.saved.map((t, i) => `
    <li class="card">
      <b>${esc(t.name)}</b>
      <small>${esc(tripSummary(t))}</small>
      <div class="row">
        <button class="primary" data-act="load" data-i="${i}">Use this trip</button>
        <button data-act="delete-saved" data-i="${i}">Delete</button>
      </div>
    </li>`).join('')}</ul>`;
}

function settingsView() {
  const t = state.settings.traffic;
  const radio = (v, title, desc) => `<label class="radio"><input type="radio" name="traffic" value="${v}" ${t === v ? 'checked' : ''}>
    <span><b>${title}</b><small>${desc}</small></span></label>`;
  return `${banner()}
    <section class="card">
      <h2>Google Maps API key</h2>
      <p class="hint">Stored only on this phone. See the README for how to create and lock it down.</p>
      <input type="password" id="api-key" value="${esc(state.apiKey)}" placeholder="Paste key here" autocomplete="off">
      <div class="row">
        <button class="primary" data-act="save-key">Save key</button>
        <button data-act="toggle-key">Show</button>
      </div>
    </section>
    <section class="card">
      <h2>Traffic</h2>
      ${radio('auto', 'Auto (recommended)', 'Live traffic once leaving is within an hour; pessimistic (“bad day”) estimates further ahead.')}
      ${radio('pessimistic', 'Always pessimistic', 'Safest for hard deadlines. Ignores luck.')}
      ${radio('live', 'Always live / best guess', 'Google’s typical estimate, using current conditions when leaving soon.')}
    </section>
    <section class="card">
      <h2>Usage today</h2>
      <p class="hint">${requestsToday()} of ${DAILY_LIMIT} drive-time requests used on this phone. Each “When do I leave?” uses about 5–10. Resets at midnight.</p>
    </section>
    <section class="card">
      <h2>Backup saved trips</h2>
      <div class="row">
        <button data-act="export">Export</button>
        <button data-act="import">Import</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>`;
}

// ---------- Actions ----------

// compare: true when re-checking the same trip, so we can say if traffic moved the leave time.
async function calculate({ compare = false } = {}) {
  const t = state.trip;
  state.error = '';
  const missing = t.stops.findIndex((s) => !s.place);
  if (missing !== -1) return fail(`Pick an address for stop ${missing + 1}.`);
  if (t.start.type === 'place' && !t.start.place) return fail('Pick a start address, or use My location.');
  if (!state.mapsReady) return fail('Add your Google Maps key in Settings first.');

  try {
    let start = t.start.place;
    if (t.start.type === 'gps') {
      setBusy('Finding your location…');
      start = await getCurrentPosition();
      state.lastGps = { lat: start.lat, lng: start.lng };
    }
    setBusy('Checking traffic…');
    const now = new Date();
    const points = [start, ...t.stops.map((s) => s.place)];
    const getDuration = await makeDurationFn(points, state.settings.traffic, now);
    const plan = await planTrip({
      now,
      getDuration,
      stops: t.stops.map((s) => ({ name: s.place.name, dwellMin: +s.dwellMin || 0, deadline: s.deadline, earlyMin: +s.earlyMin || 0 })),
    });
    const prev = state.result;
    const change = compare && prev?.plan.mode === 'ontime' && plan.mode === 'ontime'
      ? Math.round((prev.plan.leaveAt - plan.leaveAt) / MIN) : 0;
    state.result = { plan, checkedAt: now, models: [...getDuration.modelsUsed], startName: start.name, change };
    state.busy = '';
    state.view = 'result';
    render();
  } catch (err) {
    fail(err.message || String(err));
  }
}

function setBusy(msg) { state.busy = msg; render(); }
function notify(msg) {
  state.notice = msg; render();
  setTimeout(() => { if (state.notice === msg) { state.notice = ''; render(); } }, 2500);
}
function fail(msg) { state.busy = ''; state.error = msg; render(); }

function shouldAutoRefresh() {
  const r = state.result;
  if (!r || r.plan.mode === 'nodeadline') return false;
  if (r.plan.mode === 'late') return Date.now() < r.plan.deadline.getTime();
  return r.plan.leaveAt - Date.now() <= AUTO_REFRESH_WITHIN && Date.now() < r.plan.leaveAt.getTime() + 15 * MIN;
}

// Every 30 s: update the countdown; every 5 min near leave time: re-check traffic.
// Only while the app is on screen, so it doesn't spend Google requests in your pocket.
function tick() {
  if (document.hidden || state.view !== 'result' || state.busy) return;
  if (shouldAutoRefresh() && Date.now() - state.result.checkedAt >= AUTO_REFRESH_EVERY) {
    calculate({ compare: true });
  } else {
    render();
  }
}
setInterval(tick, 30 * 1000);
document.addEventListener('visibilitychange', tick);

const actions = {
  'start-gps'() { state.trip.start = { type: 'gps' }; saveTrip(); render(); },
  'start-place'() { if (state.trip.start.type !== 'place') state.trip.start = { type: 'place', place: null }; saveTrip(); render(); },
  'add-stop'() { state.trip.stops.push(blankStop()); saveTrip(); render(); },
  remove(i) { state.trip.stops.splice(i, 1); saveTrip(); render(); },
  up(i) { const s = state.trip.stops; [s[i - 1], s[i]] = [s[i], s[i - 1]]; saveTrip(); render(); },
  down(i) { const s = state.trip.stops; [s[i + 1], s[i]] = [s[i], s[i + 1]]; saveTrip(); render(); },
  'change-place'(_, el) {
    const key = el.dataset.slot;
    (key === 'start' ? state.trip.start : state.trip.stops[key]).place = null;
    saveTrip(); render();
  },
  calculate() { calculate(); },
  refresh() { calculate({ compare: true }); },
  'go-plan'() { state.view = 'plan'; render(); },
  'save-trip'() {
    const t = state.trip;
    if (t.stops.some((s) => !s.place)) return fail('Pick an address for every stop before saving.');
    const name = prompt('Name this trip (e.g. “Morning daycare run”):', t.name || '');
    if (!name?.trim()) return;
    t.name = name.trim();
    const copy = JSON.parse(JSON.stringify(t));
    const existing = state.saved.findIndex((s) => s.name === t.name);
    if (existing === -1) state.saved.push(copy); else state.saved[existing] = copy;
    store.set('saved', state.saved);
    saveTrip();
    state.error = '';
    notify(`Saved “${t.name}”.`);
  },
  'new-trip'() {
    if (!confirm('Start a new blank trip? (Saved trips are kept.)')) return;
    state.trip = blankTrip(); state.result = null; saveTrip(); render();
  },
  load(i) {
    state.trip = JSON.parse(JSON.stringify(state.saved[i]));
    state.result = null; state.error = '';
    saveTrip();
    state.view = 'plan';
    render();
    calculate();
  },
  'delete-saved'(i) {
    if (!confirm(`Delete “${state.saved[i].name}”?`)) return;
    state.saved.splice(i, 1); store.set('saved', state.saved); render();
  },
  'save-key'() {
    const key = $('#api-key').value.trim();
    store.set('key', key);
    location.reload(); // Google Maps can only load once per page, so start fresh with the new key
  },
  'toggle-key'(_, el) {
    const input = $('#api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
    el.textContent = input.type === 'password' ? 'Show' : 'Hide';
  },
  export() {
    const blob = new Blob([JSON.stringify({ saved: state.saved }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'trip-planner-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  },
  import() { $('#import-file').click(); },
};

document.addEventListener('click', (e) => {
  const nav = e.target.closest('nav button');
  if (nav) { state.view = nav.dataset.view; state.error = ''; render(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  actions[el.dataset.act]?.(el.dataset.i !== undefined ? +el.dataset.i : undefined, el);
});

// Typing in a box updates the trip without redrawing (so the keyboard stays open).
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.name === 'traffic') {
    state.settings.traffic = el.value; store.set('settings', state.settings); return;
  }
  if (el.id === 'import-file' && el.files[0]) {
    try {
      const data = JSON.parse(await el.files[0].text());
      const names = new Set(state.saved.map((t) => t.name));
      const incoming = (data.saved || []).filter((t) => t.name && Array.isArray(t.stops) && !names.has(t.name));
      state.saved.push(...incoming);
      store.set('saved', state.saved);
      notify(`Imported ${incoming.length} trip(s).`);
    } catch { fail('That file is not a trip backup.'); }
    return;
  }
  const field = el.dataset.field;
  if (!field) return;
  const stop = state.trip.stops[+el.dataset.i];
  if (field === 'hasDeadline') {
    // Only one stop can have the deadline.
    state.trip.stops.forEach((s) => { s.deadline = null; });
    if (el.checked) stop.deadline = '08:00';
    saveTrip(); render(); return;
  }
  if (field === 'deadline') stop.deadline = el.value || stop.deadline;
  else stop[field] = Math.max(0, parseInt(el.value, 10) || 0);
  saveTrip();
});

// ---------- Start up ----------

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (!state.apiKey) {
    state.view = 'settings';
    state.error = 'Welcome! Paste your Google Maps API key to get started.';
    render();
    return;
  }
  render();
  try {
    await loadGoogleMaps(state.apiKey, () => fail('Google rejected the API key. Check that it is correct and allowed for this website (see README).'));
    state.mapsReady = true;
    render();
  } catch (err) {
    fail(err.message);
  }
}
init();
