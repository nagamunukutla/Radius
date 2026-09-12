import { clamp, round, normalize } from "./util";
import type { CdiBand, CdiFactor, CdiResult } from "./types";

/**
 * The Commute Drag Index (CDI).
 *
 * 0 = a joyride, 100 = a daily punishment. Six weighted factors, each of which
 * is a monotone transform of a measurable input, so the score is auditable:
 * every factor carries the numbers that produced it.
 */

export interface CdiInputs {
  predictedMinutes: number;
  freeflowMinutes: number;
  medianMinutes: number;
  p95Minutes: number;
  /** Share of route distance driven under 25 km/h (0..1). */
  slowFraction: number;
  stopEventsPer10km: number;
  weatherPoints: number;
  distanceKm: number;
  /** True when cycling or transit is a realistic substitute. */
  hasViableAlternative: boolean;
  daysPerWeek: number;
  /** Live-traffic confidence 0..1; scales how much the delay factor counts. */
  trafficConfidence?: number;
}

export const FACTOR_WEIGHTS = {
  delay: 0.3,
  reliability: 0.18,
  friction: 0.15,
  weather: 0.1,
  mode: 0.12,
  timeTax: 0.15,
} as const;

const BANDS: CdiBand[] = [
  {
    key: "smooth",
    label: "Smooth",
    color: "#38e1c0",
    blurb: "Your commute is not stealing from your day.",
  },
  {
    key: "manageable",
    label: "Manageable",
    color: "#9ad86b",
    blurb: "Some drag, but nothing you cannot plan around.",
  },
  {
    key: "strained",
    label: "Strained",
    color: "#ffcf5c",
    blurb: "You are losing real focus time twice a day.",
  },
  {
    key: "heavy",
    label: "Heavy Drag",
    color: "#ff9f68",
    blurb: "The commute is a second shift. Change the departure minute.",
  },
  {
    key: "gridlock",
    label: "Gridlock Mode",
    color: "#ff6b6b",
    blurb: "This is burning your week. Rethink route, hours or office days.",
  },
];

export function bandFor(score: number): CdiBand {
  if (score < 20) return BANDS[0];
  if (score < 40) return BANDS[1];
  if (score < 60) return BANDS[2];
  if (score < 80) return BANDS[3];
  return BANDS[4];
}

export const ALL_BANDS = BANDS;

/** Core scoring: pure, synchronous, unit-tested. */
export function computeCdi(i: CdiInputs): CdiResult {
  const ratio = i.freeflowMinutes > 0 ? i.predictedMinutes / i.freeflowMinutes : 1;
  const cv = i.medianMinutes > 0 ? (i.p95Minutes - i.medianMinutes) / i.medianMinutes : 0;
  const confidence = clamp(i.trafficConfidence ?? 0.55, 0.35, 1);

  const delayRaw = normalize(ratio, [
    [1, 0],
    [1.18, 22],
    [1.35, 42],
    [1.7, 70],
    [2.1, 88],
    [2.6, 100],
  ]);
  // Without a live feed we still trust the shape of the model, but not its
  // extremes — so the score is pulled toward the median case.
  const delayScore = 18 + (delayRaw - 18) * (0.55 + 0.45 * confidence);

  const reliabilityScore = normalize(cv, [
    [0.03, 0],
    [0.08, 24],
    [0.16, 52],
    [0.28, 78],
    [0.45, 100],
  ]);

  const slowScore = normalize(i.slowFraction, [
    [0.02, 0],
    [0.1, 26],
    [0.2, 55],
    [0.33, 80],
    [0.5, 100],
  ]);
  const stopScore = normalize(i.stopEventsPer10km, [
    [0.4, 0],
    [1.8, 28],
    [3.5, 58],
    [6, 84],
    [9, 100],
  ]);
  const frictionScore = Math.round(clamp(slowScore * 0.68 + stopScore * 0.32, 0, 100));

  const weatherScore = Math.round(clamp(i.weatherPoints, 0, 100));

  const distanceScore = normalize(i.distanceKm, [
    [3, 6],
    [10, 26],
    [20, 50],
    [35, 74],
    [50, 90],
    [70, 100],
  ]);
  const modeScore = Math.round(clamp(i.hasViableAlternative ? distanceScore * 0.72 - 6 : distanceScore, 0, 100));

  const excessMinutes = Math.max(0, i.predictedMinutes - 25);
  const timeTaxScore = Math.round(
    normalize(excessMinutes, [
      [0, 0],
      [10, 14],
      [25, 38],
      [45, 66],
      [70, 88],
      [100, 100],
    ]),
  );

  const factors: CdiFactor[] = [
    {
      key: "delay",
      label: "Delay burden",
      score: Math.round(delayScore),
      weight: FACTOR_WEIGHTS.delay,
      detail: `${round(i.predictedMinutes, 0)} min now vs ${round(i.freeflowMinutes, 0)} min free-flow — ${round((ratio - 1) * 100, 0)}% inflation.`,
    },
    {
      key: "reliability",
      label: "Unpredictability",
      score: Math.round(reliabilityScore),
      weight: FACTOR_WEIGHTS.reliability,
      detail: `95th percentile is ${round(i.p95Minutes - i.medianMinutes, 0)} min past a ${round(i.medianMinutes, 0)} min median — that is the buffer you carry.`,
    },
    {
      key: "friction",
      label: "Stop-and-go friction",
      score: frictionScore,
      weight: FACTOR_WEIGHTS.friction,
      detail: `${round(i.slowFraction * 100, 0)}% of the distance under 25 km/h, ${round(i.stopEventsPer10km, 1)} hard slowdowns per 10 km.`,
    },
    {
      key: "weather",
      label: "Weather penalty",
      score: weatherScore,
      weight: FACTOR_WEIGHTS.weather,
      detail:
        weatherScore === 0
          ? "Conditions are not slowing the network."
          : `Precipitation, wind and visibility add ${round((Math.pow(1 + weatherScore / 100 * 0.34, 1) - 1) * 100, 0)}% to drive times.`,
    },
    {
      key: "mode",
      label: "Distance & alternatives",
      score: modeScore,
      weight: FACTOR_WEIGHTS.mode,
      detail: i.hasViableAlternative
        ? `${round(i.distanceKm, 1)} km, and a bike/transit option exists as a pressure valve.`
        : `${round(i.distanceKm, 1)} km with no realistic alternative mode on this corridor.`,
    },
    {
      key: "timeTax",
      label: "Time tax",
      score: timeTaxScore,
      weight: FACTOR_WEIGHTS.timeTax,
      detail: `${round(i.predictedMinutes, 0)} min door-to-door, ${round(excessMinutes, 0)} min beyond the 25 min healthy one-way budget.`,
    },
  ];

  const weighted = factors.reduce((sum, f) => sum + f.score * f.weight, 0);
  const score = Math.round(clamp(weighted, 0, 100));

  return { score, band: bandFor(score), factors, advice: adviceFor(i, factors, ratio) };
}

