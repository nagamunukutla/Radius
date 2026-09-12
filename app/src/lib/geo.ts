import { haversineM } from "./util";
import type { Place } from "./types";

/**
 * Geocoding. Nominatim (OpenStreetMap) is used when the browser can reach it;
 * a built-in gazetteer keeps the app fully usable offline or behind a blocked
 * network, so a search box can never be the reason the screen is empty.
 */

export const GAZETTEER: Place[] = [
  { name: "Ontinyent, València, Spain", short: "Ontinyent", lat: 38.8217, lon: -0.6059 },
  { name: "València, Spain", short: "València", lat: 39.4699, lon: -0.3763 },
  { name: "Alicante, Spain", short: "Alicante", lat: 38.3452, lon: -0.481 },
  { name: "Madrid, Spain", short: "Madrid", lat: 40.4168, lon: -3.7038 },
  { name: "Barcelona, Spain", short: "Barcelona", lat: 41.3874, lon: 2.1686 },
  { name: "Bilbao, Spain", short: "Bilbao", lat: 43.263, lon: -2.935 },
  { name: "Sevilla, Spain", short: "Sevilla", lat: 37.3891, lon: -5.9845 },
  { name: "Málaga, Spain", short: "Málaga", lat: 36.7213, lon: -4.4214 },
  { name: "Zaragoza, Spain", short: "Zaragoza", lat: 41.6488, lon: -0.8891 },
  { name: "Lisboa, Portugal", short: "Lisboa", lat: 38.7223, lon: -9.1393 },
  { name: "Paris, France", short: "Paris", lat: 48.8566, lon: 2.3522 },
  { name: "Berlin, Germany", short: "Berlin", lat: 52.52, lon: 13.405 },
  { name: "Amsterdam, Netherlands", short: "Amsterdam", lat: 52.3676, lon: 4.9041 },
  { name: "Dublin, Ireland", short: "Dublin", lat: 53.3498, lon: -6.2603 },
  { name: "London, United Kingdom", short: "London", lat: 51.5074, lon: -0.1278 },
  { name: "Kraków, Poland", short: "Kraków", lat: 50.0647, lon: 19.945 },
  { name: "Bengaluru, India", short: "Bengaluru", lat: 12.9716, lon: 77.5946 },
  { name: "Hyderabad, India", short: "Hyderabad", lat: 17.385, lon: 78.4867 },
  { name: "Pune, India", short: "Pune", lat: 18.5204, lon: 73.8567 },
  { name: "Toronto, Canada", short: "Toronto", lat: 43.6532, lon: -79.3832 },
  { name: "Austin, United States", short: "Austin", lat: 30.2672, lon: -97.7431 },
  { name: "Seattle, United States", short: "Seattle", lat: 47.6062, lon: -122.3321 },
];

export interface GeocodeOptions {
  signal?: AbortSignal;
  /** Number of results per query. */
  limit?: number;
}

export async function searchPlaces(query: string, opts: GeocodeOptions = {}): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const local = GAZETTEER.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5);

  let remote: Place[] = [];
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(opts.limit ?? 5));
    url.searchParams.set("addressdetails", "0");
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: opts.signal ?? AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data: unknown = await res.json();
      if (Array.isArray(data)) {
        remote = data
          .filter(
            (r): r is { lat: string; lon: string; display_name: string } =>
              !!r && typeof r === "object" && "lat" in r && "lon" in r && "display_name" in r,
          )
          .map((r) => toPlace(r.lat, r.lon, r.display_name))
          .filter((p): p is Place => p !== null);
      }
    }
  } catch {
    remote = [];
  }

  const merged: Place[] = [];
  const seen = new Set<string>();
  for (const p of [...remote, ...local]) {
    const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
    if (merged.length >= 6) break;
  }
  return merged;
}

function toPlace(lat: string | number, lon: string | number, displayName: string): Place | null {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  const parts = displayName.split(",").map((s) => s.trim());
  const short = parts[0]?.length ? parts[0] : displayName;
  return { name: parts.slice(0, 3).join(", "), short, lat: la, lon: lo };
}

/** Reverse geocode with graceful degradation to "lat, lon". */
export async function describePlace(lat: number, lon: number): Promise<Place> {
  const fallback: Place = {
    name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    short: `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    lat,
    lon,
  };
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "14");
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { display_name?: string };
    if (!data?.display_name) return fallback;
    return toPlace(lat, lon, data.display_name) ?? fallback;
  } catch {
    return fallback;
  }
}

export function straightLineKm(a: Place, b: Place): number {
  return haversineM([a.lat, a.lon], [b.lat, b.lon]) / 1000;
}
