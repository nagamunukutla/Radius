import { computeCdi, productivityOf } from "./cdi";
import {
  SHAPES,
  buildSlot,
  chooseDeparture,
  sweepDepartures,
  type CommuteMode,
  type PlanContext,
  type TripShape,
} from "./departure";
import { NO_WEATHER, delayBreakdown, dispersionOf, factorAt, reliabilityBounds } from "./congestion";
import { estimateRoute, fetchRoutes, fetchTomTomFlowRatio } from "./routing";
import { NO_TRANSIT_PLAN, planTransit, type PlanTransitResult } from "./transit";
import { fetchWeather, fetchWeatherHours, weatherAt } from "./weather";
import { clamp, humanDuration, round } from "./util";
import type {
  CommuteEvaluation,
  DepartureOption,
  ModeComparison,
  Place,
  RouteResult,
  UserSettings,
} from "./types";

/**
 * Orchestrates one Radius evaluation.
 *
 * Route → weather → traffic factor → mode shapes → departure sweep → index →
 * productivity translation. Every external call is optional and bounded; this
 * function always returns a complete evaluation, and anything it had to
 * substitute is reported through `notes` and `degraded`.
 */

export interface EvaluateParams {
  from: Place;
  to: Place;
  settings: UserSettings;
  /** When the traveller is actually moving: minutes from now. */
  departInMinutes?: number;
  signal?: AbortSignal;
}

/** kg CO₂e per passenger-km. Transit/bike/walk are per-person averages. */
const MODE_CO2: Record<CommuteMode, number> = { drive: 0.171, transit: 0.041, bike: 0, walk: 0 };
const MODE_LABEL: Record<CommuteMode, string> = {
  drive: "Car",
  transit: "Public transport",
  bike: "Bike",
  walk: "Walk",
};

/**
 * Overpass is rate-limited and station geometry does not change minute to
 * minute, so a trip's transit plan is reused across auto-refreshes.
 */
const transitCache = new Map<string, { at: number; value: PlanTransitResult }>();
const TRANSIT_TTL_MS = 10 * 60 * 1000;

async function cachedTransit(from: Place, to: Place, settings: UserSettings, signal?: AbortSignal): Promise<PlanTransitResult> {
  const key = `${from.lat.toFixed(3)},${from.lon.toFixed(3)}>${to.lat.toFixed(3)},${to.lon.toFixed(3)}`;
  const hit = transitCache.get(key);
  if (hit && Date.now() - hit.at < TRANSIT_TTL_MS) return hit.value;
  const value = await planTransit(from, to, settings, signal);
  transitCache.set(key, { at: Date.now(), value });
  return value;
}

