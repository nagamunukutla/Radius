# Radius — Commute Drag Index methodology

Everything the UI displays is derived from the six steps below. No step is hidden in a component: they live in
`app/src/lib/congestion.ts` (steps 1–2), `app/src/lib/cdi.ts` (steps 3–4), `app/src/lib/departure.ts` (step 5),
`app/src/lib/transit.ts` (step 6) and `app/src/lib/evaluate.ts`
(orchestration), and each is covered by `app/src/lib/cdi.test.ts`.

---

## Step 1 — Recover a free-flow reference from the router

The router (OSRM) returns `typicalSeconds`: the duration of the best route under *average* conditions for the
current time of day. It already contains an unknown amount of congestion, which makes it useless as a baseline
for "how much worse is 08:30 than free flow?".

Radius therefore divides the router answer by its own demand model evaluated **at request time with weather
removed**, to back out an uncongested reference:

```
freeflowSeconds = clamp( typicalSeconds / max(1.02, modelFactor(now, weather = 0)),
                         typicalSeconds × 0.42,        // never claim more than ~2.4× free-flow
                         typicalSeconds )
```

Property worth noting: this anchors the *absolute level* to real road geometry (the router's answer) while
letting the *shape over time* come from the demand model. A route through a 30 km/h village and a route on the
motorway at the same duration get the same index — correctly, because their drag really is comparable.

## Step 2 — The demand and weather curve

`delayBreakdown(ctx)` returns the travel-time multiplier relative to free flow at a given minute of a given day:

```
demand(t) = Σ Gaussian(t; centre, width, amplitude)
factor(t) = 1 + demand(t) × severity × dayWeight          (weekday)
          = 1 + Gaussian(t; 13, 3.2, 0.16) × severity × 0.5 (Saturday, 0.3 Sunday)
predicted = freeflow × factor(t) × weatherFactor
```

| Component | Parameters | Rationale |
| --- | --- | --- |
| AM commuter peak | centre = user's `peakAm` (default 08:30), width 0.62 h, amplitude 0.58, plus a 0.20 bump at `peakAm − 24 min` | school/creche run starts early and everybody leaves within the same few minutes |
| PM commuter peak | centre = `peakPm` (default 18:00), width 1.05 h, amplitude 0.62, plus 0.16 at `peakPm + 66 min` | broader: staggered finishing times, school pickup, errands |
| Midday / freight shoulder | width 1.3 h, amplitude 0.10 at 13:00, and 0.12 at 06:36 | lunch traffic and delivery vehicles |
| Day weight | Mon/Fri ×1.06, Sat ×0.5, Sun ×0.3 | Fridays have the early exodus, Mondays the 07:00 crush |
| `severity` | user slider 0.6–1.5 (default 1.0) | the same curve is far worse in Bengaluru than in a market town |
| `weatherFactor` | `1 + (weatherPoints / 100) × 0.34` | a saturated downpour realistically costs ~34 % on a mixed network |

`factor` is clamped to `1 … 3.6` — 3.6× is the practical ceiling before "just leave later" stops being advice.

**Weather points** (`weatherFrictionPoints`) is `max(precipScore, windScore) × 0.72 + codeScore × 0.6 +
thermalScore × 0.35`, clamped to 0–100, where the code score reads WMO codes (fog 34, snow 48, thunderstorm 52,
heavy rain 30, …). Taking the *max* of precipitation and wind rather than the sum avoids double-counting a
single storm.

## Step 3 — Reliability, not just averages

Travel time is right-skewed, so a mean understates the buffer a human must carry. Radius models the distribution
as lognormal with coefficient of variation

```
cv = clamp( 0.045 + 0.20 × √(factor − 1) + min(0.09, km / 620) + 0.07 × weatherPoints/100 , 0.03, 0.62 )
```

and reports the **95th percentile** as the buffer:

```
σ = √(ln(1 + cv²));  μ = ln(median) − σ²/2;  p95 = exp(μ + 1.645σ)   (clamped to median × 1.02 … 3)
```

Two consequences: a longer trip and a congested trip are both less predictable, and the recommended departure
minute pays for buffer, not just for minutes — which is why the "best" slot is sometimes 4 minutes slower in
exchange for 11 fewer minutes of variance.

## Step 4 — Six factors, one weighted sum

Each raw metric is mapped to 0–100 by piecewise-linear interpolation between published anchors
(`normalize()` in `app/src/lib/util.ts`). Anchors, in `(value → score)` form:

| Factor | Anchors | Weight |
| --- | --- | --- |
| Delay burden (ratio) | 1→0, 1.18→22, 1.35→42, 1.7→70, 2.1→88, 2.6→100 | 0.30 |
| Unpredictability (cv) | 0.03→0, 0.08→24, 0.16→52, 0.28→78, 0.45→100 | 0.18 |
| Stop-and-go (slow share) | 0.02→0, 0.1→26, 0.2→55, 0.33→80, 0.5→100 | 0.15 (×0.68, combined with ↓) |
| Stop-and-go (events/10 km) | 0.4→0, 1.8→28, 3.5→58, 6→84, 9→100 | 0.15 (×0.32, combined with ↑) |
| Weather penalty | the raw 0–100 weather points | 0.10 |
| Distance (km) | 3→6, 10→26, 20→50, 35→74, 50→90, 70→100 | 0.12 (×0.72 and −6 if an alternative mode exists) |
| Time tax (min over 25) | 0→0, 10→14, 25→38, 45→66, 70→88, 100→100 | 0.15 |

Weights sum to exactly 1.00 — asserted in a unit test, so the 0–100 claim stays true.

### Confidence damping

Without a live feed, delay is modelled rather than measured, so its extremes are pulled toward the median case:

```
delayScore = 18 + (delayAnchorScore − 18) × (0.55 + 0.45 × trafficConfidence)
trafficConfidence = 1.0                       with a live TomTom answer
                  = 0.35 … 0.95               router reachable … router unreachable
```

The result is that Radius will not tell you "Gridlock Mode" off a model alone; it will tell you "Heavy Drag" and
show the caveat. A test asserts that lower confidence yields a strictly lower score for identical inputs.

### Bands

| CDI | Band | Meaning |
| --- | --- | --- |
| 0–19 | Smooth | your commute is not stealing from your day |
| 20–39 | Manageable | some drag, plannable |
| 40–59 | Strained | real focus time is being lost twice a day |
| 60–79 | Heavy Drag | a second shift — move the departure minute |
| 80–100 | Gridlock Mode | rethink route, hours or office days |

## Step 5 — The departure sweep

`evaluate.ts` builds a `TripShape` for the mode you chose — ride minutes, access minutes, how much of the ride
traffic can touch (`congestionSensitivity`), how much of it the weather can touch (`weatherExposure`), the service
headway, and the free-flow reference — then `departure.ts` sweeps candidate departures across a window **derived
from that trip**, not from the clock:

```
latestDeparture = workStart − 1.25 × (freeflow + access) − 6 min
window  = [ max(earliestFloor, latestDeparture − 115) , latestDeparture + 70 ]
          clamped to 05:00–23:55, step 6–15 min so the curve never exceeds ~45 points
```

"now" is folded into the left edge only when it is inside the decision zone
(`now ≥ latestDeparture − 175`); otherwise an 11:00 start gets plotted from 08:35 onward rather than from dawn,
which is precisely how the first version came to recommend leaving at 07:05 for an 11:00 start.

For each slot: the demand factor **at that clock**, the weather **for that hour**, the mode-aware minute model
below, the lognormal buffer, the lateness risk, that slot's own CDI, and a cost.

```
ride  = rideMinutes × (1 + peakExcess × congestionSensitivity) × weatherMult
access = accessMinutes × (1 + 0.22 × weatherPoints × exposure)
wait  = headway/2 × (1 + 0.28 × peakExcess) + transfers × (headway/2 + 3.5)
buffer = max(lognormal p95 − median, 0.6 × headway + weather, 1 min)
```

The headway floor on the buffer is the point: for frequent transit the dominant risk is *missing the vehicle*,
which costs a whole headway, and a traffic-variance model alone would never predict it.

### The objective

```
cost = travel + 0.5·buffer + 0.55·wait + 0.85·max(0, early − tolerance) + 2.2·late
     + 9·max(0, risk − budget) + 0.06·CDI(slot)
```

Weights per philosophy (`balanced`, `latest`, `lowestDrag`, `protectMorning`) change only the *early* and *risk*
terms, so "I don't mind an empty office at 07:00" and "do not wake me" are preference statements, not different
physics. `lateRisk(travel, buffer, slack)` is the lognormal tail probability
`1 − Φ((ln slack − ln travel)/σ)` with `σ = ln(1 + buffer/travel)/1.645`.

Two rules make the answer trustworthy rather than merely optimal:

1. **Risk gate.** Slots above the lateness budget are ineligible whenever any compliant slot exists, so the
   recommendation can never arrive after the `leave no later than` deadline it publishes. If none is compliant, the
   best is shown *with* a note that the corridor and the start time are incompatible.
2. **Floor, with a release valve.** Nothing is recommended before `earliestDepartureMinutes`; but if that would
   leave zero candidates, the earlier slots are shown and the note says how many were excluded. The planner failing
   to answer is a worse outcome than the planner answering inconveniently.

## Step 6 — Public transport

No key-free, worldwide, CORS-enabled **timetable** API exists, so Radius does not pretend to have one. It measures
what is measurable and models the rest, explicitly:

| Quantity | Source |
| --- | --- |
| Which stops exist near both ends | Overpass query on OpenStreetMap: `railway=station/halt/tram_stop/subway_entrance`, `station=subway/lightRail/monorail`, `highway=bus_stop` (nodes *and* ways, `out center`) |
| Which mode, and the walk to it | nearest candidate per kind, platforms of one station collapsed by name, metro ≻ rail ≻ tram ≻ bus at equal distance |
| Access and egress walk | crow-flight × 1.32 street factor at 4.7 km/h (78 m/min) |
| In-vehicle time | real station-to-station distance × per-mode detour ÷ per-mode link speed, plus dwell per stop |
| Waiting | half the mode headway × `1 + 0.28 × peak`, scaled by `citySeverity` |
| Transfers | 0 for rail or trips under 4 km, else 1 (+half a headway +3.5 min to change platforms) |
| Reject | any mode whose walk exceeds your limit, or whose stops are closer together than the trip |

Per-mode constants (speed incl. stops, peak headway, stop spacing, detour, outdoor share): metro 36 km/h / 4 min /
1.25 km / 1.16 / 0.10 · commuter rail 47 / 12 / 3.6 / 1.28 / 0.30 · tram 22 / 8 / 0.62 / 1.30 / 0.55 · bus
16 / 10 / 0.7 / 1.44 / 0.85.

Because the walk and the station geometry are measured, "the metro is faster than the bus *and* kinder in rain"
is a conclusion rather than an assumption. Because headways are modelled, the absolute minutes should be read as
±10 % — and the card says exactly that, in the app, next to the itinerary.

## Known limitations (stated, not hidden)

1. **No incident feed by default.** The public OSRM demo has no live traffic and no accident awareness. The
   optional TomTom key closes this gap; without it, delay is a calibrated model.
2. **City-scale peaks, not corridor-scale.** One demand curve applies to the whole route, so a route that is
   90 % motorway and 10 % school-zone will under-represent the second part. Per-edge speeds partially compensate.
3. **Transit minutes are modelled, not scheduled.** Stops, walking distances and station-to-station geometry come
   from OpenStreetMap; headways, link speeds and the transfer penalty do not, because Radius has no timetable. It
   will happily price a 4-minute metro that stopped running at 22:00. Feeding it GTFS is the obvious next step.
4. **No "no service" guard.** Late or split shifts are scored with the same headway as peak service.
5. **Local time uses the browser's clock.** Cross-timezone planning (remote workers, travel days) is not modelled.

Contributions that replace any heuristic with a measured feed are welcome — the seams are all behind
`fetchRoutes` / `fetchWeather` / `fetchTomTomFlowRatio`.
