import { describe, expect, it } from "vitest";
import { assemblePlan, classifyStop, toStations, walkMinutes } from "./transit";
import type { Place } from "./types";

/**
 * The transit model is fed a payload shaped exactly like an Overpass answer,
 * so the parsing and the arithmetic are covered even where the network is not.
 */

const HOME: Place = { name: "Casa", short: "Casa", lat: 41.3874, lon: 2.1686 };
const WORK: Place = { name: "Oficina", short: "Oficina", lat: 41.3978, lon: 2.194 };

const metroAt = (lat: number, lon: number, name: string) => ({
  type: "node",
  lat,
  lon,
  tags: { railway: "station", station: "subway", name, "zoom": "17" },
});
const busAt = (lat: number, lon: number, name: string) => ({
  type: "node",
  lat,
  lon,
  tags: { highway: "bus_stop", public_transport: "platform", name },
});
const tramAt = (lat: number, lon: number, name: string) => ({
  type: "node",
  lat,
  lon,
  tags: { railway: "tram_stop", name },
});

describe("transit classification", () => {
  it("reads the OSM tags that actually exist", () => {
    expect(classifyStop({ railway: "station", station: "subway" })).toBe("metro");
    expect(classifyStop({ railway: "station", train: "yes" })).toBe("rail");
    expect(classifyStop({ railway: "halt" })).toBe("rail");
    expect(classifyStop({ railway: "tram_stop" })).toBe("tram");
    expect(classifyStop({ station: "lightRail" })).toBe("tram");
    expect(classifyStop({ highway: "bus_stop" })).toBe("bus");
    expect(classifyStop({ public_transport: "platform", bus: "yes" })).toBe("bus");
    expect(classifyStop({ railway: "abandoned" })).toBeNull();
    expect(classifyStop(undefined)).toBeNull();
    expect(classifyStop({ shop: "bakery" })).toBeNull();
  });

  it("collapses the many platform nodes of one station into one place", () => {
    const stations = toStations(
      [
        metroAt(41.3881, 2.169, "Diagonal"),
        metroAt(41.3879, 2.1695, "Diagonal"),
        metroAt(41.3884, 2.1701, "Diagonal"),
        busAt(41.3877, 2.1681, "Pg. Gràcia 0"),
      ],
      HOME,
    );
    expect(stations.filter((s) => s.name === "Diagonal")).toHaveLength(1);
    expect(stations[0].kind).toBe("metro"); // metro outranks a bus stop at the same distance
    expect(stations[0].distanceM).toBeLessThan(400);
  });

  it("ignores elements without usable coordinates and unknown kinds", () => {
    const list = toStations([{ type: "way", tags: { railway: "station" } }, { type: "node", lat: 1, lon: 2, tags: { natural: "tree" } }] as never[], HOME);
    expect(list).toHaveLength(0);
  });

  it("uses way centers when a station is mapped as an area", () => {
    const list = toStations([{ type: "way", center: { lat: 41.39, lon: 2.17 }, tags: { railway: "station", name: "Tarragona" } }] as never[], HOME);
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("rail");
  });

  it("walks at a sane commuter pace", () => {
    expect(walkMinutes(800)).toBeGreaterThan(11);
    expect(walkMinutes(800)).toBeLessThan(16);
    expect(walkMinutes(0)).toBe(0);
  });
});

