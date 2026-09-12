import { clamp, haversineM, mulberry32, round } from "./util";
import type { Place, TransitLeg, TransitPlan, UserSettings } from "./types";

/**
 * Public transport.
 *
 * There is no key-free, CORS-enabled, worldwide transit *timetable* API, so
 * Radius does something defensible instead of pretending: it looks up the
 * **real stops and stations** around both ends of your trip in OpenStreetMap
 * (Overpass, no key), computes the **real walking distances**, and then prices
 * the ride with a published-by-mode network speed plus dwell per stop. That
 * makes the walk, the access geometry and the choice of mode measured, while
 * the headway is an explicit model you can correct in Settings.
 *
 * It is a plan, not a timetable: it will not know that the 08:14 doesn't run.
 */

const OVERPASS = "https://overpass-api.de/api/interpreter";

export type StopKind = "metro" | "rail" | "tram" | "bus";

export interface StationCandidate {
  lat: number;
  lon: number;
  name: string;
  kind: StopKind;
  distanceM: number;
}

interface KindProfile {
  label: string;
  /** Average link speed including stops, km/h. */
  speedKmh: number;
  /** Peak-ish headway in minutes; user setting overrides the scale. */
  headwayMinutes: number;
  /** metres of walking you will tolerate to reach it. */
  accessRadiusM: number;
  /** km between consecutive stops — sets dwell. */
  stopSpacingKm: number;
  dwellSeconds: number;
  /** Route length ÷ crow-flight. */
  detour: number;
  /** Share of the ride spent outdoors. */
  outdoor: number;
}

export const KIND_PROFILES: Record<StopKind, KindProfile> = {
  metro: { label: "Metro", speedKmh: 36, headwayMinutes: 4, accessRadiusM: 1400, stopSpacingKm: 1.25, dwellSeconds: 25, detour: 1.16, outdoor: 0.1 },
  rail: { label: "Commuter rail", speedKmh: 47, headwayMinutes: 12, accessRadiusM: 1600, stopSpacingKm: 3.6, dwellSeconds: 35, detour: 1.28, outdoor: 0.3 },
  tram: { label: "Tram", speedKmh: 22, headwayMinutes: 8, accessRadiusM: 950, stopSpacingKm: 0.62, dwellSeconds: 20, detour: 1.3, outdoor: 0.55 },
  bus: { label: "Bus", speedKmh: 16, headwayMinutes: 10, accessRadiusM: 520, stopSpacingKm: 0.7, dwellSeconds: 25, detour: 1.44, outdoor: 0.85 },
};

const WALK_M_PER_MIN = 78; // 4.7 km/h, a normal commuter pace with a laptop bag
const WALK_ROUTE_FACTOR = 1.32; // streets are not straight lines
const TRANSFER_MINUTES = 3.5;

/** Classify one OSM element into a stop kind, or reject it. */
export function classifyStop(tags: Record<string, string> | undefined): StopKind | null {
  if (!tags) return null;
  const station = tags.station ?? "";
  const railway = tags.railway ?? "";
  if (station === "subway" || station === "lightRail" || station === "monorail") return station === "lightRail" ? "tram" : "metro";
  if (railway === "tram_stop") return "tram";
  if (railway === "station" || railway === "halt" || tags.train === "yes") return "rail";
  if (railway === "subway_entrance") return "metro";
  if (tags.highway === "bus_stop" || tags.bus === "yes" || tags.public_transport === "platform") return "bus";
  return null;
}

interface OverpassElement {
  type?: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Turn raw Overpass elements into de-duplicated, distance-sorted candidates.
 * Pure, so it can be tested against a captured payload.
 */
export function toStations(elements: OverpassElement[], anchor: Place, kindFilter?: StopKind): StationCandidate[] {
  const byKey = new Map<string, StationCandidate>();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const kind = classifyStop(el.tags);
    if (!kind || (kindFilter && kind !== kindFilter)) continue;
    const distanceM = haversineM([anchor.lat, anchor.lon], [lat, lon]);
    const rawName = el.tags?.name || el.tags?.["name:en"] || el.tags?.ref || `${kind} stop`;
    // Multiple platforms of one station are one place for a traveller.
    const key = `${kind}:${rawName.toLowerCase()}`;
    const candidate: StationCandidate = { lat, lon, name: rawName, kind, distanceM };
    const existing = byKey.get(key);
    if (!existing || existing.distanceM > distanceM) byKey.set(key, candidate);
  }
  return [...byKey.values()].sort((a, b) => {
    // Prefer the fastest usable network, then the shortest walk.
    const rank = (k: StopKind) => (k === "metro" ? 0 : k === "rail" ? 1 : k === "tram" ? 2 : 3);
    return rank(a.kind) - rank(b.kind) || a.distanceM - b.distanceM;
  });
}

