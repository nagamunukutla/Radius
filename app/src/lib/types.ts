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
  /** Minutes-of-day of this departure, so filters never re-parse strings. */
  departureClockMinutes: number;
  travelSeconds: number;
  /** Arrival = departure + travel, minutes from now. */
  arrivalInMinutes: number;
  cdi: number;
  bufferMinutes: number;
  /** Minutes of the trip spent waiting (transit only; 0 when driving). */
  waitMinutes: number;
  /** Minutes-of-day the clock says when you land, for on-time arithmetic. */
  arrivalClockMinutes: number;
  /** How far *before* your start you land. Sitting at an empty desk is a cost. */
  earlyMinutes: number;
  /** How far *after* your start you land. */
  lateMinutes: number;
  /** Probability the p95 day makes you late, 0..1, from the reliability band. */
  onTimeRisk: number;
  /** Composite cost the planner minimises — lower is better. */
  cost: number;
  /** Full index breakdown for this slot, so headline and curve share one path. */
  cdiResult?: CdiResult;
}

export type PlanStyle = "balanced" | "latest" | "lowestDrag" | "protectMorning";

/** A single leg of a public-transport journey. */
export interface TransitLeg {
  kind: "walk" | "wait" | "ride";
  label: string;
  minutes: number;
  coords: Array<[number, number]>;
}

export interface TransitPlan {
  available: boolean;
  modeLabel: string;
  legs: TransitLeg[];
  totalMinutes: number;
  walkMinutes: number;
  rideMinutes: number;
  waitMinutes: number;
  transfers: number;
  /** p95 minus median: a missed connection costs a headway, not a minute. */
  bufferMinutes: number;
  onTimeRisk: number;
  avgSpeedKmh: number;
  /** Share of the journey in the open air — this is what weather multiplies. */
  exposureFraction: number;
  stationsFound: { origin: number; destination: number };
  source: "osm+model" | "unavailable";
  notes: string[];
}

export interface ModeComparison {
  mode: "drive" | "transit" | "bike" | "walk";
  label: string;
  minutes: number | null;
  bufferMinutes: number | null;
  cdi: number | null;
  co2Kg: number | null;
  viable: boolean;
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
  /** What leaving at this instant would cost, for the "wait or go" decision. */
  leaveNow: DepartureOption | null;
  savings: { minutes: number; cdi: number } | null;
  productivity: {
    weeklyWastedMinutes: number;
    annualWastedHours: number;
    reclaimableWeeklyHours: number;
    weeklyCost: number;
    co2KgWeekly: number;
  };
  route: RouteResult;
  primaryMode: "drive" | "transit" | "bike" | "walk";
  departureWindow: { start: number; end: number; step: number } | null;
  transit: TransitPlan;
  comparison: ModeComparison[];
  latestSafeClock: string | null;
  earliestSaneClock: string | null;
  generatedAt: number;
  degraded: boolean;
  notes: string[];
}

export interface UserSettings {
  workStartMinutes: number;
  daysPerWeek: number;
  hourlyRate: number;
  currency: string;
  commuteMode: "drive" | "transit" | "bike" | "walk";
  /** Hard floor: the planner will never suggest leaving before this. */
  earliestDepartureMinutes: number;
  /** Arriving up to this many minutes early is free; beyond it costs. */
  maxEarlyArrivalMinutes: number;
  planStyle: PlanStyle;
  /** Longest access/egress walk you will accept for a transit leg. */
  transitMaxWalkMinutes: number;
  /** How often you accept being late. Slots above it are not recommended. */
  lateRiskBudget: number;
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
  earliestDepartureMinutes: 7 * 60,
  maxEarlyArrivalMinutes: 12,
  planStyle: "balanced",
  transitMaxWalkMinutes: 12,
  lateRiskBudget: 0.1,
  trafficProvider: "model",
  tomtomKey: "",
  refreshSeconds: 60,
  vehicleCO2PerKm: 0.171,
  peakAm: 8.5,
  peakPm: 18,
  citySeverity: 1,
};
