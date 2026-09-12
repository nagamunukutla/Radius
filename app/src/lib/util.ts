/** Small pure helpers shared across providers and the scoring engine. */

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const round = (v: number, digits = 0): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Piecewise-linear normalisation: maps a raw metric onto 0..100 using
 * documented (value, score) anchors. Interpolates linearly between anchors,
 * clamps outside them, and returns 0 for non-finite input.
 */
export function normalize(
  value: number,
  anchors: Array<[number, number]>,
): number {
  if (!Number.isFinite(value)) return 0;
  const sorted = [...anchors].sort((a, b) => a[0] - b[0]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (value <= first[0]) return clamp(first[1], 0, 100);
  if (value >= last[0]) return clamp(last[1], 0, 100);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const [x0, y0] = sorted[i];
    const [x1, y1] = sorted[i + 1];
    if (value >= x0 && value <= x1) {
      const t = x1 === x0 ? 0 : (value - x0) / (x1 - x0);
      return clamp(y0 + t * (y1 - y0), 0, 100);
    }
  }
  return clamp(last[1], 0, 100);
}

/** Haversine distance in metres between two [lat, lon] points. */
export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthM(coords: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) total += haversineM(coords[i - 1], coords[i]);
  return total;
}

/** 0..1439 clock minutes -> "08:42". */
export function minutesToClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function secondsToClock(sec: number): string {
  return minutesToClock(sec / 60);
}

export function humanDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

export function humanDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${round(km, km < 10 ? 1 : 0)} km`;
}

export function money(amount: number, currency: string): string {
  const symbol = currency === "EUR" ? "€" : currency === "INR" ? "₹" : currency === "USD" ? "$" : `${currency} `;
  const abs = Math.abs(amount);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 0 : 1;
  return `${amount < 0 ? "-" : ""}${symbol}${abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatKmPerHour(kmh: number): string {
  return `${Math.round(kmh)} km/h`;
}

/** Gaussian bump, used by the congestion model. */
export function gaussian(x: number, center: number, width: number, amplitude: number): number {
  const d = x - center;
  return amplitude * Math.exp(-(d * d) / (2 * width * width));
}

/** Deterministic PRNG so fallback estimates never flicker between refreshes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 1.5e-7). */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}
