// maps.js — everything that talks to Google, plus the phone's GPS.

const MIN = 60 * 1000;
const LIVE_WINDOW = 60 * MIN; // in "auto" mode, legs leaving within the hour use live traffic
export const DAILY_LIMIT = 200; // safety cap on drive-time requests per phone per day

// ---------- Daily safety limit (counted on this phone) ----------

function readUsage() {
  const today = new Date().toDateString();
  try {
    const u = JSON.parse(localStorage.getItem('tp.usage'));
    if (u?.date === today) return u;
  } catch {}
  return { date: today, count: 0 };
}

export const requestsToday = () => readUsage().count;

function countRequest() {
  const u = readUsage();
  if (u.count >= DAILY_LIMIT) {
    throw new Error(`Daily safety limit reached (${DAILY_LIMIT} Google requests on this phone). It resets at midnight.`);
  }
  u.count++;
  localStorage.setItem('tp.usage', JSON.stringify(u));
}

let loading = null;

/** Load the Google Maps JavaScript API once, using the key saved on this phone. */
export function loadGoogleMaps(key, onKeyRejected) {
  if (loading) return loading;
  // Google calls this global if the key is invalid or not allowed on this website.
  window.gm_authFailure = onKeyRejected;
  loading = new Promise((resolve, reject) => {
    window.__gmReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({
      key, v: 'weekly', loading: 'async', callback: '__gmReady',
    });
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error('Could not load Google Maps. Check your connection.')); };
    document.head.append(s);
  });
  return loading;
}

/**
 * Which traffic prediction to ask for:
 *   BEST_GUESS  – Google's normal estimate; for departures soon it leans on LIVE traffic
 *                 (accidents, slowdowns happening right now).
 *   PESSIMISTIC – a "bad day" estimate; safer when planning further ahead.
 */
export function chooseTrafficModel(setting, depart, now) {
  if (setting === 'pessimistic') return 'PESSIMISTIC';
  if (setting === 'live') return 'BEST_GUESS';
  return depart - now <= LIVE_WINDOW ? 'BEST_GUESS' : 'PESSIMISTIC';
}

/**
 * Build the getDuration(legIndex, departDate) function the planner needs.
 * points[k] -> points[k+1] is leg k. Each point is { name, lat, lng }.
 * Identical questions are answered from memory so the planner's guessing doesn't cost extra.
 */
export async function makeDurationFn(points, trafficSetting, now) {
  const { Route } = await google.maps.importLibrary('routes');
  const answers = new Map();
  const modelsUsed = new Set();

  const getDuration = (leg, depart) => {
    // Driving estimates can't start in the past; anything before about now means "leave now".
    const when = depart.getTime() < now.getTime() + MIN ? null : depart;
    const model = chooseTrafficModel(trafficSetting, when ?? now, now);
    modelsUsed.add(model);
    const key = `${leg}|${when ? when.getTime() : 'now'}|${model}`;
    if (!answers.has(key)) {
      countRequest();
      const p = askGoogle(Route, points[leg], points[leg + 1], when, model);
      p.catch(() => answers.delete(key)); // don't remember failures
      answers.set(key, p);
    }
    return answers.get(key);
  };
  getDuration.modelsUsed = modelsUsed;
  return getDuration;
}

async function askGoogle(Route, from, to, when, model) {
  const request = {
    origin: { lat: from.lat, lng: from.lng },
    destination: { lat: to.lat, lng: to.lng },
    travelMode: google.maps.TravelMode?.DRIVING ?? 'DRIVING',
    routingPreference: google.maps.routes.RoutingPreference?.TRAFFIC_AWARE_OPTIMAL ?? 'TRAFFIC_AWARE_OPTIMAL',
    trafficModel: google.maps.TrafficModel?.[model] ?? model,
    fields: ['durationMillis'],
  };
  if (when) request.departureTime = when;
  let routes;
  try {
    ({ routes } = await Route.computeRoutes(request));
  } catch (err) {
    console.error(err);
    throw new Error(`Google couldn't get a drive time to ${to.name}. (${err.message || err})`);
  }
  if (!routes?.length) throw new Error(`No driving route found from ${from.name} to ${to.name}.`);
  return routes[0].durationMillis / 1000;
}

