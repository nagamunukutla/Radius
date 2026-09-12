# Radius

> Commute Drag index measurement to increase the productivity of an IT employee by avoiding traffic

Radius turns "the commute is bad today" into a number you can act on: the **Commute Drag Index (CDI)**, a
0–100 measure of how much your journey is stealing from your working day — and then it tells you the exact
minute to leave, and what that minute is worth in hours and money.

**Live app:** https://nagamunukutla.github.io/Radius/
**Stack:** Vite · React 18 · TypeScript (strict) · Leaflet · no backend, no CDN dependencies

---

## 1. The problem this exists for

An IT professional's day is carved into focus blocks: stand-up, deep work, review, deployment windows. The
commute does not just consume the minutes inside it — it consumes the minutes *around* it. Three effects do
the damage:

| Effect | What it costs |
| --- | --- |
| **Delay** | Time burned at below free-flow speed, twice a day, ~250 days a year. |
| **Unpredictability** | The buffer you must carry to be on time, plus the cognitive load of "will I make stand-up?". |
| **Stop-and-go friction** | Arriving keyed-up: hard braking and signal queues cost recovery time, not just travel time. |

A navigation app optimises the *next* trip. Nothing measures the *recurring tax*, and nothing expresses it in
the units a developer or engineering manager actually cares about — recoverable focus hours. Radius does both.

## 2. The Commute Drag Index

CDI is a weighted sum of six factors, each 0–100, each derived from a measurable quantity. It is deliberately
**auditable**: every factor in the UI carries the numbers that produced it.

| # | Factor | Weight | Measured from |
| --- | --- | --- | --- |
| 1 | **Delay burden** | 30 % | predicted travel time ÷ free-flow travel time |
| 2 | **Unpredictability** | 18 % | spread between the median and the 95th percentile of the travel-time distribution |
| 3 | **Stop-and-go friction** | 15 % | share of route distance below 25 km/h + deceleration events per 10 km, from per-edge router speeds |
| 4 | **Weather penalty** | 10 % | live precipitation, wind and WMO condition code at your origin |
| 5 | **Distance & alternatives** | 12 % | route length vs. whether a bike/transit pressure valve exists on the corridor |
| 6 | **Time tax** | 15 % | minutes beyond a 25-minute healthy one-way budget |

Bands: `0–19 Smooth` · `20–39 Manageable` · `40–59 Strained` · `60–79 Heavy Drag` · `80–100 Gridlock Mode`.

The full math — the congestion curve, the free-flow anchoring trick, the lognormal reliability band and every
normalisation anchor — is specified in **[docs/METHODOLOGY.md](docs/METHODOLOGY.md)** and implemented in
[`app/src/lib/cdi.ts`](app/src/lib/cdi.ts) and [`app/src/lib/congestion.ts`](app/src/lib/congestion.ts), each
covered by unit tests.

## 3. What the app shows

- **Gauge + band** — the index, one headline judgement, and the band's meaning.
- **Leave at HH:MM** — the recommendation nudge: how long to wait, what it saves, in minutes and index points.
- **Where the drag comes from** — the six factors, weighted, ranked by `score × weight`, with their raw numbers.
- **Route & congestion shape** — Leaflet map, route coloured by per-segment speed, popups with distance/time per
  stretch, A/B markers.
- **Departure curve** — travel minutes and CDI for every 6-minute slot around your work start, worst slot marked,
  best slot pinned; "plan this" re-runs the whole evaluation as if you left at that minute.
- **Productivity impact** — wasted minutes/week, hours/year, money at your own rate, reclaimable hours if you move
  your departure, weekly CO₂.
- **Model & data** — a provenance table that states which feed is live, which is estimated, and why.

## 4. Data sources, honesty and failure behaviour

| Need | Source | Key? | If it fails |
| --- | --- | --- | --- |
| Route, distance, typical duration, per-edge speeds | [OSRM](https://project-osrm.org) public demo | no | deterministic built-in estimator ( bowed geometry + speed profile ) |
| Geocoding / reverse geocoding | [Nominatim](https://nominatim.openstreetmap.org) | no | built-in gazetteer + coordinate labels |
| Weather now + hourly | [Open-Meteo](https://open-meteo.com) | no | weather penalty neutralised at 0, flagged in notes |
| Basemap tiles | OpenStreetMap | no | route still drawn, tile warning shown |
| Live traffic flow (optional) | [TomTom Traffic Flow](https://developer.tomtom.com) | your key | falls back to the demand model |

Two design rules follow from this table, and they are what "without any failures" means here:

1. **Every dependency is optional.** Each call is timeout-bounded and wrapped; if the whole network is down the
   app still renders a complete evaluation through `emergencyEstimate()`, labels it as an offline estimate, and
   says so in the notes. `npm test` includes a case where *all four* services reject.
2. **Never pretend to know more than it does.** The public OSRM endpoint carries *typical* conditions, not live
   incidents, so the index compresses its extremes when no live feed is connected (`trafficConfidence`) and the
   UI prints the exact caveat. Add a TomTom key in Settings and the delay factor becomes measured, not modelled.

**Privacy:** Radius has no server. Trips, rate and settings live in `localStorage` in your browser; queries go
straight from your browser to the providers above. An API key you paste is never sent anywhere but to TomTom.

## 5. Repository layout

```
app/
  src/
    lib/         types, congestion model, CDI scoring, routing, weather,
                 geo, evaluate (orchestration), storage, util  ← pure + tested
    components/  ScoreGauge, FactorList, DepartureChart, MapView,
                 PlaceInput, ProductivityPanel, SettingsPanel
    App.tsx      state, live refresh loop, layout
    ui.test.tsx  render smoke tests (all APIs down / realistic payloads)
  vite.config.ts  base './' → deploys to any sub-path
docs/METHODOLOGY.md  the model, in full
.github/workflows/deploy.yml  typecheck → test → build → Pages
```

## 6. Run it locally

```bash
cd app
npm install
npm run dev        # http://localhost:5173
npm test           # 18 tests: engine maths + failure-resilience renders
npm run build      # typecheck (tsc --noEmit) + production bundle in app/dist
npm run preview    # serve the built bundle
```

## 7. Hosting on GitHub Pages

`.github/workflows/deploy.yml` runs on every push to `main` and on pull requests:

1. `npm ci` → `npm run typecheck` → `npm test` → `npm run build`
2. `app/dist` is published with `actions/upload-pages-artifact` and deployed with `actions/deploy-pages`

A `workflow_dispatch` trigger is included, so you can redeploy by hand from the Actions tab.

**One-time enablement** (repo admin, 30 seconds): *Settings → Pages → Build and deployment → Source: GitHub
Actions.* That is the only setting the workflow cannot set for itself. `base: "./"` in `vite.config.ts` keeps
asset URLs relative, so the build works from `https://<user>.github.io/Radius/` with no path configuration.

To host it anywhere else, use a different `base` (or keep `./`) and copy `app/dist` — it is a static bundle.

## 8. Roadmap

- [ ] Multi-commute comparison table (home→office, office→gym, school run) in one view
- [ ] Hybrid planner: which 2 of 5 days to work remotely to minimise the weekly index
- [ ] PWA + background sync so the "leave at" nudge arrives before you are deciding, not after
- [ ] Employer mode: corridor-level aggregate CDI for a team, to pick office hours that fit everyone
- [ ] Self-hosted OSRM + actual live-traffic provider swap (HERE, TomTom, HERE RID)

## Licence

MIT — see [LICENSE](LICENSE). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