export function walkMinutes(distanceM: number): number {
  return (distanceM * WALK_ROUTE_FACTOR) / WALK_M_PER_MIN;
}

export interface AssembleInput {
  origin: Place;
  destination: Place;
  originStations: StationCandidate[];
  destStations: StationCandidate[];
  maxWalkMinutes: number;
  /** Headway scale from user settings (1 = the per-mode default). */
  headwayScale?: number;
  /** Preferred network, e.g. someone who refuses to take the bus. */
  prefer?: StopKind[];
}

/**
 * Cost the journey for every mode that has a usable station at both ends and
 * return the cheapest. This is where "metro vs bus" stops being a guess.
 */
export function assemblePlan(input: AssembleInput): TransitPlan {
  const scale = input.headwayScale ?? 1;
  const kinds = input.prefer?.length ? input.prefer : (["metro", "rail", "tram", "bus"] as StopKind[]);
  const crowFlightKm = haversineM([input.origin.lat, input.origin.lon], [input.destination.lat, input.destination.lon]) / 1000;

  let best: { plan: TransitPlan; total: number } | null = null;
  const rejected: string[] = [];

  for (const kind of kinds) {
    const profile = KIND_PROFILES[kind];
    const o = input.originStations.find((s) => s.kind === kind);
    const d = input.destStations.find((s) => s.kind === kind);
    if (!o || !d) {
      rejected.push(`${profile.label}: no ${kind} stop found at ${!o ? "your end" : "the office end"}`);
      continue;
    }
    const walkOut = walkMinutes(o.distanceM);
    const walkIn = walkMinutes(d.distanceM);
    if (walkOut > input.maxWalkMinutes + 6 || walkIn > input.maxWalkMinutes + 6) {
      rejected.push(`${profile.label}: ${round(Math.max(walkOut, walkIn), 0)} min walk is past your limit`);
      continue;
    }

    const rideKm = (haversineM([o.lat, o.lon], [d.lat, d.lon]) / 1000) * profile.detour;
    if (rideKm < 0.35) {
      rejected.push(`${profile.label}: stations are closer together than your trip`);
      continue;
    }
    const stops = Math.max(1, Math.round(rideKm / profile.stopSpacingKm));
    const rideMinutes = (rideKm / profile.speedKmh) * 60 + (stops * profile.dwellSeconds) / 60;
    const headway = profile.headwayMinutes * scale;
    // Random arrival at a stop ⇒ mean wait is half a headway.
    const transfers = kind === "rail" || crowFlightKm < 4 ? 0 : 1;
    const waitMinutes = headway / 2 + transfers * (headway / 2 + TRANSFER_MINUTES);

    const total = walkOut + walkIn + rideMinutes + waitMinutes;
    const legs: TransitLeg[] = [
      { kind: "walk", label: `Walk to ${o.name}`, minutes: round(walkOut, 1), coords: [[input.origin.lat, input.origin.lon], [o.lat, o.lon]] },
      { kind: "wait", label: `Wait for ${profile.label} (${Math.round(headway)} min service)`, minutes: round(headway / 2, 1), coords: [[o.lat, o.lon], [o.lat, o.lon]] },
      { kind: "ride", label: `${profile.label}: ${o.name} → ${d.name} · ${stops} stops`, minutes: round(rideMinutes, 1), coords: [[o.lat, o.lon], [d.lat, d.lon]] },
    ];
    if (transfers > 0) {
      legs.push({ kind: "wait", label: "Change here", minutes: round(headway / 2 + TRANSFER_MINUTES, 1), coords: [[d.lat, d.lon], [d.lat, d.lon]] });
    }
    legs.push({ kind: "walk", label: "Walk to your desk", minutes: round(walkIn, 1), coords: [[d.lat, d.lon], [input.destination.lat, input.destination.lon]] });

    const outdoorMinutes = walkOut + walkIn + (kind === "bus" || kind === "tram" ? rideMinutes : 0) + headway / 2;
    const plan: TransitPlan = {
      available: true,
      modeLabel: profile.label,
      legs,
      totalMinutes: round(total, 1),
      walkMinutes: round(walkOut + walkIn, 1),
      rideMinutes: round(rideMinutes, 1),
      waitMinutes: round(waitMinutes, 1),
      transfers,
      bufferMinutes: round(headway * 0.75, 1),
      // One missed vehicle is the whole risk story for frequent service.
      onTimeRisk: clamp((headway / 2) / Math.max(6, total), 0.02, 0.45),
      avgSpeedKmh: round((crowFlightKm / Math.max(1, total)) * 60, 1),
      exposureFraction: clamp(outdoorMinutes / Math.max(1, total), 0, 1),
      stationsFound: {
        origin: input.originStations.filter((s) => s.kind === kind).length,
        destination: input.destStations.filter((s) => s.kind === kind).length,
      },
      source: "osm+model",
      notes: [
        `${profile.label} modelled at ${profile.speedKmh} km/h with ${Math.round(profile.stopSpacingKm * 10) / 10} km between stops; walk at 4.7 km/h.`,
        transfers > 0 ? "One change assumed — OSM stops do not encode lines, so transfers are modelled, not scheduled." : "Assumed direct: the two stops are close enough that a single leg is plausible.",
      ],
    };
    if (!best || total < best.total) best = { plan, total };
  }

  if (!best) {
    return {
      available: false,
      modeLabel: "Public transport",
      legs: [],
      totalMinutes: 0,
      walkMinutes: 0,
      rideMinutes: 0,
      waitMinutes: 0,
      transfers: 0,
      bufferMinutes: 0,
      onTimeRisk: 0,
      avgSpeedKmh: 0,
      exposureFraction: 0,
      stationsFound: { origin: input.originStations.length, destination: input.destStations.length },
      source: "unavailable",
      notes: rejected.length
        ? rejected
        : ["No metro, commuter rail, tram or bus stop could be read from OpenStreetMap for either end of this trip."],
    };
  }
  return best.plan;
}

