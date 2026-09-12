import { clamp, haversineM, mulberry32, pathLengthM } from "./util";
import type { Place, RouteResult, RouteSegment, TravelModes } from "./types";

/**
 * Routing + traffic context.
 *
 * Primary: the public OSRM demo server (no key, CORS-enabled) for geometry,
 * distance and "typical" duration, plus per-edge speeds that drive the
 * stop-and-go factor.
 * Optional: a TomTom Traffic Flow key upgrades the delay factor to true live
 * congestion. Neither is required — the built-in estimator keeps the app alive.
 */

const OSRM = "https://router.project-osrm.org";

export interface RouteQuery {
  from: Place;
  to: Place;
  profile?: "driving" | "cycling" | "foot";
  /** Hours-of-day factor already applied to the fallback estimate. */
  demandFactor?: number;
}

export interface RouteBundle {
  primary: RouteResult;
  modes: TravelModes;
  notes: string[];
  /** 1 when the router answered, 0 when everything fell back to the estimator. */
  confidence: number;
}

export async function fetchRoutes(q: RouteQuery): Promise<RouteBundle> {
  const notes: string[] = [];
  const profile = q.profile ?? "driving";

  const [main, bike, walk] = await Promise.all([
    requestOsrm(q.from, q.to, profile, true),
    profile === "driving" ? requestOsrm(q.from, q.to, "cycling", false) : Promise.resolve(null),
    profile === "driving" ? requestOsrm(q.from, q.to, "foot", false) : Promise.resolve(null),
  ]);

  let primary: RouteResult;
  let confidence = 0;
  if (main) {
    primary = main;
    confidence = 1;
  } else {
    notes.push(
      "Router unreachable from this network — geometry and timings came from Radius' built-in estimator, so absolute minutes are indicative.",
    );
    primary = estimateRoute(q.from, q.to, q.demandFactor ?? 1.2);
  }

  const modes: TravelModes = {
    bikeSeconds: bike?.distanceM && bike.distanceM < 20000 ? bike.typicalSeconds : null,
    walkSeconds: walk?.distanceM && walk.distanceM < 3000 ? walk.typicalSeconds : null,
    transitMinutes: null,
  };
  // A simple, honest transit heuristic: drive time inflated by waiting and
  // transfers, only quoted when the trip is long enough to care.
  if (primary.distanceM > 4000) {
    modes.transitMinutes = Math.round((primary.typicalSeconds / 60) * 1.45 + 11);
  }

  return { primary, modes, notes, confidence };
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: Array<[number, number]> };
  legs?: Array<{
    annotation?: { speed?: number[]; duration?: number[]; distance?: number[] };
  }>;
}

