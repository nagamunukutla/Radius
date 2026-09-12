import { computeCdi } from "./cdi";
import { delayBreakdown, dispersionOf, reliabilityBounds } from "./congestion";
import { weatherAt } from "./weather";
import type { WeatherHours } from "./weather";
import { clamp, minutesToClock, normalCdf, normalize, round } from "./util";
import type { UserSettings, WeatherSnapshot, DepartureOption, PlanStyle } from "./types";

/**
 * The departure planner.
 *
 * Design rule: a minute is not free just because it is before your start time.
 * The first version of Radius minimised drive time alone, which made it
 * recommend leaving at 07:05 for an 11:00 start — technically optimal,
 * humanly absurd, and exactly the "arrive at 5am" nonsense that makes
 * commute optimisation resented in Europe. So the planner now prices four
 * different things and lets the traveller say which ones they care about.
 */

export type CommuteMode = "drive" | "transit" | "bike" | "walk";

/**
 * How a mode's journey reacts to the network. A car trip is almost entirely
 * congestion-sensitive and almost entirely indoors; a metro journey is mostly
 * insensitive (rails don't queue) but its *waiting* is what hurts; cycling is
 * fully exposed to weather.
 */
export interface TripShape {
  mode: CommuteMode;
  /** Minutes of moving at free-flow speed. */
  rideMinutes: number;
  /** Minutes of walking / transfer time — insensitive to traffic. */
  accessMinutes: number;
  /** Extra minutes per transfer, already folded into accessMinutes for transit. */
  transfers: number;
  /** 0..1 — how much of the demand factor lands on the ride. */
  congestionSensitivity: number;
  /** 0..1 — how much of the journey the weather touches. */
  weatherExposure: number;
  /** Service headway in minutes; 0 for private modes. */
  headwayMinutes: number;
  /** The delay ratio denominator: what this trip costs with no queue and no wait. */
  freeflowMinutes: number;
  distanceKm: number;
  baseSlowFraction: number;
  baseStopDensity: number;
  /** Standing-room probability for transit. Left unset for cars: a car's
      misery is already counted by the crawl share, so blending it in twice
      would inflate the index. */
  crowdingFraction?: number;
}

export const SHAPES: Record<CommuteMode, Pick<TripShape, "congestionSensitivity" | "weatherExposure" | "headwayMinutes">> = {
  drive: { congestionSensitivity: 1, weatherExposure: 0.08, headwayMinutes: 0 },
  transit: { congestionSensitivity: 0.24, weatherExposure: 0.55, headwayMinutes: 8 },
  bike: { congestionSensitivity: 0.3, weatherExposure: 1, headwayMinutes: 0 },
  walk: { congestionSensitivity: 0.08, weatherExposure: 1, headwayMinutes: 0 },
};

/** Per-minute weights of the objective, by planning philosophy. */
export const COST_WEIGHTS: Record<
  PlanStyle,
  { early: number; late: number; risk: number; cdi: number; buffer: number; wait: number }
> = {
  // Arrive on time, don't burn the morning, don't sit in traffic either.
  balanced: { early: 0.85, late: 2.2, risk: 9, cdi: 0.06, buffer: 0.5, wait: 0.55 },
  // Extract every minute of sleep: leave as late as the risk budget allows.
  latest: { early: 1.6, late: 2.6, risk: 7, cdi: 0.04, buffer: 0.4, wait: 0.5 },
  // Minimize suffering even if it means an empty office at 07:00.
  lowestDrag: { early: 0.05, late: 2.0, risk: 5, cdi: 0.14, buffer: 0.6, wait: 0.5 },
  // Protected morning routine: hard floor plus a strong preference for late.
  protectMorning: { early: 1.3, late: 2.8, risk: 10, cdi: 0.06, buffer: 0.5, wait: 0.62 },
};

export const PLAN_STYLES: Array<{ key: PlanStyle; label: string; blurb: string }> = [
  { key: "balanced", label: "Balanced", blurb: "On time, no idle desk time, no peak suffering." },
  { key: "latest", label: "Leave as late as safely possible", blurb: "Maximises the morning; keeps lateness risk under ~10%." },
  { key: "lowestDrag", label: "Lowest drag", blurb: "Shortest, calmest drive even if you arrive to an empty office." },
  { key: "protectMorning", label: "Protect my morning", blurb: "Never before your floor, and it would rather you slept in." },
];

export interface PlanContext {
  settings: UserSettings;
  shape: TripShape;
  weatherHours: WeatherHours;
  fallbackWeather: WeatherSnapshot;
  now: Date;
  trafficConfidence: number;
}

