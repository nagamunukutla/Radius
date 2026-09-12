import { describe, expect, it } from "vitest";
import { computeCdi, FACTOR_WEIGHTS, productivityOf } from "./cdi";
import { delayBreakdown, dispersionOf, weatherFrictionPoints } from "./congestion";
import { normalize, minutesToClock, pathLengthM } from "./util";
import { estimateRoute } from "./routing";

const base = {
  predictedMinutes: 28,
  freeflowMinutes: 24,
  medianMinutes: 28,
  p95Minutes: 32,
  slowFraction: 0.08,
  stopEventsPer10km: 1.2,
  weatherPoints: 0,
  distanceKm: 14,
  hasViableAlternative: true,
  daysPerWeek: 5,
};

describe("Commute Drag Index", () => {
  it("weights sum to 1 so the 0-100 scale is honest", () => {
    const sum = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("scores a calm trip in the smooth-to-manageable range", () => {
    const r = computeCdi({ ...base });
    expect(r.score).toBeLessThan(45);
    expect(["smooth", "manageable"]).toContain(r.band.key);
  });

  it("is monotone in delay: worse congestion never lowers the index", () => {
    let previous = -1;
    for (const mult of [1, 1.2, 1.5, 1.9, 2.4]) {
      const r = computeCdi({
        ...base,
        predictedMinutes: base.freeflowMinutes * mult,
        medianMinutes: base.freeflowMinutes * mult,
        p95Minutes: base.freeflowMinutes * mult * 1.15,
        slowFraction: 0.08 + (mult - 1) * 0.4,
        trafficConfidence: 0.95,
      });
      expect(r.score).toBeGreaterThanOrEqual(previous);
      previous = r.score;
    }
    expect(previous).toBeGreaterThan(55);
  });

  it("compresses extremes when there is no live traffic feed", () => {
    const inputs = (confidence: number) => ({
      ...base,
      predictedMinutes: base.freeflowMinutes * 2.4,
      medianMinutes: base.freeflowMinutes * 2.4,
      p95Minutes: base.freeflowMinutes * 2.4 * 1.3,
      slowFraction: 0.6,
      trafficConfidence: confidence,
    });
    expect(computeCdi(inputs(0.35)).score).toBeLessThan(computeCdi(inputs(0.95)).score);
  });

  it("stays inside 0..100 for absurd inputs", () => {
    const r = computeCdi({
      ...base,
      predictedMinutes: 900,
      freeflowMinutes: 1,
      medianMinutes: 900,
      p95Minutes: 4000,
      slowFraction: 1,
      stopEventsPer10km: 400,
      weatherPoints: 100,
      distanceKm: 300,
      daysPerWeek: 7,
    });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("survives degenerate zero-length commutes without NaN", () => {
    const r = computeCdi({ ...base, predictedMinutes: 0, freeflowMinutes: 0, medianMinutes: 0, p95Minutes: 0 });
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it("treats rain as real friction", () => {
    expect(weatherFrictionPoints({ precipMm: 6, windKph: 40, tempC: 9, code: 65 })).toBeGreaterThan(25);
    expect(weatherFrictionPoints({ precipMm: 0, windKph: 6, tempC: 20, code: 0 })).toBeLessThan(5);
  });

  it("peaks at rush hour, not at 03:00", () => {
    const peak = delayBreakdown({ hourOfDay: 8.5, weekday: 2, severity: 1, weatherPoints: 0, peakAm: 8.5, peakPm: 18 });
    const night = delayBreakdown({ hourOfDay: 3, weekday: 2, severity: 1, weatherPoints: 0, peakAm: 8.5, peakPm: 18 });
    expect(peak.factor).toBeGreaterThan(1.4);
    expect(night.factor).toBeLessThan(1.08);
  });

  it("is more predictable at the weekend", () => {
    const sat = delayBreakdown({ hourOfDay: 9, weekday: 6, severity: 1, weatherPoints: 0, peakAm: 8.5, peakPm: 18 });
    const mon = delayBreakdown({ hourOfDay: 9, weekday: 1, severity: 1, weatherPoints: 0, peakAm: 8.5, peakPm: 18 });
    expect(sat.factor).toBeLessThan(mon.factor);
  });

  it("widens the variance band as delay grows", () => {
    expect(dispersionOf(2.1, 25, 20)).toBeGreaterThan(dispersionOf(1.05, 25, 0));
  });

  it("converts minutes into a weekly and annual bill", () => {
    const p = productivityOf(52, 28, 9, 33, 22, 5, 45, 0.171);
    expect(p.weeklyWastedMinutes).toBeCloseTo((52 - 28 + 9) * 2 * 5, 0);
    expect(p.annualWastedHours).toBeGreaterThan(90);
    expect(p.co2KgWeekly).toBeGreaterThan(18);
  });

  it("never recommends a negative reclaim", () => {
    const p = productivityOf(20, 20, 0, 60, 5, 5, 45, 0.171);
    expect(p.reclaimableWeeklyHours).toBe(0);
  });

  it("keeps the normaliser monotone and clamped", () => {
    expect(normalize(0, [[0, 0], [1, 100]])).toBe(0);
    expect(normalize(0.5, [[0, 0], [1, 100]])).toBe(50);
    expect(normalize(99, [[0, 0], [1, 100]])).toBe(100);
    expect(normalize(-3, [[0, 0], [1, 100]])).toBe(0);
  });

  it("formats clocks past midnight safely", () => {
    expect(minutesToClock(1440 + 45)).toBe("00:45");
    expect(minutesToClock(-10)).toBe("23:50");
  });

  it("builds a usable fallback route when the router is unreachable", () => {
    const r = estimateRoute(
      { name: "a", short: "a", lat: 38.8217, lon: -0.6059 },
      { name: "b", short: "b", lat: 38.955, lon: -0.55 },
      1.4,
    );
    expect(r.source).toBe("estimated");
    expect(r.typicalSeconds).toBeGreaterThan(60);
    expect(r.segments.length).toBeGreaterThan(2);
    expect(pathLengthM(r.geometry)).toBeGreaterThan(1000);
    // Deterministic: the same inputs must not flicker between refreshes.
    const again = estimateRoute(
      { name: "a", short: "a", lat: 38.8217, lon: -0.6059 },
      { name: "b", short: "b", lat: 38.955, lon: -0.55 },
      1.4,
    );
    expect(again.typicalSeconds).toBeCloseTo(r.typicalSeconds, 6);
  });
});