function adviceFor(i: CdiInputs, factors: CdiFactor[], ratio: number): string[] {
  const out: string[] = [];
  const worst = [...factors].sort((a, b) => b.score * b.weight - a.score * a.weight);
  const top = worst[0];

  if (i.predictedMinutes > 60) {
    out.push(
      `One way is already ${round(i.predictedMinutes, 0)} min — that is ${round((i.predictedMinutes * 2 * i.daysPerWeek) / 60, 1)} h of driving every week. Treat two of those days as remote days and the annual bill drops by ${round(((i.predictedMinutes * 2 * 2 * 46) / 60), 0)} h.`,
    );
  }
  if (top.key === "delay" && ratio > 1.3) {
    out.push(
      "Delay dominates. Sliding your departure by 20–30 min either side of the peak usually beats any route change — check the departure curve below.",
    );
  }
  if (top.key === "reliability") {
    out.push(
      "Unpredictability dominates, not the average. Protect a start-of-day block you can do even if you arrive late, instead of promising an early stand-up.",
    );
  }
  if (top.key === "friction") {
    out.push(
      "Stop-and-go is dominating: avoid the signalised high street by taking one extra kilometre of arterial road — fewer lights usually wins.",
    );
  }
  if (top.key === "weather") {
    out.push(
      "Weather is the whole story today. If your stack is async, a wet forecast is a legitimate reason to work the first two hours from home.",
    );
  }
  if (top.key === "mode" && !i.hasViableAlternative) {
    out.push(
      "No viable alternative mode on this corridor, so your only lever is timing or the hybrid split — negotiate it explicitly with your team.",
    );
  }
  if (top.key === "timeTax" && i.predictedMinutes < 45) {
    out.push(
      "Your drag is mostly raw length, not congestion. Batching two office days and dropping the third is the highest-yield move.",
    );
  }
  if (out.length === 0) {
    out.push(
      "Nothing dominates today. Keep the departure slot that produced this score and re-check after a shift in your working hours.",
    );
  }
  return out.slice(0, 3);
}

/**
 * Weekly productivity translation: what the drag costs in hours and money,
 * and what is actually reclaimable by moving the departure minute.
 */
export function productivityOf(
  predictedMinutes: number,
  freeflowMinutes: number,
  bufferMinutes: number,
  bestMinutes: number,
  distanceKm: number,
  daysPerWeek: number,
  hourlyRate: number,
  co2PerKm: number,
): {
  weeklyWastedMinutes: number;
  annualWastedHours: number;
  reclaimableWeeklyHours: number;
  weeklyCost: number;
  co2KgWeekly: number;
} {
  const perTripWaste = Math.max(0, predictedMinutes - freeflowMinutes) + Math.max(0, bufferMinutes);
  const weeklyWastedMinutes = perTripWaste * 2 * clamp(daysPerWeek, 0, 7);
  const reclaim = Math.max(0, predictedMinutes - bestMinutes) * 2 * clamp(daysPerWeek, 0, 7);
  const annualWastedHours = (weeklyWastedMinutes * 46) / 60;
  return {
    weeklyWastedMinutes: round(weeklyWastedMinutes, 0),
    annualWastedHours: round(annualWastedHours, 1),
    reclaimableWeeklyHours: round(reclaim / 60, 1),
    weeklyCost: round((weeklyWastedMinutes / 60) * hourlyRate, 0),
    co2KgWeekly: round(distanceKm * 2 * clamp(daysPerWeek, 0, 7) * co2PerKm, 1),
  };
}
