import type { ModeComparison, UserSettings } from "../lib/types";
import { humanDuration } from "../lib/util";

interface Props {
  value: UserSettings["commuteMode"];
  onChange: (mode: UserSettings["commuteMode"]) => void;
  comparison: ModeComparison[];
}

const MODES: Array<{ key: UserSettings["commuteMode"]; label: string; glyph: string }> = [
  { key: "drive", label: "Car", glyph: "🚗" },
  { key: "transit", label: "Metro / bus", glyph: "🚇" },
  { key: "bike", label: "Bike", glyph: "🚲" },
  { key: "walk", label: "Walk", glyph: "🚶" },
];

/**
 * The whole index is re-scored per mode, so the switch is not a filter on a
 * driving answer — it changes what the trip physically is.
 */
export default function ModePicker({ value, onChange, comparison }: Props) {
  return (
    <div className="modebar" role="radiogroup" aria-label="How you get to work">
      {MODES.map((m) => {
        const hit = comparison.find((c) => c.mode === m.key);
        const unavailable = m.key === "transit" && hit && !hit.viable;
        return (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={value === m.key}
            className={`mode ${value === m.key ? "on" : ""} ${unavailable ? "off" : ""}`}
            onClick={() => onChange(m.key)}
            title={
              unavailable
                ? "No metro, tram, rail or bus stop pair was found for this corridor — Radius scored the drive instead — the transit card says what it looked for."
                : `Score the index for ${m.label.toLowerCase()}`
            }
          >
            <span className="glyph" aria-hidden="true">
              {m.glyph}
            </span>
            <span className="mode-name">{m.label}</span>
            <span className="mode-time">
              {hit?.viable && hit.minutes !== null ? humanDuration(hit.minutes) : unavailable ? "no corridor found" : "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
