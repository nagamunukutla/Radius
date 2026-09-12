import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DepartureChart from "./components/DepartureChart";
import FactorList from "./components/FactorList";
import MapView from "./components/MapView";
import PlaceInput from "./components/PlaceInput";
import ProductivityPanel from "./components/ProductivityPanel";
import ScoreGauge from "./components/ScoreGauge";
import SettingsPanel from "./components/SettingsPanel";
import { evaluateCommute, emergencyEstimate } from "./lib/evaluate";
import {
  loadRecent,
  loadSaved,
  loadSettings,
  newId,
  persistSaved,
  pushRecent,
  saveSettings,
  type SavedCommute,
} from "./lib/storage";
import { DEFAULT_SETTINGS, type CommuteEvaluation, type Place, type UserSettings } from "./lib/types";
import { humanDuration, money, round } from "./lib/util";

const START_FROM: Place = { name: "Ontinyent, València, Spain", short: "Ontinyent", lat: 38.8217, lon: -0.6059 };
const START_TO: Place = { name: "València, Spain", short: "València", lat: 39.4699, lon: -0.3763 };

type Status = "idle" | "loading" | "ready" | "error";

export default function App() {
  const [settings, setSettings] = useState<UserSettings>(() => ({ ...DEFAULT_SETTINGS, ...loadSettings() }));
  const [from, setFrom] = useState<Place | null>(START_FROM);
  const [to, setTo] = useState<Place | null>(START_TO);
  const [recent, setRecent] = useState<Place[]>(() => loadRecent());
  const [saved, setSaved] = useState<SavedCommute[]>(() => loadSaved());
  const [evaluation, setEvaluation] = useState<CommuteEvaluation | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [departOffset, setDepartOffset] = useState(0);
  const [countdown, setCountdown] = useState(settings.refreshSeconds);
  const [paused, setPaused] = useState(false);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef<AbortController | null>(null);

  const persistSettings = useCallback((patch: Partial<UserSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    if (!from || !to) {
      setStatus("idle");
      setEvaluation(null);
      return;
    }
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setStatus((s) => (s === "ready" ? "ready" : "loading"));
    try {
      const res = await evaluateCommute({ from, to, settings, departInMinutes: departOffset, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setEvaluation(res);
      setStatus("ready");
      setError(null);
      setCountdown(settings.refreshSeconds);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      // Never leave the user with a blank screen.
      setEvaluation(emergencyEstimate(from, to, settings));
      setStatus("error");
      setError(err instanceof Error ? err.message : "Live lookup failed; showing the offline estimate.");
    }
  }, [from, to, settings, departOffset]);

  // Re-evaluate whenever the trip or the model inputs change (debounced so the
  // settings sliders do not fire a request per pixel).
  useEffect(() => {
    const t = setTimeout(() => void run(), 240);
    return () => clearTimeout(t);
  }, [run, nonce]);

  // Live loop.
  useEffect(() => {
    if (paused || settings.refreshSeconds <= 0) return;
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          void run();
          return settings.refreshSeconds;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [paused, run, settings.refreshSeconds]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const pickFrom = useCallback((p: Place) => {
    setFrom(p);
    setRecent(pushRecent(p));
  }, []);
  const pickTo = useCallback((p: Place) => {
    setTo(p);
    setRecent(pushRecent(p));
  }, []);

  const swap = () => {
    setFrom(to);
    setTo(from);
  };

  const saveTrip = () => {
    if (!from || !to) return;
    const entry: SavedCommute = {
      id: newId(),
      label: `${from.short} → ${to.short}`,
      from,
      to,
      createdAt: Date.now(),
    };
    const next = [entry, ...saved.filter((s) => s.label !== entry.label)].slice(0, 12);
    setSaved(next);
    persistSaved(next);
  };

  const useSaved = (s: SavedCommute) => {
    setFrom(s.from);
    setTo(s.to);
    setDepartOffset(0);
  };

  const removeSaved = (id: string) => {
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    persistSaved(next);
  };

  const e = evaluation;
  const tripKey = useMemo(() => `${from?.lat},${from?.lon}|${to?.lat},${to?.lon}`, [from, to]);

  const headline = useMemo(() => {
    if (!e) return "";
    if (e.recommended && e.savings && e.savings.minutes > 1) {
      return `Leave at ${e.recommended.clock} instead — ${e.savings.minutes} min less driving and ${Math.max(0, e.cdi.score - e.recommended.cdi)} points off your drag.`;
    }
    if (e.recommended && e.recommended.minutesFromNow < 12) {
      return "Now is already the cheap minute. Go — the curve only gets worse from here.";
    }
    if (e.cdi.score >= 60) {
      return "This commute is taxing your week. The lever that works is the minute you leave, not the road you take.";
    }
    return "Your corridor is behaving. Hold the slot that produced this score.";
  }, [e]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="18" fill="#0c1220" stroke="rgba(255,255,255,0.1)" />
            <g className="ring">
              <circle cx="20" cy="20" r="14" fill="none" stroke="#38e1c0" strokeWidth="2.4" strokeDasharray="62 26" strokeLinecap="round" />
            </g>
            <circle cx="20" cy="20" r="4.6" fill="#ff9f68" />
            <circle cx="20" cy="20" r="8.4" fill="none" stroke="rgba(255,159,104,0.35)" strokeWidth="1" />
          </svg>
          <div>
            <h1>Radius</h1>
            <p className="tagline">
              Commute Drag Index measurement to increase the productivity of an IT employee by avoiding traffic.
            </p>
          </div>
        </div>
        <div className="topbar-spacer" />
        <div className="live-pill" title="Radius refreshes route, weather and traffic on this cadence">
          <span className={`dot ${status === "error" ? "err" : paused || settings.refreshSeconds === 0 ? "off" : "live"}`} />
          {status === "loading" && !e
            ? "measuring…"
            : settings.refreshSeconds === 0
              ? "manual mode"
              : paused
                ? "paused"
                : `live · refresh in ${countdown}s`}
          <button className="btn small ghost" type="button" onClick={() => setPaused((v) => !v)} disabled={settings.refreshSeconds === 0}>
            {paused ? "resume" : "pause"}
          </button>
          <button className="btn small" type="button" onClick={() => setNonce((n) => n + 1)} disabled={status === "loading"}>
            refresh now
          </button>
        </div>
      </header>

      {(error || (e && e.degraded)) && (
        <div className={`banner ${error ? "err" : ""}`} role="status">
          {error
            ? `${error} Radius switched to its offline estimator so the panel is never empty.`
            : "Part of the data could not be reached from this network. Radius is showing built-in estimates for the missing pieces — the index stays computed, the notes say exactly what was substituted."}
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row">
          {from ? (
            <PlaceInput id="from" label="From (home)" value={from} onPick={pickFrom} recent={recent} />
          ) : (
            <PlaceInput id="from" label="From (home)" value={null} onPick={pickFrom} recent={recent} />
          )}
          <button className="btn swap" type="button" onClick={swap} title="Swap home and work" aria-label="Swap home and work">
            ⇄
          </button>
          <PlaceInput id="to" label="To (work)" value={to} onPick={pickTo} recent={recent} />
          <button className="btn primary" type="button" onClick={() => setNonce((n) => n + 1)} disabled={!from || !to || status === "loading"}>
            {status === "loading" ? "Measuring…" : "Measure drag"}
          </button>
          <button className="btn" type="button" onClick={saveTrip} disabled={!from || !to}>
            Save trip
          </button>
        </div>
        {e && (
          <div className="stats" style={{ marginTop: 14 }}>
            <div className="stat">
              <b>{humanDuration(e.predictedMinutes)}</b>
              <span>predicted each way</span>
            </div>
            <div className="stat">
              <b>{humanDuration(e.freeflowMinutes)}</b>
              <span>free-flow</span>
            </div>
            <div className="stat">
              <b>+{round(e.p95Minutes - e.medianMinutes, 0)} min</b>
              <span>95% reliability buffer</span>
            </div>
            <div className="stat">
              <b>{round(e.distanceKm, 1)} km</b>
              <span>{e.route.source === "osrm" ? "routed distance" : "estimated distance"}</span>
            </div>
            <div className="stat">
              <b>{e.weather.frictionPoints}</b>
              <span>weather friction · {e.weather.label}</span>
            </div>
            {e.modes.bikeSeconds ? (
              <div className="stat good">
                <b>{humanDuration(e.modes.bikeSeconds / 60)}</b>
                <span>by bike, if you dare</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="grid">
        <div className="stack">
          <section className="card">
            <header>
              <h2>Drag index</h2>
              <span className="hint">
                {e ? `generated ${new Date(e.generatedAt).toLocaleTimeString()}` : "awaiting a trip"}
              </span>
            </header>
            {!e ? (
              <div>
                <div className="skeleton" style={{ height: 150 }} />
                <div className="skeleton sk-line" style={{ width: "70%" }} />
                <div className="skeleton sk-line" style={{ width: "55%" }} />
              </div>
            ) : (
              <div className="hero">
                <ScoreGauge score={e.cdi.score} band={e.cdi.band} />
                <div>
                  <h3>{headline}</h3>
                  <p className="lede">
                    {e.cdi.band.blurb} Index is the weighted sum of six measured factors, so every point is
                    attributable below.
                  </p>
                  {e.recommended && (
                    <div className="nudge">
                      {e.savings && e.savings.minutes > 1 ? (
                        <>
                          Leave at <strong>{e.recommended.clock}</strong> · arrive{" "}
                          <strong>{arrivalLabel(e.recommended.minutesFromNow + e.recommended.travelSeconds / 60)}</strong> ·{" "}
                          {humanDuration(e.recommended.travelSeconds / 60)} in the car (CDI {e.recommended.cdi}).
                          Waiting <strong>{Math.max(1, Math.round(e.recommended.minutesFromNow))} min</strong> saves{" "}
                          <strong>{e.savings.minutes} min</strong>.
                        </>
                      ) : (
                        <>
                          Leaving now is optimal: <strong>{humanDuration(e.predictedMinutes)}</strong>, arrive{" "}
                          <strong>{arrivalLabel(departOffset + e.predictedMinutes)}</strong>. Next best slot{" "}
                          {e.recommended.clock} is within a minute of this.
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {e && (
            <section className="card">
              <header>
                <h2>Where the drag comes from</h2>
                <span className="hint">weighted, auditable, 0–100 each</span>
              </header>
              <FactorList factors={e.cdi.factors} />
            </section>
          )}

          {e && (
            <section className="card">
              <header>
                <h2>Route & congestion shape</h2>
                <span className="hint">
                  {e.route.alternativeCount > 0 ? `${e.route.alternativeCount} alternative${e.route.alternativeCount > 1 ? "s" : ""} scored by router` : "single corridor"}
                </span>
              </header>
              <MapView route={e.route} fromName={from?.short ?? "A"} toName={to?.short ?? "B"} tripKey={tripKey} />
            </section>
          )}

          {e && (
            <section className="card">
              <header>
                <h2>Departure curve</h2>
                <span className="hint">every 6 min around your {clockOf(settings.workStartMinutes)} start</span>
              </header>
              <DepartureChart options={e.departureOptions} recommended={e.recommended} />
              {e.departureOptions.length > 0 && (
                <table className="slots">
                  <thead>
                    <tr>
                      <th>Leave</th>
                      <th>Arrive</th>
                      <th>Drive</th>
                      <th>Buffer</th>
                      <th>CDI</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rankedSlots(e).map((o) => (
                      <tr key={o.clock} className={e.recommended?.clock === o.clock ? "best" : undefined}>
                        <td>{o.clock}</td>
                        <td>{arrivalLabel(o.minutesFromNow + o.travelSeconds / 60)}</td>
                        <td>{round(o.travelSeconds / 60, 0)} min</td>
                        <td>+{round(o.bufferMinutes, 0)} min</td>
                        <td>{o.cdi}</td>
                        <td style={{ textAlign: "right" }}>
                          {e.recommended?.clock === o.clock ? (
                            <span className="chip best">recommended</span>
                          ) : (
                            <button
                              className="btn small ghost"
                              type="button"
                              onClick={() => setDepartOffset(Math.max(0, Math.round(o.minutesFromNow)))}
                            >
                              plan this
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {departOffset > 0 && (
                <p className="notes" style={{ marginTop: 10 }}>
                  Planning as if you leave in {departOffset} min.{" "}
                  <button className="btn small" type="button" onClick={() => setDepartOffset(0)}>
                    back to now
                  </button>
                </p>
              )}
            </section>
          )}
        </div>

        <div className="stack">
          <section className="card">
            <header>
              <h2>Productivity impact</h2>
              <span className="hint">{settings.daysPerWeek} office days</span>
            </header>
            {e ? <ProductivityPanel e={e} settings={settings} /> : <div className="skeleton" style={{ height: 140 }} />}
          </section>

          <section className="card">
            <header>
              <h2>Model & data</h2>
              <span className="hint">what is live right now</span>
            </header>
            <dl className="kv">
              <dt>Routing engine</dt>
              <dd>{e?.route.source === "osrm" ? "OSRM (live)" : e ? "built-in estimator" : "—"}</dd>
              <dt>Weather feed</dt>
              <dd>{e?.weather.source === "open-meteo" ? "Open-Meteo (live)" : e ? "unavailable → 0" : "—"}</dd>
              <dt>Traffic source</dt>
              <dd>{settings.trafficProvider === "tomtom" ? (settings.tomtomKey ? "TomTom live" : "TomTom key missing") : "demand model"}</dd>
              <dt>Distance</dt>
              <dd>{e ? `${round(e.distanceKm, 1)} km` : "—"}</dd>
              <dt>Slow stretches</dt>
              <dd>{e ? `${round(e.slowFraction * 100, 0)}%` : "—"}</dd>
              <dt>Annual time lost</dt>
              <dd>{e ? `${round(e.productivity.annualWastedHours, 0)} h` : "—"}</dd>
              <dt>Weekly cost of drag</dt>
              <dd>{e ? money(e.productivity.weeklyCost, settings.currency) : "—"}</dd>
            </dl>
            {e && e.notes.length > 0 && (
              <ul className="clean notes" style={{ marginTop: 12 }}>
                {e.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <header>
              <h2>Your commutes</h2>
              <span className="hint">{saved.length}/12 saved</span>
            </header>
            {saved.length === 0 ? (
              <p className="notes">Nothing saved yet. Set home and work, then hit “Save trip” — they persist in this browser only.</p>
            ) : (
              <ul className="clean">
                {saved.map((s) => (
                  <li className="saved" key={s.id}>
                    <button className="go" type="button" onClick={() => useSaved(s)}>
                      {s.label}
                      <div className="sub">
                        {round(straightKm(s.from, s.to), 1)} km · saved {new Date(s.createdAt).toLocaleDateString()}
                      </div>
                    </button>
                    <button className="icon-btn" type="button" onClick={() => removeSaved(s.id)} aria-label={`Delete ${s.label}`}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <header>
              <h2>Settings</h2>
              <span className="hint">drives the model, saved locally</span>
            </header>
            <SettingsPanel settings={settings} onChange={persistSettings} />
          </section>
        </div>
      </div>

      <footer className="foot">
        <span>Radius · Commute Drag Index</span>
        <a href="https://github.com/nagamunukutla/Radius" target="_blank" rel="noreferrer">
          methodology & source
        </a>
        <span>
          Map data © OpenStreetMap contributors · routing by OSRM · weather by Open-Meteo · estimates are model output, not a
          navigation guarantee.
        </span>
      </footer>
    </div>
  );
}

function arrivalLabel(minutesFromNow: number): string {
  const d = new Date(Date.now() + Math.max(0, minutesFromNow) * 60000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function clockOf(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Best 6 slots for a real human decision, plus the worst one for contrast. */
function rankedSlots(e: CommuteEvaluation): typeof e.departureOptions {
  if (e.departureOptions.length <= 7) return e.departureOptions;
  const best = [...e.departureOptions]
    .sort((a, b) => a.travelSeconds + a.bufferMinutes * 60 - (b.travelSeconds + b.bufferMinutes * 60))
    .slice(0, 6)
    .sort((a, b) => a.minutesFromNow - b.minutesFromNow);
  const worst = [...e.departureOptions].sort((a, b) => b.cdi - a.cdi)[0];
  return worst && !best.some((b) => b.clock === worst.clock) ? [...best, worst].sort((a, b) => a.minutesFromNow - b.minutesFromNow) : best;
}

function straightKm(a: Place, b: Place): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