export async function evaluateCommute(p: EvaluateParams): Promise<CommuteEvaluation> {
  const notes: string[] = [];
  const now = new Date();
  const departOffset = Math.max(0, p.departInMinutes ?? 0);
  const departure = new Date(now.getTime() + departOffset * 60000);

  const wantTransit = p.settings.commuteMode === "transit";
  const [routeBundle, weatherNow, transitResult] = await Promise.all([
    fetchRoutes({ from: p.from, to: p.to }),
    fetchWeather({ lat: p.from.lat, lon: p.from.lon }),
    cachedTransit(p.from, p.to, p.settings, p.signal),
  ]);
  if (p.signal?.aborted) throw new DOMException("aborted", "AbortError");

  const route = routeBundle.primary;
  notes.push(...routeBundle.notes);

  const weatherHours = await fetchWeatherHours(p.from.lat, p.from.lon);
  const weather = weatherAt(weatherHours, weatherNow, departure);

  const hourFloat = clamp(departure.getHours() + departure.getMinutes() / 60, 0, 23.99);
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
  const anchorFactor = Math.max(
    1.02,
    factorAt({
      ...modelCtx,
      hourOfDay: clamp(now.getHours() + now.getMinutes() / 60, 0, 23.99),
      weatherPoints: 0,
    }),
  );
  const distanceKm = route.distanceM / 1000;
  const freeflowSeconds = clamp(route.typicalSeconds / anchorFactor, route.typicalSeconds * 0.42, route.typicalSeconds);

  let live: { ratio: number; congestion: number } | null = null;
  if (p.settings.trafficProvider === "tomtom" && p.settings.tomtomKey.trim()) {
    live = await fetchTomTomFlowRatio(route.geometry, p.settings.tomtomKey.trim());
    notes.push(
      live
        ? `Live TomTom flow feed connected: this corridor is running at ${Math.round((1 / live.ratio) * 100)}% of free-flow speed.`
        : "The TomTom key returned no flow data — falling back to the built-in congestion model.",
    );
  }

  const trafficConfidence = live ? 1 : routeBundle.confidence * 0.6 + 0.35;
  const shapes = buildShapes({
    route,
    freeflowMinutes: freeflowSeconds / 60,
    modes: routeBundle.modes,
    transit: transitResult,
    settings: p.settings,
    distanceKm,
    liveRatio: live ? 1 / live.ratio : null,
  });

  const ctx: PlanContext = {
    settings: p.settings,
    shape: shapes[primaryMode(p.settings, transitResult)].shape,
    weatherHours,
    fallbackWeather: weatherNow,
    now: departure,
    trafficConfidence,
  };

  // Headline numbers for the chosen mode at the chosen minute — the same
  // function the curve uses, so the gauge and the chart cannot disagree.
  const departClock = departure.getHours() * 60 + departure.getMinutes();
  const currentSlot = buildSlot(ctx, departClock) ?? fallbackSlot(ctx, shapes[ctx.shape.mode].shape.freeflowMinutes);
  const nowSlot = buildSlot({ ...ctx, now: new Date() }, now.getHours() * 60 + now.getMinutes()) ?? currentSlot;

  const sweep = sweepDepartures(ctx);
  notes.push(...sweep.notes);

  const recommended = chooseDeparture(sweep.options, p.settings);
  const savings =
    recommended && recommended.travelSeconds < currentSlot.travelSeconds - 30
      ? {
          minutes: round((currentSlot.travelSeconds - recommended.travelSeconds) / 60, 0),
          cdi: round(currentSlot.cdi - recommended.cdi, 0),
        }
      : null;

  const primary = shapes[ctx.shape.mode];
  const transit = transitResult.plan;
  const p95Minutes = currentSlot.travelSeconds / 60 + currentSlot.bufferMinutes;

  // The index shown in the gauge is the very one the curve scored for this
  // minute — one code path, no drift between the two views.
  const cdi = currentSlot.cdiResult ?? computeCdi({
    predictedMinutes: currentSlot.travelSeconds / 60,
    freeflowMinutes: primary.shape.freeflowMinutes,
    medianMinutes: currentSlot.travelSeconds / 60,
    p95Minutes,
    slowFraction: primary.shape.baseSlowFraction,
    stopEventsPer10km: primary.shape.baseStopDensity,
    weatherPoints: Math.round(weather.frictionPoints * (0.35 + 0.65 * primary.shape.weatherExposure)),
    distanceKm,
    hasViableAlternative: primary.alternativeExists,
    daysPerWeek: p.settings.daysPerWeek,
    trafficConfidence,
  });

  const comparison: ModeComparison[] = buildComparison({
    shapes,
    ctx,
    clock: departClock,
    distanceKm,
    settings: p.settings,
  });

  if (ctx.shape.mode !== "drive") {
    notes.push(
      `Scored for ${MODE_LABEL[ctx.shape.mode].toLowerCase()}${
        ctx.shape.mode === "transit"
          ? `: ${transit.modeLabel}, ${transit.walkMinutes} min walking, ${transit.waitMinutes} min of waiting included. OpenStreetMap stops, modelled headways — not a timetable.`
          : ": no traffic delay to dodge, so weather and exposure carry the index instead."
      }`,
    );
  }
  if (!transit.available && wantTransit) {
    notes.push(`You asked to be scored on public transport, but ${transit.notes[0] ?? "no stops were found"} — so this is the drive score.`);
  } else if (!transit.available) {
    notes.push(`Public transport: ${transit.notes[0] ?? "no usable stops found."}`);
  }
  if (weatherNow.source === "unavailable") {
    notes.push("Weather feed unreachable, so the weather penalty is neutral at 0 (it matters more for transit, bike and walk).");
  }
  if (!live) {
    notes.push(
      "No live incident feed configured: delay is Radius' demand model anchored to the router's geometry. Add a TomTom key in Settings for measured live traffic.",
    );
  }

  const productivity = productivityOf(
    currentSlot.travelSeconds / 60,
    primary.shape.freeflowMinutes,
    currentSlot.bufferMinutes,
    recommended ? recommended.travelSeconds / 60 : currentSlot.travelSeconds / 60,
    distanceKm,
    p.settings.daysPerWeek,
    p.settings.hourlyRate,
    ctx.shape.mode === "drive" ? p.settings.vehicleCO2PerKm : MODE_CO2[ctx.shape.mode],
  );

  const degraded = route.source === "estimated" || weatherNow.source === "unavailable";

  return {
    distanceKm,
    typicalMinutes: route.typicalSeconds / 60,
    freeflowMinutes: primary.shape.freeflowMinutes,
    predictedMinutes: currentSlot.travelSeconds / 60,
    medianMinutes: currentSlot.travelSeconds / 60,
    p95Minutes,
    reliabilityMinutes: currentSlot.bufferMinutes,
    slowFraction: primary.shape.baseSlowFraction,
    stopEventsPer10km: primary.shape.baseStopDensity,
    weather,
    modes: routeBundle.modes,
    cdi,
    departureOptions: sweep.options,
    leaveNow: nowSlot,
    recommended,
    savings,
    productivity,
    route,
    primaryMode: ctx.shape.mode,
    departureWindow: sweep.window,
    transit,
    comparison,
    latestSafeClock: sweep.latestSafeClock,
    earliestSaneClock: sweep.earliestSaneClock,
    generatedAt: Date.now(),
    degraded,
    notes,
  };
}