export interface SweepResult {
  options: DepartureOption[];
  window: { start: number; end: number; step: number };
  /** Latest departure that still lands you on time with ≤10% lateness risk. */
  latestSafeClock: string | null;
  /** Earliest departure that is not a waste of a morning. */
  earliestSaneClock: string | null;
  notes: string[];
}

/**
 * The last minute that could plausibly still land you on time: the nominal trip
 * (25% above free flow, because free flow is a fantasy at 08:20) plus a small
 * grace margin. One definition shared by the window and the notes, so the
 * explanation can never drift from the arithmetic it describes.
 */
export function latestDepartureOf(ctx: PlanContext): number {
  const nominal = ctx.shape.freeflowMinutes + ctx.shape.accessMinutes;
  return ctx.settings.workStartMinutes - nominal * 1.25 - 6;
}

/**
 * The search window is derived from the trip, not from "the whole day".
 * Upper bound = the latest minute that can plausibly still land on time, plus
 * an hour of late-arrival evidence; lower bound = the traveller's own floor,
 * and never more than ~2 h of margin before that.
 */
export function planWindow(ctx: PlanContext): { start: number; end: number; step: number } {
  const s = ctx.settings;
  const latestDeparture = latestDepartureOf(ctx);

  let start = Math.max(s.earliestDepartureMinutes, latestDeparture - 115);
  const nowClock = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  // Pull the window back to "now" only when now is genuinely inside the
  // decision zone. Otherwise an 11:00 start would be plotted from 06:00,
  // which is how a planner ends up recommending an absurdly early departure.
  if (nowClock < start && nowClock >= latestDeparture - 175) start = Math.min(start, nowClock);
  start = clamp(Math.floor(start / 5) * 5, 5 * 60, 22 * 60);

  let end = clamp(Math.ceil((latestDeparture + 70) / 5) * 5, start + 35, 23 * 60 - 5);
  if (end <= start) end = clamp(start + 35, start + 35, 23 * 60 - 5);

  const rawStep = Math.round((end - start) / 44 / 6) * 6;
  const step = clamp(Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 6, 6, 15);
  return { start, end, step };
}

/**
 * Probability that a day at this slot makes you late, from the lognormal band
 * implied by the buffer: P(travel > slack).
 */
export function lateRisk(travelMinutes: number, bufferMinutes: number, slackMinutes: number): number {
  if (slackMinutes <= 0) return 1;
  const sigma = Math.max(0.02, Math.log(1 + bufferMinutes / Math.max(1, travelMinutes)) / 1.645);
  const z = (Math.log(Math.max(1, slackMinutes)) - Math.log(Math.max(1, travelMinutes))) / sigma;
  return clamp(1 - normalCdf(z), 0, 1);
}

/** How often the traveller accepts being late — the planner's hard gate. */
export function riskBudget(s: UserSettings): number {
  return clamp(s.lateRiskBudget ?? 0.1, 0.02, 0.5);
}

export function slotCost(o: DepartureOption, s: UserSettings): number {
  const w = COST_WEIGHTS[s.planStyle];
  const early = Math.max(0, o.earlyMinutes - s.maxEarlyArrivalMinutes);
  const travelMinutes = o.travelSeconds / 60;
  return (
    travelMinutes +
    w.buffer * o.bufferMinutes +
    w.wait * o.waitMinutes +
    w.early * early +
    w.late * o.lateMinutes +
    w.risk * Math.max(0, o.onTimeRisk - riskBudget(s)) +
    w.cdi * o.cdi
  );
}

/**
 * One slot, fully evaluated: travel time, buffer, lateness risk, index and the
 * cost under the traveller's stated philosophy. The sweep and the headline
 * "right now" numbers both come from here, so they can never disagree.
 */
