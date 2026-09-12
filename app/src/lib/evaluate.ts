import { computeCdi, productivityOf } from "./cdi";
import { NO_WEATHER, delayBreakdown, dispersionOf, factorAt, reliabilityBounds } from "./congestion";
import { estimateRoute, fetchRoutes, fetchTomTomFlowRatio } from "./routing";
import { fetchWeather, fetchWeatherHours, weatherAt } from "./weather";
import { clamp, humanDuration, minutesToClock, normalize, round } from "./util";
import type {
  CommuteEvaluation,
  DepartureOption,
  Place,
  RouteResult,
  UserSettings,
  WeatherSnapshot,
} from "./types";

/**
 * Orchestrates one Radius evaluation: route → weather → traffic factor →
 * departure sweep → CDI → productivity translation.
 *
 * Every external call is optional. The function always returns a complete
 * evaluation; anything missing is reported through `notes` and `degraded`.
 */

export interface EvaluateParams {
  from: Place;
  to: Place;
  settings: UserSettings;
  /** When the traveller is actually moving: minutes from now. */
  departInMinutes?: number;
  signal?: AbortSignal;
}

export async function evaluateCommute(p: EvaluateParams): Promise<CommuteEvaluation> {
  const notes: string[] = [];
  const now = new Date();
  const departOffset = p.departInMinutes ?? 0;
  const departure = new Date(now.getTime() + departOffset * 60000);

  const [routeBundle, weatherNow] = await Promise.all([
    fetchRoutes({ from: p.from, to: p.to }),
    fetchWeather({ lat: p.from.lat, lon: p.from.lon }),
  ]);
  if (p.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const route = routeBundle.primary;
  notes.push(...routeBundle.notes);

  const weatherHours = await fetchWeatherHours(p.from.lat, p.from.lon);
  const weather = weatherAt(weatherHours, weatherNow, departure);

  const hourFloat = clamp(
    departure.getHours() + departure.getMinutes() / 60,
    0,
    23.99,
  );
  const weekday = departure.getDay();

  const modelCtx = {
    hourOfDay: hourFloat,
    weekday,
    severity: p.settings.citySeverity,
    weatherPoints: weather.frictionPoints,
    peakAm: p.settings.peakAm,
    peakPm: p.settings.peakPm,
  };

  // The router's "typical" duration already embeds average congestion, so we
  // divide out the model's factor at request time to recover a free-flow
  // reference, then re-apply it at the traveller's real departure minute.
  const anchorFactor = Math.max(1.02, factorAt({ ...modelCtx, hourOfDay: now.getHours() + now.getMinutes() / 60, weatherPoints: 0 }));
  const freeflowSeconds = clamp(route.typicalSeconds / anchorFactor, route.typicalSeconds * 0.42, route.typicalSeconds);

  let live: { ratio: number; congestion: number } | null = null;
  if (p.settings.trafficProvider === "tomtom" && p.settings.tomtomKey.trim()) {
    live = await fetchTomTomFlowRatio(route.geometry, p.settings.tomtomKey.trim());
    notes.push(
      live
        ? `Live TomTom flow feed connected: current corridor is running at ${Math.round((1 / live.ratio) * 100)}% of free-flow speed.`
        : "TomTom key did not return flow data — falling back to the built-in congestion model.",
    );
  }

  const breakdown = delayBreakdown(modelCtx);
  const weatherMult = breakdown.weatherFactor;
  const modelledFactor = clamp(breakdown.factor, 1, 3.2);
  const trafficConfidence = live ? 1 : routeBundle.confidence * 0.6 + 0.35;
  const factor = live
    ? clamp(1 / live.ratio, 1, 3.2)
    : clamp(modelledFactor * weatherMult, 1, 3.6);

  const predictedSeconds = freeflowSeconds * factor;

  const distanceKm = route.distanceM / 1000;
  const slowFraction = slowShareOf(route);
  const stopEvents = stopDensity(route, distanceKm);

  const cv = dispersionOf(factor, distanceKm, weather.frictionPoints);
  const medianMinutes = predictedSeconds / 60;
  const { p95Minutes } = reliabilityBounds(medianMinutes, cv);
  const reliabilityMinutes = Math.max(0, p95Minutes - medianMinutes);

  const hasViableAlternative =
    route.distanceM < 20000 ||
    (routeBundle.modes.bikeSeconds !== null && routeBundle.modes.bikeSeconds < predictedSeconds * 1.9) ||
    (routeBundle.modes.transitMinutes !== null &&
      routeBundle.modes.transitMinutes < medianMinutes * 1.35);

  const cdi = computeCdi({
    predictedMinutes: medianMinutes,
    freeflowMinutes: freeflowSeconds / 60,
    medianMinutes,
    p95Minutes,
    slowFraction,
    stopEventsPer10km: stopEvents,
    weatherPoints: weather.frictionPoints,
    distanceKm,
    hasViableAlternative,
    daysPerWeek: p.settings.daysPerWeek,
    trafficConfidence,
  });

  const sweep = sweepDepartures({
    from: p.from,
    settings: p.settings,
    freeflowSeconds,
    routeDistanceM: route.distanceM,
    weatherHours,
    fallbackWeather: weatherNow,
    baseSlowFraction: slowFraction,
    baseStopDensity: stopEvents,
    now,
  });

  const recommended = bestOption(sweep.options, p.settings.workStartMinutes);
  const savings =
    recommended && recommended.travelSeconds < predictedSeconds
      ? {
          minutes: round((predictedSeconds - recommended.travelSeconds) / 60, 0),
          cdi: round(cdi.score - recommended.cdi, 0),
        }
      : null;

  const productivity = productivityOf(
    medianMinutes,
    freeflowSeconds / 60,
    reliabilityMinutes,
    recommended ? recommended.travelSeconds / 60 : medianMinutes,
    distanceKm,
    p.settings.daysPerWeek,
    p.settings.hourlyRate,
    p.settings.vehicleCO2PerKm,
  );

  const degraded = route.source === "estimated" || weatherNow.source === "unavailable";
  if (route.source === "osrm" && weatherNow.source === "unavailable") {
    notes.push("Weather feed unreachable today, so the weather penalty is neutral at 0.");
  }
  if (!live) {
    notes.push(
      "No live incident feed is configured. Delay uses Radius' demand model calibrated to the router's geometry — add a TomTom key in Settings for true live traffic.",
    );
  }

  return {
    distanceKm,
    typicalMinutes: route.typicalSeconds / 60,
    freeflowMinutes: freeflowSeconds / 60,
    predictedMinutes: medianMinutes,
    medianMinutes,
    p95Minutes,
    reliabilityMinutes,
    slowFraction,
    stopEventsPer10km: stopEvents,
    weather,
    modes: routeBundle.modes,
    cdi,
    departureOptions: sweep.options,
    recommended,
    savings,
    productivity,
    route,
    generatedAt: Date.now(),
    degraded,
    notes,
  };
}

function slowShareOf(route: RouteResult): number {
  if (!route.segments.length) return 0;
  const total = route.segments.reduce((s, x) => s + x.distanceM, 0);
  if (total <= 0) return 0;
  const slow = route.segments
    .filter((s) => s.avgSpeedKmh > 0 && s.avgSpeedKmh < 25)
    .reduce((s, x) => s + x.distanceM, 0);
  return clamp(slow / total, 0, 1);
}

/** Rough deceleration-event count: speed dropping hard between chunks. */
function stopDensity(route: RouteResult, distanceKm: number): number {
  const segs = route.segments;
  if (segs.length < 2 || distanceKm <= 0) return 0;
  let events = 0;
  for (let i = 1; i < segs.length; i += 1) {
    const prev = segs[i - 1].avgSpeedKmh;
    const cur = segs[i].avgSpeedKmh;
    if (prev > 0 && cur > 0) {
      const drop = (prev - cur) / prev;
      if (drop > 0.35) events += 1 + Math.round(drop * 1.5);
    }
    if (cur < 18) events += 1;
  }
  return clamp(events / Math.max(0.6, distanceKm) * 10, 0, 30);
}

interface SweepInput {
  from: Place;
  settings: UserSettings;
  freeflowSeconds: number;
  routeDistanceM: number;
  weatherHours: Awaited<ReturnType<typeof fetchWeatherHours>>;
  fallbackWeather: WeatherSnapshot;
  baseSlowFraction: number;
  baseStopDensity: number;
  now: Date;
}

/**
 * Sweep candidate departure minutes across the shoulder of the working day and
 * score each one. This is where "avoid traffic" becomes actionable: the best
 * minute is usually worth more than the best route.
 */
function sweepDepartures(input: SweepInput): { options: DepartureOption[] } {
  const { settings, freeflowSeconds } = input;
  const workStart = settings.workStartMinutes;
  const distanceKm = input.routeDistanceM / 1000;

  // Search window: 3.5 h before the ideal arrival up to 1.5 h after "now".
  const idealDepart = workStart - 25;
  const startMinutes = clamp(idealDepart - 210, 5 * 60, 12 * 60);
  const endMinutes = clamp(idealDepart + 210, 6 * 60, 23 * 60);
  const step = 6;

  const options: DepartureOption[] = [];
  for (let clock = startMinutes; clock <= endMinutes; clock += step) {
    const when = new Date(input.now);
    when.setHours(Math.floor(clock / 60), clock % 60, 0, 0);
    if (when.getTime() < input.now.getTime() - 30 * 60000) {
      when.setDate(when.getDate() + 1);
    }
    const minutesFromNow = (when.getTime() - input.now.getTime()) / 60000;
    if (minutesFromNow < -1 || minutesFromNow > 24 * 60) continue;

    const hourFloat = when.getHours() + when.getMinutes() / 60;
    const weather = weatherAt(input.weatherHours, input.fallbackWeather, when);
    const breakdown = delayBreakdown({
      hourOfDay: hourFloat,
      weekday: when.getDay(),
      severity: settings.citySeverity,
      weatherPoints: weather.frictionPoints,
      peakAm: settings.peakAm,
      peakPm: settings.peakPm,
    });
    const factor = clamp(breakdown.factor * breakdown.weatherFactor, 1, 3.6);
    const travelSeconds = freeflowSeconds * factor;
    const travelMinutes = travelSeconds / 60;

    const cv = dispersionOf(factor, distanceKm, weather.frictionPoints);
    const { p95Minutes } = reliabilityBounds(travelMinutes, cv);
    const buffer = Math.max(0, p95Minutes - travelMinutes);

    // Congestion shape follows the demand factor: peak = more crawling.
    const slowFraction = clamp(
      input.baseSlowFraction * normalize(factor, [
        [1, 0.45],
        [1.25, 0.85],
        [1.6, 1.15],
        [2.1, 1.4],
      ]),
      0,
      1,
    );
    const stopDensitySlot = clamp(input.baseStopDensity * (0.55 + (factor - 1) * 0.9), 0, 30);

    const cdi = computeCdi({
      predictedMinutes: travelMinutes,
      freeflowMinutes: freeflowSeconds / 60,
      medianMinutes: travelMinutes,
      p95Minutes,
      slowFraction,
      stopEventsPer10km: stopDensitySlot,
      weatherPoints: weather.frictionPoints,
      distanceKm,
      hasViableAlternative: distanceKm < 20,
      daysPerWeek: settings.daysPerWeek,
      trafficConfidence: 0.5,
    });

    options.push({
      minutesFromNow,
      clock: minutesToClock(clock),
      travelSeconds,
      arrivalInMinutes: minutesFromNow + travelSeconds / 60,
      cdi: cdi.score,
      bufferMinutes: buffer,
    });
  }
  return { options };
}

/**
 * Recommended departure: minimise (travel + buffer) while still landing at or
 * before the work start. Falls back to the lowest-drag slot in the window.
 */
export function bestOption(options: DepartureOption[], workStart: number): DepartureOption | null {
  if (!options.length) return null;
  const now = new Date();
  const nowClock = now.getHours() * 60 + now.getMinutes();
  const scoreOf = (x: DepartureOption) => x.travelSeconds / 60 + x.bufferMinutes + x.cdi * 0.06;
  const future = options.filter((o) => o.minutesFromNow >= 1);
  const onTime = future.filter((o) => nowClock + o.minutesFromNow + o.travelSeconds / 60 <= workStart + 0.5);
  const pool = onTime.length ? onTime : future.length ? future : options;
  return pool.reduce((best, o) => (scoreOf(o) < scoreOf(best) ? o : best), pool[0]);
}

export function summaryLine(e: CommuteEvaluation): string {
  return `CDI ${e.cdi.score} · ${e.cdi.band.label} · ${humanDuration(e.predictedMinutes)} each way`;
}

/**
 * Last-resort synchronous evaluation. If the async path ever throws (blocked
 * CSP, offline, frozen fetch), the UI still renders a complete, honest,
 * clearly-labelled estimate rather than an empty screen.
 */
export function emergencyEstimate(from: Place, to: Place, settings: UserSettings): CommuteEvaluation {
  const now = new Date();
  const hourFloat = now.getHours() + now.getMinutes() / 60;
  const breakdown = delayBreakdown({
    hourOfDay: hourFloat,
    weekday: now.getDay(),
    severity: settings.citySeverity,
    weatherPoints: 0,
    peakAm: settings.peakAm,
    peakPm: settings.peakPm,
  });
  const route = estimateRoute(from, to, breakdown.factor);
  const freeflowSeconds = clamp(route.typicalSeconds / Math.max(1.02, breakdown.factor), 60, 6 * 3600);
  const predictedSeconds = freeflowSeconds * clamp(breakdown.factor, 1, 3.4);
  const distanceKm = route.distanceM / 1000;
  const cv = dispersionOf(breakdown.factor, distanceKm, 0);
  const { p95Minutes } = reliabilityBounds(predictedSeconds / 60, cv);
  const cdi = computeCdi({
    predictedMinutes: predictedSeconds / 60,
    freeflowMinutes: freeflowSeconds / 60,
    medianMinutes: predictedSeconds / 60,
    p95Minutes,
    slowFraction: slowShareOf(route),
    stopEventsPer10km: 1.4,
    weatherPoints: 0,
    distanceKm,
    hasViableAlternative: distanceKm < 20,
    daysPerWeek: settings.daysPerWeek,
    trafficConfidence: 0.35,
  });
  return {
    distanceKm,
    typicalMinutes: route.typicalSeconds / 60,
    freeflowMinutes: freeflowSeconds / 60,
    predictedMinutes: predictedSeconds / 60,
    medianMinutes: predictedSeconds / 60,
    p95Minutes,
    reliabilityMinutes: Math.max(0, p95Minutes - predictedSeconds / 60),
    slowFraction: slowShareOf(route),
    stopEventsPer10km: 1.4,
    weather: NO_WEATHER,
    modes: { walkSeconds: null, bikeSeconds: null, transitMinutes: null },
    cdi,
    departureOptions: [],
    recommended: null,
    savings: null,
    productivity: productivityOf(
      predictedSeconds / 60,
      freeflowSeconds / 60,
      Math.max(0, p95Minutes - predictedSeconds / 60),
      predictedSeconds / 60,
      distanceKm,
      settings.daysPerWeek,
      settings.hourlyRate,
      settings.vehicleCO2PerKm,
    ),
    route,
    generatedAt: Date.now(),
    degraded: true,
    notes: ["Live lookups failed, so this is Radius' offline estimate. Retry when the network is back."],
  };
}
