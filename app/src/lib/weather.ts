import { NO_WEATHER, WEATHER_LABELS, weatherFrictionPoints } from "./congestion";
import type { WeatherSnapshot } from "./types";

/**
 * Weather via Open-Meteo (no key, CORS-enabled). Rain, wind and fog are the
 * only *observed* exogenous driver of drive-time inflation we can get for
 * free, so this call is worth a round trip. Failure is non-fatal.
 */

export interface WeatherInput {
  lat: number;
  lon: number;
  /** ISO local datetime for the forecast hour, e.g. 2026-09-12T08:30 */
  targetHour?: string;
}

export async function fetchWeather(input: WeatherInput): Promise<WeatherSnapshot> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", input.lat.toFixed(4));
    url.searchParams.set("longitude", input.lon.toFixed(4));
    url.searchParams.set("current", "temperature_2m,wind_speed_10m,precipitation,weather_code,relative_humidity_2m");
    url.searchParams.set("timezone", "auto");
    if (input.targetHour) {
      url.searchParams.set("forecast_hours", "24");
    }
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NO_WEATHER;
    const data = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        wind_speed_10m?: number;
        precipitation?: number;
        weather_code?: number;
      };
    };
    const c = data.current;
    if (!c) return NO_WEATHER;
    const tempC = num(c.temperature_2m, 21);
    const windKph = num(c.wind_speed_10m, 10);
    const precipMm = num(c.precipitation, 0);
    const code = Math.round(num(c.weather_code, 1));
    return {
      tempC: Math.round(tempC * 10) / 10,
      windKph: Math.round(windKph),
      precipMm: Math.round(precipMm * 10) / 10,
      code,
      label: WEATHER_LABELS[code] ?? "Conditions",
      frictionPoints: weatherFrictionPoints({ precipMm, windKph, tempC, code }),
      source: "open-meteo",
    };
  } catch {
    return NO_WEATHER;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Hourly precipitation for the departure sweep, so weather varies by slot. */
export type WeatherHours = Awaited<ReturnType<typeof fetchWeatherHours>>;

export async function fetchWeatherHours(
  lat: number,
  lon: number,
): Promise<Array<{ iso: string; precipMm: number; windKph: number; code: number }> | null> {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lon.toFixed(4));
    url.searchParams.set("hourly", "precipitation,wind_speed_10m,weather_code");
    url.searchParams.set("forecast_days", "2");
    url.searchParams.set("timezone", "auto");
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      hourly?: { time?: string[]; precipitation?: number[]; wind_speed_10m?: number[]; weather_code?: number[] };
    };
    const h = data.hourly;
    if (!h?.time?.length) return null;
    return h.time.map((iso, i) => ({
      iso,
      precipMm: h.precipitation?.[i] ?? 0,
      windKph: h.wind_speed_10m?.[i] ?? 0,
      code: h.weather_code?.[i] ?? 1,
    }));
  } catch {
    return null;
  }
}

export function weatherAt(
  hours: Awaited<ReturnType<typeof fetchWeatherHours>>,
  fallback: WeatherSnapshot,
  when: Date,
): WeatherSnapshot {
  if (!hours?.length) return fallback;
  const key = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(
    when.getDate(),
  ).padStart(2, "0")}T${String(when.getHours()).padStart(2, "0")}:00`;
  const hit = hours.find((h) => h.iso === key) ?? hours[0];
  const points = weatherFrictionPoints({
    precipMm: hit.precipMm,
    windKph: hit.windKph,
    tempC: fallback.tempC,
    code: hit.code,
  });
  return {
    tempC: fallback.tempC,
    windKph: Math.round(hit.windKph),
    precipMm: Math.round(hit.precipMm * 10) / 10,
    code: hit.code,
    label: WEATHER_LABELS[hit.code] ?? fallback.label,
    frictionPoints: points,
    source: fallback.source,
  };
}