function primaryMode(settings: UserSettings, transit: PlanTransitResult): CommuteMode {
  if (settings.commuteMode === "transit" && !transit.plan.available) return "drive";
  return settings.commuteMode;
}

interface ShapeInput {
  route: RouteResult;
  freeflowMinutes: number;
  modes: { bikeSeconds: number | null; walkSeconds: number | null };
  transit: PlanTransitResult;
  settings: UserSettings;
  distanceKm: number;
  liveRatio: number | null;
}

interface ModeBundle {
  shape: TripShape;
  /** Whether the mode is a realistic substitute for this trip. */
  alternativeExists: boolean;
}

/**
 * Every mode is described in the same units — moving minutes, access minutes,
 * how much traffic can touch it, how exposed it is, and what you wait for —
 * so one index and one departure curve work for a driver and for someone who
 * will never own a car.
 */
function buildShapes(input: ShapeInput): Record<CommuteMode, ModeBundle> {
  const slow = slowShareOf(input.route);
  const stops = stopDensity(input.route, input.distanceKm);
  const liveBoost = input.liveRatio ? clamp((input.liveRatio - 1) * 0.45, 0, 0.5) : 0;

  const drive: TripShape = {
    mode: "drive",
    rideMinutes: input.freeflowMinutes,
    accessMinutes: 0,
    transfers: 0,
    ...SHAPES.drive,
    freeflowMinutes: round(input.freeflowMinutes * (1 + liveBoost), 2),
    distanceKm: input.distanceKm,
    baseSlowFraction: slow,
    baseStopDensity: stops,
  };

  const tp = input.transit.plan;
  const transit: TripShape = {
    mode: "transit",
    rideMinutes: tp.available ? tp.rideMinutes : input.freeflowMinutes * 1.35,
    accessMinutes: tp.available ? tp.walkMinutes : 12,
    transfers: tp.available ? tp.transfers : 1,
    ...SHAPES.transit,
    headwayMinutes: input.transit.headwayMinutes || SHAPES.transit.headwayMinutes,
    freeflowMinutes: round((tp.available ? tp.rideMinutes + tp.walkMinutes : input.freeflowMinutes * 1.35 + 12) * 1.06, 2),
    distanceKm: input.distanceKm,
    baseSlowFraction: tp.available ? clamp(0.04 + tp.exposureFraction * 0.1, 0, 1) : 0.05,
    baseStopDensity: tp.available ? clamp(0.6 + tp.transfers * 1.4, 0, 12) : 1,
  };

  const bikeSecs = input.modes.bikeSeconds ?? input.distanceKm / 17 * 3600;
  const walkSecs = input.modes.walkSeconds ?? input.distanceKm / 4.7 * 3600;

  const bike: TripShape = {
    mode: "bike",
    rideMinutes: bikeSecs / 60,
    accessMinutes: 0,
    transfers: 0,
    ...SHAPES.bike,
    freeflowMinutes: round((bikeSecs / 60) * 0.96, 2),
    distanceKm: input.distanceKm,
    baseSlowFraction: 0,
    baseStopDensity: clamp(input.distanceKm * 0.25, 0, 8),
  };

  const walk: TripShape = {
    mode: "walk",
    rideMinutes: walkSecs / 60,
    accessMinutes: 0,
    transfers: 0,
    ...SHAPES.walk,
    freeflowMinutes: round((walkSecs / 60) * 0.98, 2),
    distanceKm: input.distanceKm,
    baseSlowFraction: 0,
    baseStopDensity: clamp(input.distanceKm * 0.4, 0, 10),
  };

  const viableBike = input.distanceKm <= 12 && bike.rideMinutes <= drive.freeflowMinutes * 2.1;
  const viableWalk = input.distanceKm <= 4;

  return {
    drive: { shape: drive, alternativeExists: tp.available || viableBike || viableWalk },
    transit: { shape: transit, alternativeExists: tp.available },
    bike: { shape: bike, alternativeExists: viableBike },
    walk: { shape: walk, alternativeExists: viableWalk },
  };
}