async function requestOsrm(
  from: Place,
  to: Place,
  profile: string,
  withAnnotations: boolean,
): Promise<RouteResult | null> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `${OSRM}/route/v1/${profile}/${coords}?overview=full&geometries=geojson${
    withAnnotations ? "&alternatives=3" : ""
  }${withAnnotations ? "&annotations=duration,distance,speed" : ""}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { code?: string; routes?: OsrmRoute[] };
    if (data.code !== "Ok" || !data.routes?.length) return null;
    const best = data.routes[0];
    const geometry = best.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]);
    const segments = withAnnotations
      ? segmentFromAnnotations(geometry, best.legs?.[0]?.annotation)
      : chunkByDistance(geometry, 8);
    return {
      distanceM: best.distance,
      typicalSeconds: best.duration,
      segments,
      geometry,
      alternativeCount: Math.max(0, (data.routes?.length ?? 1) - 1),
      source: "osrm",
      durationSource: "typical-router",
    };
  } catch {
    return null;
  }
}

/** OSRM annotation arrays are per-edge (between consecutive coordinates). */
function segmentFromAnnotations(
  geometry: Array<[number, number]>,
  annotation?: { speed?: number[]; duration?: number[]; distance?: number[] },
): RouteSegment[] {
  if (!annotation?.speed?.length || !annotation?.duration?.length) {
    return chunkByDistance(geometry, 8);
  }
  const edges: RouteSegment[] = [];
  const n = Math.min(geometry.length - 1, annotation.speed.length, annotation.duration.length);
  for (let i = 0; i < n; i += 1) {
    const speedMs = annotation.speed[i];
    const seconds = annotation.duration[i];
    const distanceM =
      annotation.distance?.[i] ?? (Number.isFinite(speedMs) && speedMs > 0 ? seconds * speedMs : haversineM(geometry[i], geometry[i + 1]));
    edges.push({
      coords: [geometry[i], geometry[i + 1]],
      distanceM,
      seconds,
      avgSpeedKmh: Number.isFinite(speedMs) ? speedMs * 3.6 : 0,
    });
  }
  return mergeEdges(edges, 10);
}

/** Group per-edge data into ~N readable chunks for colouring the map. */
function mergeEdges(edges: RouteSegment[], target: number): RouteSegment[] {
  if (edges.length <= target) return edges;
  const total = edges.reduce((s, e) => s + e.distanceM, 0) || 1;
  const chunkSize = total / target;
  const out: RouteSegment[] = [];
  let bucket: RouteSegment | null = null;
  let bucketLen = 0;
  for (const e of edges) {
    if (!bucket || bucketLen >= chunkSize) {
      if (bucket) out.push(finalize(bucket));
      bucket = { coords: [...e.coords], distanceM: 0, seconds: 0, avgSpeedKmh: 0 };
      bucketLen = 0;
    }
    bucket.distanceM += e.distanceM;
    bucket.seconds += e.seconds;
    bucketLen += e.distanceM;
    if (bucket.coords[bucket.coords.length - 1][0] !== e.coords[1][0]) {
      bucket.coords.push(e.coords[1]);
    }
  }
  if (bucket) out.push(finalize(bucket));
  return out;

  function finalize(b: RouteSegment): RouteSegment {
    return {
      ...b,
      avgSpeedKmh: b.seconds > 0 ? (b.distanceM / 1000 / b.seconds) * 3600 : 0,
    };
  }
}

function chunkByDistance(geometry: Array<[number, number]>, count: number): RouteSegment[] {
  if (geometry.length < 2) return [];
  const total = pathLengthM(geometry);
  const per = Math.max(1, total / count);
  const out: RouteSegment[] = [];
  let current: Array<[number, number]> = [geometry[0]];
  let acc = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    const d = haversineM(geometry[i - 1], geometry[i]);
    acc += d;
    current.push(geometry[i]);
    if (acc >= per) {
      out.push({ coords: current, distanceM: acc, seconds: 0, avgSpeedKmh: 0 });
      current = [geometry[i]];
      acc = 0;
    }
  }
  if (current.length > 1) out.push({ coords: current, distanceM: acc, seconds: 0, avgSpeedKmh: 0 });
  // Distribute duration by distance share when the router gave us no speeds.
  const anySpeed = out.some((s) => s.avgSpeedKmh > 0);
  if (!anySpeed && out.length) {
    const targetKmh = 42;
    for (const s of out) {
      s.avgSpeedKmh = targetKmh;
      s.seconds = (s.distanceM / 1000 / targetKmh) * 3600;
    }
  }
  return out;
}

/**
 * Deterministic fallback geometry: a slightly bowed path with a slow-down near
 * the mid-point "city core". Used only when the network is unavailable.
 */
export function estimateRoute(from: Place, to: Place, demandFactor: number): RouteResult {
  const direct = haversineM([from.lat, from.lon], [to.lat, to.lon]);
  const distanceM = Math.max(400, direct * 1.26);
  const rand = mulberry32(
    Math.abs(Math.round(from.lat * 1e4) * 31 + Math.round(from.lon * 1e4) * 17 + Math.round(to.lat * 1e4) * 7 + Math.round(to.lon * 1e4) * 3),
  );
  const steps = 46;
  const bow = (rand() - 0.5) * 0.34;
  const geometry: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const lat = from.lat + (to.lat - from.lat) * t;
    const lon = from.lon + (to.lon - from.lon) * t;
    const off = Math.sin(Math.PI * t) * bow * (direct / 111000) * 0.5;
    geometry.push([lat + off, lon - off * 0.45 + (rand() - 0.5) * 0.0009]);
  }
  const segments = chunkByDistance(geometry, 12);
  const coreStart = Math.floor(segments.length * 0.3);
  const coreEnd = Math.floor(segments.length * 0.62);
  let remaining = distanceM;
  segments.forEach((s, idx) => {
    let kmh: number;
    if (idx < coreStart) kmh = 52 + rand() * 18;
    else if (idx <= coreEnd) kmh = 16 + rand() * 12;
    else kmh = 46 + rand() * 22;
    kmh = clamp(kmh / clamp(demandFactor, 1, 2.4), 7, 118);
    s.avgSpeedKmh = kmh;
    s.seconds = (s.distanceM / 1000 / kmh) * 3600;
    remaining -= s.distanceM;
  });
  if (remaining > 0 && segments.length) {
    const last = segments[segments.length - 1];
    last.distanceM += remaining;
    last.seconds += (remaining / 1000 / last.avgSpeedKmh) * 3600;
  }
  const typicalSeconds = segments.reduce((s, x) => s + x.seconds, 0);
  return {
    distanceM: segments.reduce((s, x) => s + x.distanceM, 0),
    typicalSeconds: Math.max(120, typicalSeconds),
    segments,
    geometry,
    alternativeCount: 1,
    source: "estimated",
    durationSource: "estimated",
  };
}

/**
 * Optional live congestion: TomTom Traffic Flow. Skipped silently when no key
 * is configured so the free path never pays a network round trip.
 */
export async function fetchTomTomFlowRatio(
  geometry: Array<[number, number]>,
  apiKey: string,
): Promise<{ ratio: number; congestion: number } | null> {
  if (!apiKey || geometry.length < 2) return null;
  const step = Math.max(1, Math.floor(geometry.length / 30));
  const pts: string[] = [];
  for (let i = 0; i < geometry.length; i += step) {
    pts.push(`${geometry[i][0].toFixed(5)},${geometry[i][1].toFixed(5)}`);
  }
  if (pts[pts.length - 1] !== `${geometry[geometry.length - 1][0].toFixed(5)},${geometry[geometry.length - 1][1].toFixed(5)}`) {
    pts.push(`${geometry[geometry.length - 1][0].toFixed(5)},${geometry[geometry.length - 1][1].toFixed(5)}`);
  }
  try {
    const url = new URL("https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json");
    url.searchParams.set("points", pts.join(":"));
    url.searchParams.set("key", apiKey);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      flowSegmentData?: { currentFlow: number; freeFlow: number; speed: number };
    };
    const f = data.flowSegmentData;
    if (!f || !f.currentFlow || !f.freeFlow) return null;
    return {
      ratio: clamp(f.freeFlow / f.currentFlow, 0.28, 3.2),
      congestion: clamp((1 - f.currentFlow / f.freeFlow) * 100, 0, 100),
    };
  } catch {
    return null;
  }
}
