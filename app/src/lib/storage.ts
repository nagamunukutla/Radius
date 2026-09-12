import { DEFAULT_SETTINGS } from "./types";
import type { Place, UserSettings } from "./types";

/**
 * localStorage persistence, defensive by design: private-mode Safari and
 * file:// contexts throw on access, which must never take the app down.
 */

const KEYS = { settings: "radius.settings.v1", saved: "radius.saved.v1", recent: "radius.recent.v1" };

export interface SavedCommute {
  id: string;
  label: string;
  from: Place;
  to: Place;
  createdAt: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled — the session still works */
  }
}

export const loadSettings = (): UserSettings => read<UserSettings>(KEYS.settings, DEFAULT_SETTINGS);
export const saveSettings = (s: UserSettings): void => write(KEYS.settings, s);

export const loadSaved = (): SavedCommute[] => {
  try {
    const raw = localStorage.getItem(KEYS.saved);
    const parsed = raw ? (JSON.parse(raw) as SavedCommute[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
  } catch {
    return [];
  }
};

export function persistSaved(list: SavedCommute[]): void {
  try {
    localStorage.setItem(KEYS.saved, JSON.stringify(list.slice(0, 12)));
  } catch {
    /* ignore */
  }
}

export const loadRecent = (): Place[] => {
  try {
    const raw = localStorage.getItem(KEYS.recent);
    const parsed = raw ? (JSON.parse(raw) as Place[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
};

export function pushRecent(place: Place): Place[] {
  const list = [place, ...loadRecent().filter((p) => p.name !== place.name)].slice(0, 6);
  try {
    localStorage.setItem(KEYS.recent, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export function newId(): string {
  return `c_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