export function buildSlot(ctx: PlanContext, clock: number): DepartureOption | null {
  const { settings: s, shape } = ctx;
  const when = new Date(ctx.now);
  when.setHours(Math.floor(clock / 60), clock % 60, 0, 0);
  if (when.getTime() < ctx.now.getTime() - 60000) when.setDate(when.getDate() + 1);
  const minutesFromNow = (when.getTime() - ctx.now.getTime()) / 60000;
  if (minutesFromNow < -0.5) return null;

  const hourFloat = when.getHours() + when.getMinutes() / 60;
  const weather = weatherAt(ctx.weatherHours, ctx.fallbackWeather, when);
  const breakdown = delayBreakdown({
    hourOfDay: hourFloat,
    weekday: when.getDay(),
    severity: s.citySeverity,
    weatherPoints: weather.frictionPoints,
    peakAm: s.peakAm,
    peakPm: s.peakPm,
  });
  const slot = evaluateSlot(shape, clamp(breakdown.factor - 1, 0, 2.4), weather.frictionPoints);
  const travelMinutes = slot.minutes;
  const slack = s.workStartMinutes - clock;
  const risk = lateRisk(travelMinutes, slot.bufferMinutes, slack);
  const cdi = computeCdi({
    predictedMinutes: travelMinutes,
    freeflowMinutes: shape.freeflowMinutes,
    medianMinutes: travelMinutes,
    p95Minutes: travelMinutes + slot.bufferMinutes,
    slowFraction: clamp(shape.baseSlowFraction * (0.5 + slot.peakPressure * 0.9), 0, 1),
    stopEventsPer10km: clamp(shape.baseStopDensity * (0.6 + slot.peakPressure * 0.8), 0, 30),
    weatherPoints: Math.round(weather.frictionPoints * (0.35 + 0.65 * shape.weatherExposure)),
    distanceKm: shape.distanceKm,
    hasViableAlternative: shape.mode !== "drive" || shape.distanceKm < 20,
    daysPerWeek: s.daysPerWeek,
    trafficConfidence: ctx.trafficConfidence,
    crowdingFraction: shape.mode === "transit" ? clamp(0.15 + slot.peakPressure * 0.45, 0, 1) : shape.crowdingFraction,
  });

  const arrivalClock = clock + travelMinutes;
  const option: DepartureOption = {
    minutesFromNow,
    clock: minutesToClock(clock),
    departureClockMinutes: ((Math.round(clock) % 1440) + 1440) % 1440,
    travelSeconds: travelMinutes * 60,
    arrivalInMinutes: minutesFromNow + travelMinutes,
    arrivalClockMinutes: ((Math.round(arrivalClock) % 1440) + 1440) % 1440,
    earlyMinutes: Math.max(0, s.workStartMinutes - arrivalClock),
    lateMinutes: Math.max(0, arrivalClock - s.workStartMinutes),
    bufferMinutes: slot.bufferMinutes,
    waitMinutes: slot.waitMinutes,
    onTimeRisk: risk,
    cdi: cdi.score,
    cost: 0,
    cdiResult: cdi,
  };
  option.cost = round(slotCost(option, s), 2);
  return option;
}

export function sweepDepartures(ctx: PlanContext): SweepResult {
  const { settings: s } = ctx;
  const win = planWindow(ctx);
  const notes: string[] = [];
  const options: DepartureOption[] = [];

  for (let clock = win.start; clock <= win.end; clock += win.step) {
    const option = buildSlot(ctx, clock);
    if (option) options.push(option);
  }

  // The floor is a preference, not a trap. If honouring it would leave nothing
  // to recommend, Radius shows the earlier options and says why — an empty
  // planner is a worse outcome than an inconvenient one.
  const all = options;
  const allowed = all.filter((o) => o.departureClockMinutes >= s.earliestDepartureMinutes - 0.01);
  if (allowed.length) {
    options.length = 0;
    options.push(...allowed);
  } else if (all.length) {
    notes.push(
      `Nothing at or after your ${minutesToClock(s.earliestDepartureMinutes)} floor works for a ${minutesToClock(s.workStartMinutes)} start on this corridor, so the earlier options below are shown instead of an empty answer.`,
    );
  }

  const budget = riskBudget(s);
  const safe = options.filter((o) => o.onTimeRisk <= budget);
  const latestSafe = safe.length ? safe.reduce((a, b) => (b.minutesFromNow > a.minutesFromNow ? b : a)) : null;
  const earliestSane = safe.length ? safe.reduce((a, b) => (b.minutesFromNow < a.minutesFromNow ? b : a)) : null;

  // Say it only when the floor actually cost something, and say by how much —
  // a note that contradicts the printed window is worse than no note.
  const dropped = all.length - options.length;
  if (dropped > 1) {
    notes.push(
      `Your ${minutesToClock(s.earliestDepartureMinutes)} floor excluded ${dropped} earlier candidate${dropped === 1 ? "" : "s"} — on a peak-shaped curve the pre-peak minutes are sometimes genuinely faster, so lower the floor if you want to see them.`,
    );
  }
  if (!safe.length && options.length) {
    notes.push(
      `No slot in the window keeps your lateness risk under ${Math.round(budget * 100)}% — this corridor and your start time are not compatible. The best available slot is shown, but the honest fix is flex hours, not an earlier alarm.`,
    );
  }

  return {
    options,
    window: win,
    latestSafeClock: latestSafe ? latestSafe.clock : null,
    earliestSaneClock: earliestSane ? earliestSane.clock : null,
    notes,
  };
}


