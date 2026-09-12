import { describe, expect, it } from "vitest";
import {
  COST_WEIGHTS,
  buildSlot,
  chooseDeparture,
  evaluateSlot,
  lateRisk,
  planWindow,
  sweepDepartures,
  type PlanContext,
  type TripShape,
} from "./departure";
import { DEFAULT_SETTINGS, type UserSettings } from "./types";
import { minutesToClock } from "./util";

/**
 * Regression tests for the planner bug the product could not ship with:
 * an 11:00 start with an 18-minute drive was being answered with "leave at
 * 07:05", because the objective only minimised drive time and the window floor
 * was hardcoded to 05:00. A minute before your start time is not free.
 */

const NO_HOURS = null;

function ctx(settings: Partial<UserSettings>, shape?: Partial<TripShape>): PlanContext {
  const s: UserSettings = { ...DEFAULT_SETTINGS, ...settings };
  return {
    settings: s,
    shape: {
      mode: "drive",
      rideMinutes: 18,
      accessMinutes: 0,
      transfers: 0,
      congestionSensitivity: 1,
      weatherExposure: 0.08,
      headwayMinutes: 0,
      freeflowMinutes: 18,
      distanceKm: 12,
      baseSlowFraction: 0.08,
      baseStopDensity: 1.2,
      ...shape,
    },
    weatherHours: NO_HOURS,
    fallbackWeather: {
      tempC: 21,
      windKph: 10,
      precipMm: 0,
      code: 1,
      label: "Mainly clear",
      frictionPoints: 0,
      source: "unavailable",
    },
    now: new Date(2026, 8, 14, 6, 0, 0),
    trafficConfidence: 0.9,
  };
}

const clockToMinutes = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
};

