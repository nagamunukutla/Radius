# Radius — Commute Drag Index methodology

Everything the UI displays is derived from the four steps below. No step is hidden in a component: they live in
`app/src/lib/congestion.ts` (steps 1–2), `app/src/lib/cdi.ts` (steps 3–4) and `app/src/lib/evaluate.ts`
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

## Step 5 — The departure sweep and the recommendation

`evaluate.ts` sweeps candidate departures every **6 minutes** across a ±3.5 h window around
`workStart − 25 min` (clamped to 05:00–23:00, and only slots in the future). For each slot it recomputes: the
demand factor *at that clock time*, the weather *for that hour* from the hourly forecast, the resulting travel
time, the p95 buffer, a slow-share scaled by the factor, and therefore the slot's own CDI.

The recommended slot minimises

```
score(slot) = travelMinutes + bufferMinutes + 0.06 × CDI(slot)
```

among slots that still land **at or before the work start**; if none do, it picks the best future slot. The 0.06
tie-breaker is the only place the index feeds back into the decision — it stops the planner recommending a
technically-faster minute that is miserable to drive.

`productivityOf()` then converts: `wasted = (predicted − freeflow) + buffer` per direction, `× 2 × daysPerWeek`,
annualised over 46 working weeks, priced at the user's own hourly rate. `reclaimableWeeklyHours` is the gap
between leaving now and leaving at the recommended minute — the number the recommendation has to earn.

## Known limitations (stated, not hidden)

1. **No incident feed by default.** The public OSRM demo has no live traffic and no accident awareness. The
   optional TomTom key closes this gap; without it, delay is a calibrated model.
2. **City-scale peaks, not corridor-scale.** One demand curve applies to the whole route, so a route that is
   90 % motorway and 10 % school-zone will under-represent the second part. Per-edge speeds partially compensate.
3. **Transit is a heuristic** (`drive × 1.45 + 11 min` when the trip exceeds 4 km) — not a timetable. It is used
   only for the "is there a pressure valve?" factor, never as a recommendation.
4. **Local time uses the browser's clock.** Cross-timezone planning (remote workers, travel days) is not modelled.

Contributions that replace any heuristic with a measured feed are welcome — the seams are all behind
`fetchRoutes` / `fetchWeather` / `fetchTomTomFlowRatio`.