/**
 * Address search (Places API (New)). Returns { suggest(text, near), choose(suggestion) }.
 * We draw our own list so the user can see "Searching…", "No matches", or Google's error.
 */
export async function startPlaceSearch() {
  const { AutocompleteSessionToken, AutocompleteSuggestion } = await google.maps.importLibrary('places');
  // Google bills a run of keystrokes plus the final pick as one "session".
  let token = new AutocompleteSessionToken();

  async function fetchSuggestions(input, near) {
    const request = { input, sessionToken: token };
    if (near) request.locationBias = { center: near, radius: 50000 }; // prefer places near you
    try {
      return await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
    } catch (err) {
      if (near) return fetchSuggestions(input, null); // retry once without the nearby hint
      console.error(err);
      throw new Error(googleErrorText(err, 'address search'));
    }
  }

  return {
    async suggest(input, near) {
      const { suggestions = [] } = await fetchSuggestions(input, near);
      return suggestions.filter((s) => s.placePrediction).map((s) => {
        const p = s.placePrediction;
        return {
          main: (p.mainText ?? p.text).toString(),
          secondary: p.secondaryText?.toString() ?? '',
          prediction: p,
        };
      });
    },
    async choose(suggestion) {
      const place = suggestion.prediction.toPlace();
      try {
        await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      } catch (err) {
        console.error(err);
        throw new Error(googleErrorText(err, 'place lookup'));
      }
      token = new AutocompleteSessionToken(); // the pick ends this session
      return {
        name: place.displayName || suggestion.main,
        address: place.formattedAddress,
        placeId: place.id,
        lat: place.location.lat(),
        lng: place.location.lng(),
      };
    },
  };
}

/** Turn Google's error into something actionable. */
function googleErrorText(err, what) {
  const msg = String(err?.message || err);
  if (/PERMISSION_DENIED|not been used|disabled|not authorized|API_KEY|REQUEST_DENIED|blocked/i.test(msg)) {
    return `Google refused the ${what}. Check that “Places API (New)” is enabled and ticked in your key’s API restrictions. (${msg})`;
  }
  return `Google ${what} failed: ${msg}`;
}

/** Ask the phone where we are. Needs HTTPS and the user's permission. */
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no GPS access.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(new Error(err.code === 1
        ? 'Location permission is off. Allow it for this site, or type a start address.'
        : 'Could not get your location. Try again, or type a start address.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/**
 * Turn GPS coordinates into a street address (Geocoding API).
 * Returns { address } or { error } — never throws, since the address is just a nice-to-have.
 */
export async function addressFor({ lat, lng }) {
  try {
    countRequest();
    const { Geocoder } = await google.maps.importLibrary('geocoding');
    const { results } = await new Geocoder().geocode({ location: { lat, lng } });
    return results?.[0] ? { address: results[0].formatted_address } : { error: 'No street address found here.' };
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || err);
    return {
      error: /REQUEST_DENIED|not authorized|not enabled|PERMISSION/i.test(msg)
        ? 'To show the street address, turn on “Geocoding API” and tick it in your key’s API restrictions.'
        : `Couldn’t look up the street address. (${msg})`,
    };
  }
}

/** Rough distance in meters between two GPS points (fine for "did I move?"). */
export function metersBetween(a, b) {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/**
 * A link that opens the Google Maps app (iPhone or Android) with every stop filled in.
 * No origin is given, so Maps starts from wherever the phone is right now.
 */
export function googleMapsUrl(places) {
  const fmt = (p) => p.address || `${p.lat},${p.lng}`;
  const last = places[places.length - 1];
  const middle = places.slice(0, -1);
  const q = new URLSearchParams({ api: '1', travelmode: 'driving', destination: fmt(last) });
  if (last.placeId) q.set('destination_place_id', last.placeId);
  if (middle.length) {
    q.set('waypoints', middle.map(fmt).join('|'));
    if (middle.every((p) => p.placeId)) q.set('waypoint_place_ids', middle.map((p) => p.placeId).join('|'));
  }
  return 'https://www.google.com/maps/dir/?' + q;
}