/**
 * Mode-aware slot physics. One function so a metro trip and a car trip are
 * compared on the same axis instead of one being a fudge factor of the other.
 */
export function evaluateSlot(
  shape: TripShape,
  peakExcess: number,
  weatherPoints: number,
): { minutes: number; bufferMinutes: number; waitMinutes: number; peakPressure: number } {
  const wp = clamp(weatherPoints, 0, 100) / 100;
  const weatherMult = 1 + wp * 0.34 * (0.25 + 0.75 * shape.weatherExposure);

  const ride = shape.rideMinutes * (1 + peakExcess * shape.congestionSensitivity) * weatherMult;
  const access = shape.accessMinutes * (1 + wp * 0.22 * shape.weatherExposure);

  let waitMinutes = 0;
  if (shape.headwayMinutes > 0) {
    // Random arrival at a stop: mean wait is headway/2, worse when the peak
    // service is packed enough that you miss the first vehicle.
    const headway = Math.max(2, shape.headwayMinutes * (1 + 0.28 * peakExcess));
    waitMinutes = headway / 2 + (shape.transfers > 0 ? headway / 2 : 0);
  }

  const minutes = ride + access + waitMinutes;
  const cv = dispersionOf(1 + peakExcess * shape.congestionSensitivity, shape.distanceKm, wp * 100);
  const modelledBuffer = reliabilityBounds(minutes, cv).p95Minutes - minutes;
  // Missing a connection costs a whole headway, which the traffic model alone
  // would never predict.
  const headwayRisk = shape.headwayMinutes > 0 ? shape.headwayMinutes * (0.6 + 0.5 * wp) : 0;
  const bufferMinutes = Math.max(modelledBuffer, headwayRisk, 1);

  return {
    minutes: round(minutes, 2),
    bufferMinutes: round(bufferMinutes, 2),
    waitMinutes: round(waitMinutes, 2),
    peakPressure: clamp(peakExcess, 0, 2.4),
  };
}

/**
 * Best slot under the traveller's stated philosophy.
 *
 * Only slots inside the lateness-risk budget are eligible when any exist: a
 * recommendation that arrives later than the "leave no later than" deadline it
 * publishes is not advice, it is an arithmetic accident.
 */
export function chooseDeparture(options: DepartureOption[], s: UserSettings): DepartureOption | null {
  if (!options.length) return null;
  const future = options.filter((o) => o.minutesFromNow >= 0.5);
  const eligible = future.length ? future : options;
  const budget = riskBudget(s);
  const withinBudget = eligible.filter((o) => o.onTimeRisk <= budget);
  const pool = withinBudget.length ? withinBudget : eligible;
  return pool.reduce((best, o) => (slotCost(o, s) < slotCost(best, s) ? o : best), pool[0]);
}

/**
 * How much later you could leave than the free-flow-optimal minute. Used by
 * the UI to explain the recommendation in one sentence.
 */
export function marginMinutes(recommended: DepartureOption | null, nominalClock: number | null): number {
  if (!recommended || nominalClock === null) return 0;
  const recClock = (() => {
    const [h, m] = recommended.clock.split(":").map(Number);
    return h * 60 + m;
  })();
  return round(nominalClock - recClock, 0);
}

/** Free-flow reference for a mode, so "delay" is measured against the right thing. */
export function freeflowReference(minutes: number, mode: CommuteMode): number {
  // A car's free flow is 1/1.25 of its typical answer; a metro's nominal ride
  // time already is its free flow, so it is scaled less aggressively.
  const divisor = mode === "transit" ? 1.08 : mode === "bike" || mode === "walk" ? 1.04 : 1.25;
  return round(minutes / divisor, 1);
}

/** Shared by the productivity panel: cost of one wasted minute in each unit. */
export function weeklyDragMinutes(
  predictedMinutes: number,
  freeflowMinutes: number,
  bufferMinutes: number,
  daysPerWeek: number,
): number {
  return Math.round(Math.max(0, predictedMinutes - freeflowMinutes) * 2 * clamp(daysPerWeek, 0, 7) + Math.max(0, bufferMinutes) * 2 * clamp(daysPerWeek, 0, 7));
}

/** For tests + the debug tooltip: the normaliser anchors a factor maps through. */
export function describeFactor(factor: number): string {
  const p = normalize(factor, [
    [1, 0],
    [1.25, 30],
    [1.6, 60],
    [2.1, 85],
    [2.6, 100],
  ]);
  return `${Math.round(p)}/100 pressure`;
}