describe("departure planner", () => {
  it("does not send someone to the office hours before they start", () => {
    const c = ctx({ workStartMinutes: 11 * 60, earliestDepartureMinutes: 7 * 60 });
    const sweep = sweepDepartures(c);
    const best = chooseDeparture(sweep.options, c.settings);
    expect(best).not.toBeNull();
    // 18 min drive for an 11:00 start: landing long before it is waste.
    expect(best!.earlyMinutes).toBeLessThanOrEqual(90);
    expect(clockToMinutes(best!.clock)).toBeGreaterThan(9 * 60);
  });

  it("never recommends leaving before the traveller's floor", () => {
    for (const floor of [7 * 60, 8 * 60]) {
      const c = ctx({ workStartMinutes: 9 * 60, earliestDepartureMinutes: floor });
      const sweep = sweepDepartures(c);
      for (const o of sweep.options) {
        expect(clockToMinutes(o.clock)).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it("windows the search around the trip instead of the whole day", () => {
    const short = planWindow(ctx({ workStartMinutes: 11 * 60 }));
    expect(short.end - short.start).toBeLessThanOrEqual(4 * 60);
    expect(short.start).toBeGreaterThanOrEqual(5 * 60);
    expect(short.end).toBeLessThanOrEqual(23 * 60);

    // A long commute with an early start still gets an early window.
    const long = planWindow(ctx({ workStartMinutes: 8 * 60, earliestDepartureMinutes: 5 * 60 }, { freeflowMinutes: 70, rideMinutes: 70 }));
    expect(long.start).toBeLessThan(8 * 60);
  });

  it("prefers the latest low-risk minute under 'latest' and an easier drive under 'lowestDrag'", () => {
    const base = { workStartMinutes: 9 * 60, earliestDepartureMinutes: 6 * 60 };
    const late = ctx({ ...base, planStyle: "latest" });
    const drag = ctx({ ...base, planStyle: "lowestDrag" });
    const lateSweep = sweepDepartures(late);
    const dragSweep = sweepDepartures(drag);
    const lateBest = chooseDeparture(lateSweep.options, late.settings)!;
    const dragBest = chooseDeparture(dragSweep.options, drag.settings)!;
    expect(clockToMinutes(lateBest.clock)).toBeGreaterThan(clockToMinutes(dragBest.clock));
  });

  it("will not choose a slot that arrives late when an on-time slot exists", () => {
    const c = ctx({ workStartMinutes: 9 * 60, earliestDepartureMinutes: 6 * 60 });
    const sweep = sweepDepartures(c);
    const best = chooseDeparture(sweep.options, c.settings)!;
    const onTime = sweep.options.filter((o) => o.lateMinutes < 1);
    expect(onTime.length).toBeGreaterThan(0);
    expect(best.lateMinutes).toBe(0);
  });

  it("exposes a hard deadline that is later than or equal to the recommendation", () => {
    const c = ctx({ workStartMinutes: 9 * 60, earliestDepartureMinutes: 6 * 60 });
    const sweep = sweepDepartures(c);
    const best = chooseDeparture(sweep.options, c.settings)!;
    expect(sweep.latestSafeClock).not.toBeNull();
    expect(clockToMinutes(sweep.latestSafeClock!)).toBeGreaterThanOrEqual(clockToMinutes(best.clock));
  });

  it("says so out loud when no slot can make you on time", () => {
    const c = ctx(
      { workStartMinutes: 8 * 60, earliestDepartureMinutes: 6 * 60 },
      { freeflowMinutes: 150, rideMinutes: 150 },
    );
    const sweep = sweepDepartures(c);
    expect(sweep.options.length).toBeGreaterThan(0);
    expect(sweep.options.every((o) => o.lateMinutes > 0)).toBe(true);
    expect(sweep.latestSafeClock).toBeNull();
    expect(sweep.notes.join(" ")).toMatch(/not compatible|flex hours/i);
  });

  it("relaxes an impossible floor rather than returning an empty planner", () => {
    const c = ctx({ workStartMinutes: 9 * 60, earliestDepartureMinutes: 23 * 60 + 30 });
    const sweep = sweepDepartures(c);
    expect(sweep.options.length).toBeGreaterThan(0);
    expect(sweep.notes.join(" ")).toMatch(/floor/i);
  });

  it("prices lateness above earliness, and risk above both", () => {
    const w = COST_WEIGHTS.balanced;
    expect(w.late).toBeGreaterThan(w.early);
    expect(w.risk).toBeGreaterThan(w.late);
  });

  it("computes lateness risk monotonically in slack", () => {
    const tight = lateRisk(30, 6, 32);
    const roomy = lateRisk(30, 6, 55);
    expect(tight).toBeGreaterThan(roomy);
    expect(tight).toBeGreaterThan(0.2);
    expect(roomy).toBeLessThan(0.05);
    expect(lateRisk(30, 6, 0)).toBe(1);
  });

  it("gives transit a headway floor on its buffer that cars do not get", () => {
    const car = evaluateSlot(
      { mode: "drive", rideMinutes: 30, accessMinutes: 0, transfers: 0, congestionSensitivity: 1, weatherExposure: 0.08, headwayMinutes: 0, freeflowMinutes: 30, distanceKm: 20, baseSlowFraction: 0.1, baseStopDensity: 1 },
      0.2,
      0,
    );
    const metro = evaluateSlot(
      { mode: "transit", rideMinutes: 22, accessMinutes: 10, transfers: 1, congestionSensitivity: 0.24, weatherExposure: 0.55, headwayMinutes: 4, freeflowMinutes: 34, distanceKm: 20, baseSlowFraction: 0.05, baseStopDensity: 0.6 },
      0.2,
      0,
    );
    expect(metro.waitMinutes).toBeGreaterThan(0);
    expect(metro.bufferMinutes).toBeGreaterThanOrEqual(4 * 0.6);
    // Rails do not queue, so the peak should bite a car far harder than a metro.
    const carPeak = evaluateSlot(
      { mode: "drive", rideMinutes: 30, accessMinutes: 0, transfers: 0, congestionSensitivity: 1, weatherExposure: 0.08, headwayMinutes: 0, freeflowMinutes: 30, distanceKm: 20, baseSlowFraction: 0.1, baseStopDensity: 1 },
      1.2,
      0,
    );
    const metroPeak = evaluateSlot(
      { mode: "transit", rideMinutes: 22, accessMinutes: 10, transfers: 1, congestionSensitivity: 0.24, weatherExposure: 0.55, headwayMinutes: 4, freeflowMinutes: 34, distanceKm: 20, baseSlowFraction: 0.05, baseStopDensity: 0.6 },
      1.2,
      0,
    );
    expect(carPeak.minutes / car.minutes).toBeGreaterThan(metroPeak.minutes / metro.minutes);
  });

  it("makes rain hurt a bike commute more than a car commute", () => {
    const mk = (over: Partial<TripShape>): TripShape => ({
      mode: "drive",
      rideMinutes: 30,
      accessMinutes: 0,
      transfers: 0,
      congestionSensitivity: 1,
      weatherExposure: 0.08,
      headwayMinutes: 0,
      freeflowMinutes: 30,
      distanceKm: 15,
      baseSlowFraction: 0.1,
      baseStopDensity: 1,
      ...over,
    });
    const carDry = evaluateSlot(mk({}), 0.2, 0);
    const carRain = evaluateSlot(mk({}), 0.2, 70);
    const bikeDry = evaluateSlot(mk({ mode: "bike", weatherExposure: 1, congestionSensitivity: 0.3 }), 0.2, 0);
    const bikeRain = evaluateSlot(mk({ mode: "bike", weatherExposure: 1, congestionSensitivity: 0.3 }), 0.2, 70);
    expect(bikeRain.minutes / bikeDry.minutes).toBeGreaterThan(carRain.minutes / carDry.minutes);
  });

  it("keeps every slot's clock consistent with its arrival arithmetic", () => {
    const c = ctx({ workStartMinutes: 9 * 60 });
    const sweep = sweepDepartures(c);
    for (const o of sweep.options.slice(0, 8)) {
      expect(o.arrivalClockMinutes).toBeCloseTo((clockToMinutes(o.clock) + o.travelSeconds / 60) % 1440, 0);
      expect(minutesToClock(clockToMinutes(o.clock))).toBe(o.clock);
    }
  });

  it("scores the same minute identically through buildSlot and the sweep", () => {
    const c = ctx({ workStartMinutes: 9 * 60, earliestDepartureMinutes: 6 * 60 });
    const sweep = sweepDepartures(c);
    const single = buildSlot(c, 8 * 60 + 24);
    expect(single).not.toBeNull();
    const inSweep = sweep.options.find((o) => o.clock === single!.clock);
    expect(inSweep?.cdi).toBe(single!.cdi);
    expect(inSweep?.travelSeconds).toBeCloseTo(single!.travelSeconds, 6);
  });
});