function buildComparison(args: {
  shapes: Record<CommuteMode, ModeBundle>;
  ctx: PlanContext;
  clock: number;
  distanceKm: number;
  settings: UserSettings;
}): ModeComparison[] {
  const order: CommuteMode[] = ["drive", "transit", "bike", "walk"];
  return order.map((mode) => {
    const bundle = args.shapes[mode];
    if (!bundle.alternativeExists && mode !== args.ctx.shape.mode && mode !== "drive") {
      return { mode, label: MODE_LABEL[mode], minutes: null, bufferMinutes: null, cdi: null, co2Kg: null, viable: false };
    }
    // Same departure minute for every mode, otherwise the comparison table
    // would be comparing a 08:40 car against a 09:10 bus and calling it fair.
    const slot = buildSlot({ ...args.ctx, shape: bundle.shape }, args.clock);
    if (!slot) {
      return { mode, label: MODE_LABEL[mode], minutes: null, bufferMinutes: null, cdi: null, co2Kg: null, viable: false };
    }
    return {
      mode,
      label: MODE_LABEL[mode],
      minutes: round(slot.travelSeconds / 60, 0),
      bufferMinutes: round(slot.bufferMinutes, 0),
      cdi: slot.cdi,
      co2Kg: round(args.distanceKm * (mode === "drive" ? args.settings.vehicleCO2PerKm : MODE_CO2[mode]), 2),
      viable: true,
    };
  });
}

function fallbackSlot(ctx: PlanContext, freeflowMinutes: number): DepartureOption {
  const minutes = freeflowMinutes * 1.2;
  const clock = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  return {
    minutesFromNow: 0,
    clock: `${String(Math.floor(clock / 60) % 24).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`,
    departureClockMinutes: ((Math.round(clock) % 1440) + 1440) % 1440,
    travelSeconds: minutes * 60,
    arrivalInMinutes: minutes,
    arrivalClockMinutes: (clock + Math.round(minutes)) % 1440,
    earlyMinutes: Math.max(0, ctx.settings.workStartMinutes - clock - minutes),
    lateMinutes: Math.max(0, clock + minutes - ctx.settings.workStartMinutes),
    bufferMinutes: minutes * 0.12,
    waitMinutes: 0,
    onTimeRisk: 0.2,
    cdi: 35,
    cost: 0,
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
  return clamp((events / Math.max(0.6, distanceKm)) * 10, 0, 30);
}

export function summaryLine(e: CommuteEvaluation): string {
  return `CDI ${e.cdi.score} · ${e.cdi.band.label} · ${humanDuration(e.predictedMinutes)} each way`;
}

/**
 * Last-resort synchronous evaluation. If the async path ever throws (blocked
 * CSP, offline, frozen fetch) the UI still renders a complete, honest,
 * clearly-labelled estimate rather than an empty screen.
 */
export function emergencyEstimate(from: Place, to: Place, settings: UserSettings): CommuteEvaluation {
  const now = new Date();
  const hourFloat = clamp(now.getHours() + now.getMinutes() / 60, 0, 23.99);
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
  const slowFraction = slowShareOf(route);
  const cdi = computeCdi({
    predictedMinutes: predictedSeconds / 60,
    freeflowMinutes: freeflowSeconds / 60,
    medianMinutes: predictedSeconds / 60,
    p95Minutes,
    slowFraction,
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
    slowFraction,
    stopEventsPer10km: 1.4,
    weather: NO_WEATHER,
    modes: { walkSeconds: null, bikeSeconds: null, transitMinutes: null },
    cdi,
    departureOptions: [],
    leaveNow: null,
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
    primaryMode: "drive",
    departureWindow: null,
    transit: NO_TRANSIT_PLAN,
    comparison: [],
    latestSafeClock: null,
    earliestSaneClock: null,
    generatedAt: Date.now(),
    degraded: true,
    notes: ["Live lookups failed, so this is Radius' offline estimate. Retry when the network is back."],
  };
}
