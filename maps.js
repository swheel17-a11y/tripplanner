// maps.js — everything that talks to Google, plus the phone's GPS.

const MIN = 60 * 1000;
const LIVE_WINDOW = 60 * MIN; // in "auto" mode, legs leaving within the hour use live traffic

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

/** An address search box. Calls onPick({ name, address, placeId, lat, lng }). */
export async function createPlacePicker(onPick, near) {
  const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
  const el = new PlaceAutocompleteElement(near ? { locationBias: near } : {});
  el.addEventListener('gmp-select', async ({ placePrediction }) => {
    const place = placePrediction.toPlace();
    await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
    onPick({
      name: place.displayName || place.formattedAddress,
      address: place.formattedAddress,
      placeId: place.id,
      lat: place.location.lat(),
      lng: place.location.lng(),
    });
  });
  return el;
}

/** Ask the phone where we are. Needs HTTPS and the user's permission. */
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser has no GPS access.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ name: 'Current location', lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1
        ? 'Location permission is off. Allow it for this site, or type a start address.'
        : 'Could not get your location. Try again, or type a start address.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
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
