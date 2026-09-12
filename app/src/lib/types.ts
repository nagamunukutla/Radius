/**
 * Radius — shared domain types.
 * Everything the UI renders is derived from these shapes so the scoring
 * engine can be unit-tested without a DOM.
 */

export interface Place {
  /** Human label, e.g. "Ontinyent, València, Spain" */
  name: string;
  /** Compressed label for chips, e.g. "Ontinyent" */
  short: string;
  lat: number;
  lon: number;
}

export interface RouteSegment {
  /** [lat, lon] pairs */
  coords: Array<[number, number]>;
  distanceM: number;
  seconds: number;
  avgSpeedKmh: number;
}

export interface RouteResult {
  distanceM: number;
  /** Duration reported by the router for "typical" conditions, in seconds. */
  typicalSeconds: number;
  segments: RouteSegment[];
  /** [lat, lon] pairs for the whole route. */
  geometry: Array<[number, number]>;
  alternativeCount: number;
  /** "osrm" = real router answer, "estimated" = built-in fallback. */
  source: "osrm" | "estimated";
  durationSource: "live-traffic" | "typical-router" | "estimated";
}

export interface WeatherSnapshot {
  tempC: number;
  windKph: number;
  precipMm: number;
  /** WMO weather interpretation code. */
  code: number;
  label: string;
  /** 0..100 stress the weather adds to the drive. */
  frictionPoints: number;
  source: "open-meteo" | "unavailable";
}

export interface TravelModes {
  walkSeconds: number | null;
  bikeSeconds: number | null;
  transitMinutes: number | null;
}

export interface CdiFactor {
  key: string;
  label: string;
  /** 0..100, higher = worse. */
  score: number;
  /** Contribution weight, all weights sum to 1. */
  weight: number;
  /** One-line human explanation with the real numbers in it. */
  detail: string;
}

export interface CdiResult {
  score: number;
  band: CdiBand;
  factors: CdiFactor[];
  advice: string[];
}

export interface CdiBand {
  key: "smooth" | "manageable" | "strained" | "heavy" | "gridlock";
  label: string;
  color: string;
  blurb: string;
}

export interface DepartureOption {
  /** Minutes from now (can be negative for "you already left"). */
  minutesFromNow: number;
  clock: string;
  travelSeconds: number;
  /** Arrival = departure + travel, minutes from now. */
  arrivalInMinutes: number;
  cdi: number;
  bufferMinutes: number;
}

export interface CommuteEvaluation {
  distanceKm: number;
  typicalMinutes: number;
  freeflowMinutes: number;
  predictedMinutes: number;
  medianMinutes: number;
  p95Minutes: number;
  reliabilityMinutes: number;
  slowFraction: number;
  stopEventsPer10km: number;
  weather: WeatherSnapshot;
  modes: TravelModes;
  cdi: CdiResult;
  departureOptions: DepartureOption[];
  recommended: DepartureOption | null;
  savings: { minutes: number; cdi: number } | null;
  productivity: {
    weeklyWastedMinutes: number;
    annualWastedHours: number;
    reclaimableWeeklyHours: number;
    weeklyCost: number;
    co2KgWeekly: number;
  };
  route: RouteResult;
  generatedAt: number;
  degraded: boolean;
  notes: string[];
}

export interface UserSettings {
  workStartMinutes: number;
  daysPerWeek: number;
  hourlyRate: number;
  currency: string;
  commuteMode: "drive" | "bike" | "walk";
  trafficProvider: "model" | "tomtom";
  tomtomKey: string;
  refreshSeconds: number;
  vehicleCO2PerKm: number;
  peakAm: number;
  peakPm: number;
  citySeverity: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  workStartMinutes: 9 * 60,
  daysPerWeek: 5,
  hourlyRate: 45,
  currency: "EUR",
  commuteMode: "drive",
  trafficProvider: "model",
  tomtomKey: "",
  refreshSeconds: 60,
  vehicleCO2PerKm: 0.171,
  peakAm: 8.5,
  peakPm: 18,
  citySeverity: 1,
};
