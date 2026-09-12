import { clamp, gaussian, normalize } from "./util";
import type { WeatherSnapshot } from "./types";

/**
 * The congestion model.
 *
 * Radius has no municipal sensor feed, so travel-time inflation is modelled as
 * a time-of-day demand curve (commuter peaks) scaled by local severity, then
 * multiplied by a weather term. Because the router's "typical" duration already
 * contains an average amount of congestion, the model is *relative*: we divide
 * the router answer by the model factor at request time to recover a
 * free-flow reference, then re-apply the factor at each candidate departure
 * minute. That keeps the absolute level anchored to real road geometry while
 * letting departure time move the needle.
 */

export interface CongestionContext {
  /** Decimal hours, 0..24, in the traveller's local time. */
  hourOfDay: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** 1 = average city, 1.35 = notoriously jammed, 0.7 = free-flowing. */
  severity: number;
  /** Weather friction 0..100 from WeatherSnapshot.frictionPoints. */
  weatherPoints: number;
  peakAm: number;
  peakPm: number;
  /** True when a live feed supplies the delay factor, so the model backs off. */
  live?: boolean;
}

export interface DelayBreakdown {
  /** Total travel-time multiplier vs free flow (>= 1). */
  factor: number;
  am: number;
  pm: number;
  midday: number;
  weekendFactor: number;
  weatherFactor: number;
}

const NOISE = 0.0025;

export function delayBreakdown(ctx: CongestionContext): DelayBreakdown {
  const h = clamp(ctx.hourOfDay, 0, 23.99);
  const weekendish = ctx.weekday === 0 || ctx.weekday === 6;
  const weekendFactor = ctx.weekday === 0 ? 0.3 : ctx.weekday === 6 ? 0.5 : 1;
  if (weekendish) {
    // Weekend traffic is dominated by errands, not commuter peaks.
    const midday = gaussian(h, 13, 3.2, 0.16);
    const am = 0;
    const pm = 0;
    const raw = (am + pm + midday) * ctx.severity * weekendFactor;
    return {
      am,
      pm,
      midday,
      weekendFactor,
      weatherFactor: weatherFactor(ctx.weatherPoints),
      factor: 1 + raw + (ctx.live ? 0 : NOISE),
    };
  }

  // Morning peak: sharper and narrower (everyone leaves at the same minute).
  const am = gaussian(h, ctx.peakAm, 0.62, 0.58) + gaussian(h, ctx.peakAm - 0.4, 1.1, 0.2);
  // Evening peak: broader (staggered departures, school run, errands).
  const pm = gaussian(h, ctx.peakPm, 1.05, 0.62) + gaussian(h, ctx.peakPm + 1.1, 1.6, 0.16);
  // Lunch + shift-change shoulder, and the 06:00 freight tail.
  const midday = gaussian(h, 13, 1.3, 0.1) + gaussian(h, 6.6, 0.9, 0.12);

  const mondayFriday = ctx.weekday === 0 || ctx.weekday === 5 ? 1.06 : 1;
  const demand = (am + pm + midday) * ctx.severity * mondayFriday;

  return {
    am,
    pm,
    midday,
    weekendFactor: 1,
    weatherFactor: weatherFactor(ctx.weatherPoints),
    factor: 1 + demand + (ctx.live ? 0 : NOISE),
  };
}

export function weatherFactor(points: number): number {
  return 1 + (clamp(points, 0, 100) / 100) * 0.34;
}

/** Free-flow multiplier applied to the router answer at request time. */
export function factorAt(ctx: CongestionContext): number {
  const b = delayBreakdown(ctx);
  return clamp(b.factor * b.weatherFactor, 1, 3.4);
}

/**
 * Coefficient of variation of travel time: the seed for the reliability
 * score. Longer, slower, weather-hit trips are less predictable.
 */
export function dispersionOf(factor: number, distanceKm: number, weatherPoints: number): number {
  const excess = Math.max(0, factor - 1);
  const distanceTerm = Math.min(0.09, distanceKm / 620);
  const weatherTerm = (weatherPoints / 100) * 0.07;
  return clamp(0.045 + 0.2 * Math.sqrt(excess) + distanceTerm + weatherTerm, 0.03, 0.62);
}

/**
 * Lognormal quantile pair for the observed travel-time distribution.
 * `median` is taken as the modelled travel time.
 */
export function reliabilityBounds(medianMinutes: number, cv: number): { p50Minutes: number; p95Minutes: number } {
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(Math.max(1, medianMinutes)) - (sigma * sigma) / 2;
  const p95 = Math.exp(mu + 1.645 * sigma);
  return { p50Minutes: medianMinutes, p95Minutes: clamp(p95, medianMinutes * 1.02, medianMinutes * 3) };
}

/** 0..100 friction a weather snapshot adds to a drive. */
export function weatherFrictionPoints(input: {
  precipMm: number;
  windKph: number;
  tempC: number;
  code: number;
}): number {
  const precip = normalize(input.precipMm, [
    [0, 0],
    [0.2, 8],
    [1.5, 26],
    [4, 45],
    [10, 62],
  ]);
  const wind = normalize(input.windKph, [
    [12, 0],
    [28, 8],
    [45, 22],
    [65, 40],
    [90, 58],
  ]);
  // WMO codes: 65/67/82 heavy showers, 71-77 snow, 45/48 fog, 95+ thunderstorm.
  const code = input.code;
  let type = 0;
  if (code === 45 || code === 48) type = 34;
  else if (code >= 71 && code <= 77) type = 48;
  else if (code >= 85 && code <= 86) type = 38;
  else if (code >= 95) type = 52;
  else if (code >= 63 && code <= 67) type = 30;
  else if (code >= 53 && code <= 57) type = 14;
  else if (code >= 80 && code <= 82) type = 18;
  const heat = normalize(Math.abs(input.tempC - 21), [
    [0, 0],
    [8, 4],
    [14, 12],
    [20, 20],
    [28, 30],
  ]);
  return Math.round(clamp(Math.max(precip, wind) * 0.72 + type * 0.6 + heat * 0.35, 0, 100));
}

export const WEATHER_LABELS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Showers",
  82: "Violent showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm + hail",
  99: "Severe thunderstorm + hail",
};

export const NO_WEATHER: WeatherSnapshot = {
  tempC: 21,
  windKph: 12,
  precipMm: 0,
  code: 1,
  label: "Weather data unavailable",
  frictionPoints: 0,
  source: "unavailable",
};