function overpassQuery(lat: number, lon: number, radius: number): string {
  return `[out:json][timeout:20];
(
  node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](around:${radius},${lat},${lon});
  node["station"~"^(subway|lightRail|monorail)$"](around:${radius},${lat},${lon});
  node["highway"="bus_stop"](around:${Math.min(radius, 650)},${lat},${lon});
  way["railway"~"^(station|halt)$"](around:${radius},${lat},${lon});
);
out center 40;`;
}

async function queryOverpass(lat: number, lon: number, radius: number, signal?: AbortSignal): Promise<OverpassElement[]> {
  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(overpassQuery(lat, lon, radius))}`,
      signal: signal ?? AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { elements?: OverpassElement[] };
    return Array.isArray(data.elements) ? data.elements : [];
  } catch {
    return [];
  }
}

/** The shape returned when no mode pairs up. Rendered as an explanation. */
export const NO_TRANSIT_PLAN: TransitPlan = {
  available: false,
  modeLabel: "Public transport",
  legs: [],
  totalMinutes: 0,
  walkMinutes: 0,
  rideMinutes: 0,
  waitMinutes: 0,
  transfers: 0,
  bufferMinutes: 0,
  onTimeRisk: 0,
  avgSpeedKmh: 0,
  exposureFraction: 0,
  stationsFound: { origin: 0, destination: 0 },
  source: "unavailable",
  notes: ["Transit was not looked up for this evaluation."],
};

export interface PlanTransitResult {
  plan: TransitPlan;
  headwayMinutes: number;
}

/**
 * Network entry point. Two Overpass calls, no timetables, no keys, and a
 * deterministic jitter so repeated refreshes do not make the plan flicker.
 */
export async function planTransit(
  from: Place,
  to: Place,
  settings: UserSettings,
  signal?: AbortSignal,
): Promise<PlanTransitResult> {
  const radius = Math.max(KIND_PROFILES.metro.accessRadiusM, KIND_PROFILES.rail.accessRadiusM);
  const [originElements, destElements] = await Promise.all([
    queryOverpass(from.lat, from.lon, radius, signal),
    queryOverpass(to.lat, to.lon, radius, signal),
  ]);

  // Headway scale: a city with severe crowding also runs tighter services, and
  // the traveller can set it; small towns feel the difference of a 20-min bus.
  const seed = mulberry32(Math.abs(Math.round(from.lat * 100) * 13 + Math.round(to.lon * 100) * 7))();
  const headwayScale = clamp(1.15 - 0.12 * settings.citySeverity + seed * 0.08, 0.75, 1.7);

  const plan = assemblePlan({
    origin: from,
    destination: to,
    originStations: toStations(originElements, from),
    destStations: toStations(destElements, to),
    maxWalkMinutes: settings.transitMaxWalkMinutes,
    headwayScale,
  });

  const dominant = plan.available ? plan.modeLabel.toLowerCase() : "none";
  const profile =
    dominant.includes("metro") ? KIND_PROFILES.metro
    : dominant.includes("commuter") ? KIND_PROFILES.rail
    : dominant.includes("tram") ? KIND_PROFILES.tram
    : KIND_PROFILES.bus;

  return { plan, headwayMinutes: round(profile.headwayMinutes * headwayScale, 1) };
}