describe("transit assembly", () => {
  it("prefers the metro over a bus when both exist", () => {
    const plan = assemblePlan({
      origin: HOME,
      destination: WORK,
      originStations: toStations([metroAt(41.3881, 2.169, "Maria Cristina"), busAt(41.3876, 2.1688, "Pasqual de Apaza")], HOME),
      destStations: toStations([metroAt(41.3981, 2.1935, "Wellington"), busAt(41.398, 2.1945, "Rambla Catalunya")], WORK),
      maxWalkMinutes: 12,
    });
    expect(plan.available).toBe(true);
    expect(plan.modeLabel).toBe("Metro");
    expect(plan.legs.length).toBeGreaterThanOrEqual(4);
    expect(plan.legs[0].kind).toBe("walk");
    expect(plan.totalMinutes).toBeGreaterThan(plan.rideMinutes);
    expect(plan.walkMinutes).toBeGreaterThan(0);
    expect(plan.waitMinutes).toBeGreaterThan(0);
  });

  it("refuses a mode whose walk is past the traveller's limit", () => {
    const far = { type: "node", lat: 41.45, lon: 2.16, tags: { railway: "station", station: "subway", name: "Molt lluny" } };
    const plan = assemblePlan({
      origin: HOME,
      destination: WORK,
      originStations: toStations([far], HOME),
      destStations: toStations([metroAt(41.3981, 2.1935, "Wellington")], WORK),
      maxWalkMinutes: 6,
    });
    expect(plan.available).toBe(false);
    expect(plan.notes.join(" ")).toMatch(/walk|stop/i);
  });

  it("degrades to the bus when there is no station at the office end", () => {
    const plan = assemblePlan({
      origin: HOME,
      destination: WORK,
      originStations: toStations([metroAt(41.3881, 2.169, "Maria Cristina"), busAt(41.3876, 2.1688, "Pg. Gràcia")], HOME),
      destStations: toStations([busAt(41.398, 2.1945, "Rambla Catalunya")], WORK),
      maxWalkMinutes: 12,
    });
    expect(plan.available).toBe(true);
    expect(plan.modeLabel).toBe("Bus");
    // A bus ride outdoors in the rain is the whole point of the exposure term.
    expect(plan.exposureFraction).toBeGreaterThan(0.6);
  });

  it("assumes a change on a cross-city trip but not on a short one", () => {
    const originStations = toStations([metroAt(41.3881, 2.169, "A")], HOME);
    const nearDest: Place = { name: "A prop", short: "A prop", lat: 41.3905, lon: 2.172 };
    const farDest: Place = { name: "Poblenou", short: "Poblenou", lat: 41.4042, lon: 2.2215 };
    const near = assemblePlan({
      origin: HOME,
      destination: nearDest,
      originStations,
      destStations: toStations([metroAt(41.3906, 2.1721, "B")], nearDest),
      maxWalkMinutes: 12,
    });
    const far = assemblePlan({
      origin: HOME,
      destination: farDest,
      originStations,
      destStations: toStations([metroAt(41.4044, 2.222, "C")], farDest),
      maxWalkMinutes: 12,
    });
    expect(near.transfers).toBe(0);
    expect(far.transfers).toBe(1);
    // A change costs a wait plus the walk between platforms, so a cross-city
    // trip cannot be priced as if it were a single ride.
    const changeLeg = far.legs.find((l) => l.label === "Change here");
    expect(changeLeg).toBeDefined();
    expect(far.waitMinutes).toBeGreaterThan(near.waitMinutes * 1.4);
  });

  it("ranks a metro above a tram and a tram above a bus at equal distance", () => {
    const list = toStations(
      [busAt(41.38795, 2.16895, "Bus stop"), tramAt(41.3879, 2.169, "Tram stop"), metroAt(41.38785, 2.16905, "Metro station")],
      HOME,
    );
    expect(list.map((s) => s.kind)).toEqual(["metro", "tram", "bus"]);
  });

  it("keeps the ride faster than a bus and slower than free-flow driving", () => {
    const originStations = toStations([metroAt(41.3881, 2.169, "A"), busAt(41.3876, 2.1688, "B")], HOME);
    const destStations = toStations([metroAt(41.3981, 2.1935, "C"), busAt(41.398, 2.1945, "D")], WORK);
    const plan = assemblePlan({ origin: HOME, destination: WORK, originStations, destStations, maxWalkMinutes: 12 });
    expect(plan.avgSpeedKmh).toBeGreaterThan(8);
    expect(plan.avgSpeedKmh).toBeLessThan(45);
    expect(plan.bufferMinutes).toBeGreaterThan(0);
    expect(plan.onTimeRisk).toBeLessThan(0.5);
  });

  it("reports what it could not find instead of inventing a route", () => {
    const plan = assemblePlan({ origin: HOME, destination: WORK, originStations: [], destStations: [], maxWalkMinutes: 12 });
    expect(plan.available).toBe(false);
    expect(plan.source).toBe("unavailable");
    expect(plan.legs).toHaveLength(0);
    expect(plan.stationsFound.origin).toBe(0);
  });

  it("honours a tighter headway scale on both wait and risk", () => {
    const args = {
      origin: HOME,
      destination: WORK,
      originStations: toStations([metroAt(41.3881, 2.169, "A")], HOME),
      destStations: toStations([metroAt(41.3981, 2.1935, "C")], WORK),
      maxWalkMinutes: 12,
    };
    const frequent = assemblePlan({ ...args, headwayScale: 0.5 });
    const sparse = assemblePlan({ ...args, headwayScale: 2 });
    expect(sparse.waitMinutes).toBeGreaterThan(frequent.waitMinutes);
    expect(sparse.totalMinutes).toBeGreaterThan(frequent.totalMinutes);
    expect(sparse.bufferMinutes).toBeGreaterThan(frequent.bufferMinutes);
  });
});
