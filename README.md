# Trip Planner

A phone web app (PWA) that works **backward from a deadline** to tell you when to leave.

Enter a start (GPS or an address), an ordered list of stops with "time at this stop", and mark
one stop as "must arrive by" (plus how early you want to be). The app asks Google for drive
times with traffic, and shows a big **LEAVE AT** time plus a timeline for every stop.

- **Traffic:** in *Auto* mode, legs leaving within the hour use **live** traffic (accidents,
  slowdowns right now). Legs further out use Google's **pessimistic** "bad day" estimate.
- **Auto-refresh:** once leave time is under an hour away, the Leave screen re-checks traffic
  every 5 minutes while it's open, and warns you if you need to leave earlier.
- **Saved trips:** save a trip by name and reload it later. Everything stays on your phone.
- **Open in Google Maps:** hands all your stops to the Google Maps app for navigation.

No backend, no build step: plain HTML/CSS/JavaScript.

| File | What it does |
|---|---|
| `planner.js` | The backward-timing math (no Google code; tested in `tests/`) |
| `maps.js` | Talks to Google: drive times, address search, GPS, Maps link |
| `app.js` | Screens, saved trips, auto-refresh |
| `index.html`, `style.css` | Page and layout |
| `manifest.json`, `sw.js`, `icons/` | What makes it installable on your home screen |

---

## 1. Get a Google Maps API key (one time, ~10 minutes)

1. Go to <https://console.cloud.google.com> and sign in. At the top, **Select a project → New
   project**, name it `Trip Planner`.
2. **Billing:** Google needs a card on file even for free use (menu ☰ → *Billing*). Personal
   use of this app should stay within Google's free monthly usage. Check current pricing at
   <https://mapsplatform.google.com/pricing/>.
3. **Turn on 4 APIs:** ☰ → *APIs & Services → Library*. Search for and **Enable** each one:
   - **Maps JavaScript API**
   - **Places API (New)**
   - **Routes API**
   - **Geocoding API** (shows the street address of your GPS location)
4. **Create the key:** *APIs & Services → Credentials → + Create credentials → API key*.
   Copy it, then click **Edit API key** to lock it down:
   - **Application restrictions → Websites**, then add
     `https://YOUR-GITHUB-USERNAME.github.io/*`.
     The key now only works on your site. Anyone who copies it can't use it elsewhere.
   - **API restrictions → Restrict key**, then tick only the 4 APIs above. **Save.**
5. **Daily safety limit:** Google doesn't let you lower the Routes API daily quota, so the app
   has its own cap of **200 drive-time requests per phone per day**. Today's count is in
   *Settings → Usage today*. One "When do I leave?" uses roughly 5–10.
6. **Budget alert** (an email warning, so you'd hear about anything unusual): ☰ → *Billing → Budgets & alerts → Create
   budget*, set $5, keep the default alert emails.

The key is **never put in the code**. You paste it into the app's **Settings** screen, and it's
saved only on that phone. The code can therefore be public on GitHub safely.

> Testing on a computer? Make a *second* key restricted to `http://localhost:*/*` so your real
> key never allows localhost.

## 2. Host it free with GitHub Pages (gives you the HTTPS that GPS + install need)

1. Push this code to a **public** GitHub repo (free Pages needs public; there are no secrets in
   the code).
2. On GitHub: repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   **Branch: `main`**, folder **`/ (root)`** → **Save**.
3. After a minute your app is at `https://YOUR-GITHUB-USERNAME.github.io/tripplanner/`.
   This must match the website restriction from step 4 above.

Updating later: push to `main` and Pages redeploys in about a minute. The app always tries to
load the newest files first, so a reopen picks up changes.

## 3. Put it on your home screen

- **iPhone (Safari):** open the URL → **Share** button → **Add to Home Screen**.
- **Android (Chrome):** open the URL → **⋮** menu → **Install app** (or *Add to Home screen*).

On first open: **Settings** → paste your key → **Save key**. Allow location when asked.

> iPhone note: the home-screen app keeps its **own** storage, separate from Safari. Add the key
> and trips inside the installed app. Use *Settings → Export* now and then to back up saved trips.

## Set up another phone (family)

On a phone that already works: **Settings → Share with family → Send setup link**, then send it
by text. It carries your key (and, if ticked, your saved trips) after the `#` in the link, which
browsers never send to any server. Only send it to people you trust.

On the other iPhone: tap the link → it opens in Safari, already set up → tap **📋 Copy setup
link** → **Share ⬆︎ → Add to Home Screen** → open Trip Planner from the home screen. The
home-screen app has its own storage; if it asks for a key, tap **📋 Paste** in Settings (the
copied link works there).

## How the timing works

Google's drive times need a **departure** time, but you have an **arrival** deadline. So for each
leg, working backward from the deadline stop:

1. Guess a departure, ask Google how long the drive takes if you leave then.
2. Move the departure so that drive time lands you on target; ask again.
3. Stop when you arrive within a minute of the target (usually 2–3 tries, at most 5).
4. Subtract the "time at this stop" to get when you must arrive at the previous stop, and repeat
   back to the start.

Stops after the deadline are calculated forward. If it's already too late to follow the plan,
the app says **Leave now** and how late you'll be. If today's deadline has passed, it plans
for tomorrow. Leave times are rounded down and arrival times rounded up, so rounding never
makes you late.

## Developing

```sh
npm test          # runs the timing-math tests (Node 20+)
npm start         # serves http://localhost:8000 (needs Python 3)
```
