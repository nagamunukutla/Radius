// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { computeCdi } from "./lib/cdi";
import { estimateRoute } from "./lib/routing";

/**
 * End-to-end render smoke tests.
 *
 * The important property under test is "no failures": Radius must render a
 * complete, labelled evaluation even when every external API is unreachable,
 * and must consume realistic router/weather payloads without throwing.
 */

vi.mock("leaflet", () => {
  // Every Leaflet call in MapView is chained (L.map().on(), polyline().addTo(),
  // bounds.extend()), so one infinitely chainable callable proxy is enough.
  const stub: unknown = new Proxy(
    function noop() {
      return undefined;
    },
    {
      get: (_t, prop) => (prop === "then" ? undefined : stub),
      apply: () => stub,
    },
  );
  return { default: stub, map: stub, tileLayer: stub, layerGroup: stub, polyline: stub, marker: stub, divIcon: stub, latLngBounds: stub };
});

function osrmPayload(profile: string) {
  const speed = profile === "driving" ? 15 : profile === "cycling" ? 4.5 : 1.4;
  const coords: Array<[number, number]> = [];
  const speeds: number[] = [];
  const durations: number[] = [];
  const distances: number[] = [];
  for (let i = 0; i <= 20; i += 1) {
    coords.push([-0.6059 + i * 0.004, 38.8217 + i * 0.0032]);
    if (i < 20) {
      const s = i > 6 && i < 13 ? 6.5 : speed + (i % 3) * 1.5;
      const d = 380 + (i % 4) * 90;
      speeds.push(s);
      distances.push(d);
      durations.push(d / s);
    }
  }
  const total = durations.reduce((a, b) => a + b, 0);
  return {
    code: "Ok",
    routes: [
      {
        distance: distances.reduce((a, b) => a + b, 0),
        duration: total,
        geometry: { type: "LineString", coordinates: coords },
        legs: [{ annotation: { speed: speeds, duration: durations, distance: distances } }],
      },
      { distance: 12000, duration: total * 1.12, geometry: { type: "LineString", coordinates: coords }, legs: [{ annotation: { speed: speeds, duration: durations, distance: distances } }] },
    ],
  };
}

function weatherPayload(rainy: boolean) {
  const hourly = Array.from({ length: 48 }, (_, i) => {
    const hour = i % 24;
    return {
      time: `2026-09-${hour < 10 ? "12" : "12"}T${String(hour).padStart(2, "0")}:00`,
      precipitation: rainy && hour >= 7 && hour <= 10 ? 2.4 : 0,
      wind_speed_10m: rainy ? 34 : 8,
      weather_code: rainy && hour >= 7 && hour <= 10 ? 63 : 1,
    };
  });
  return {
    current: {
      temperature_2m: rainy ? 17 : 24,
      wind_speed_10m: rainy ? 34 : 8,
      precipitation: rainy ? 2.4 : 0,
      weather_code: rainy ? 63 : 1,
      relative_humidity_2m: 70,
    },
    hourly: {
      time: hourly.map((h) => h.time),
      precipitation: hourly.map((h) => h.precipitation),
      wind_speed_10m: hourly.map((h) => h.wind_speed_10m),
      weather_code: hourly.map((h) => h.weather_code),
    },
  };
}

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.restoreAllMocks();
});

describe("Radius UI", () => {
  it("renders a full evaluation when every external API is down", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => expect(screen.getAllByText(/COMMUTE DRAG INDEX/i).length).toBeGreaterThan(0), { timeout: 8000 });

    // Six weighted factors, a map, a curve, and an honest explanation.
    await waitFor(() => expect(screen.getAllByText(/\/100/).length).toBeGreaterThanOrEqual(6));
    expect(screen.getAllByLabelText(/Route map with congestion colouring/i).length).toBe(1);
    expect(screen.getAllByText(/built-in estimator|offline estimate|Router unreachable/i).length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalled();
  }, 20000);

  it("consumes realistic OSRM + Open-Meteo payloads without breaking", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("router.project-osrm.org")) {
        const profile = url.includes("/cycling/") ? "cycling" : url.includes("/foot/") ? "foot" : "driving";
        if (profile === "foot") return json({ code: "TooBigCoordinates", routes: [] });
        return json(osrmPayload(profile));
      }
      if (url.includes("api.open-meteo.com")) return json(weatherPayload(true));
      if (url.includes("nominatim")) return json([]);
      return json({});
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => expect(screen.getAllByText(/OSRM \(live\)/i).length).toBeGreaterThan(0), { timeout: 8000 });
    await waitFor(() => expect(screen.getAllByText(/Open-Meteo \(live\)/i).length).toBeGreaterThan(0));
    // Rain must show up as weather friction, not as a crash.
    expect(screen.getAllByText(/63|Rain/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Departure curve/i).length).toBe(1);
    expect(screen.getAllByText(/leave /i).length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("scores a fallback route deterministically across refreshes", () => {
    const a = estimateRoute(
      { name: "home", short: "home", lat: 38.8217, lon: -0.6059 },
      { name: "work", short: "work", lat: 39.4699, lon: -0.3763 },
      1.3,
    );
    const b = estimateRoute(
      { name: "home", short: "home", lat: 38.8217, lon: -0.6059 },
      { name: "work", short: "work", lat: 39.4699, lon: -0.3763 },
      1.3,
    );
    expect(a.typicalSeconds).toBe(b.typicalSeconds);
    expect(computeCdi({
      predictedMinutes: a.typicalSeconds / 60,
      freeflowMinutes: a.typicalSeconds / 60 / 1.3,
      medianMinutes: a.typicalSeconds / 60,
      p95Minutes: (a.typicalSeconds / 60) * 1.2,
      slowFraction: 0.2,
      stopEventsPer10km: 2,
      weatherPoints: 0,
      distanceKm: a.distanceM / 1000,
      hasViableAlternative: false,
      daysPerWeek: 5,
    }).score).toBeGreaterThan(0);
  });
});
