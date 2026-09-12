import { PLAN_STYLES } from "../lib/departure";
import type { UserSettings } from "../lib/types";
import { minutesToClock } from "../lib/util";

interface Props {
  settings: UserSettings;
  onChange: (patch: Partial<UserSettings>) => void;
}

const CURRENCIES = ["EUR", "USD", "GBP", "INR"];

/** Everything the model needs about the human, editable in place. */
export default function SettingsPanel({ settings, onChange }: Props) {
  return (
    <div>
      <div className="setting wide">
        <label htmlFor="s-style">When should I tell you to leave?</label>
        <select
          id="s-style"
          value={settings.planStyle}
          onChange={(e) => onChange({ planStyle: e.target.value as UserSettings["planStyle"] })}
        >
          {PLAN_STYLES.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="hint" style={{ marginLeft: 0, marginTop: 4 }}>
          {PLAN_STYLES.find((p) => p.key === settings.planStyle)?.blurb}
        </p>
      </div>
      <div className="setting">
        <label htmlFor="s-earliest">Never leave before</label>
        <input
          id="s-earliest"
          type="time"
          value={minutesToClock(settings.earliestDepartureMinutes)}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) onChange({ earliestDepartureMinutes: h * 60 + m });
          }}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-early">Idle at the office past</label>
        <select
          id="s-early"
          value={settings.maxEarlyArrivalMinutes}
          onChange={(e) => onChange({ maxEarlyArrivalMinutes: Number(e.target.value) })}
        >
          {[0, 5, 12, 25, 45].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "0 min (I count it all)" : `${m} min free`}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <label htmlFor="s-risk">Lateness I accept</label>
        <select
          id="s-risk"
          value={settings.lateRiskBudget}
          onChange={(e) => onChange({ lateRiskBudget: Number(e.target.value) })}
        >
          {[0.02, 0.05, 0.1, 0.2].map((r) => (
            <option key={r} value={r}>
              ~1 day in {Math.max(2, Math.round(1 / r))}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <label htmlFor="s-walk">Max walk to transit</label>
        <input
          id="s-walk"
          type="number"
          min={4}
          max={25}
          value={settings.transitMaxWalkMinutes}
          onChange={(e) => onChange({ transitMaxWalkMinutes: clampNum(e.target.value, 4, 25, 12) })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-work">Work start</label>
        <input
          id="s-work"
          type="time"
          value={minutesToClock(settings.workStartMinutes)}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) onChange({ workStartMinutes: h * 60 + m });
          }}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-days">Office days / week</label>
        <input
          id="s-days"
          type="number"
          min={0}
          max={7}
          value={settings.daysPerWeek}
          onChange={(e) => onChange({ daysPerWeek: clampNum(e.target.value, 0, 7, 5) })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-rate">Billable rate / h</label>
        <input
          id="s-rate"
          type="number"
          min={0}
          step={5}
          value={settings.hourlyRate}
          onChange={(e) => onChange({ hourlyRate: clampNum(e.target.value, 0, 2000, 45) })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-cur">Currency</label>
        <select id="s-cur" value={settings.currency} onChange={(e) => onChange({ currency: e.target.value })}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <label htmlFor="s-refresh">Auto-refresh</label>
        <select id="s-refresh" value={settings.refreshSeconds} onChange={(e) => onChange({ refreshSeconds: Number(e.target.value) })}>
          {[0, 30, 60, 300, 900].map((s) => (
            <option key={s} value={s}>
              {s === 0 ? "off" : `${s}s`}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <label htmlFor="s-co2">CO₂ g / km</label>
        <input
          id="s-co2"
          type="number"
          min={0}
          step={10}
          value={Math.round(settings.vehicleCO2PerKm * 1000)}
          onChange={(e) => onChange({ vehicleCO2PerKm: clampNum(e.target.value, 0, 600, 171) / 1000 })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-sev">City congestion 0.6–1.5</label>
        <input
          id="s-sev"
          type="range"
          min={0.6}
          max={1.5}
          step={0.05}
          value={settings.citySeverity}
          onChange={(e) => onChange({ citySeverity: Number(e.target.value) })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-am">AM peak</label>
        <input
          id="s-am"
          type="range"
          min={5}
          max={12}
          step={0.25}
          value={settings.peakAm}
          onChange={(e) => onChange({ peakAm: Number(e.target.value) })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-pm">PM peak</label>
        <input
          id="s-pm"
          type="range"
          min={14}
          max={22}
          step={0.25}
          value={settings.peakPm}
          onChange={(e) => onChange({ peakPm: Number(e.target.value) })}
        />
      </div>
      <div className="setting">
        <label htmlFor="s-prov">Traffic source</label>
        <select
          id="s-prov"
          value={settings.trafficProvider}
          onChange={(e) => onChange({ trafficProvider: e.target.value as UserSettings["trafficProvider"] })}
        >
          <option value="model">Radius demand model</option>
          <option value="tomtom">TomTom live traffic</option>
        </select>
      </div>
      {settings.trafficProvider === "tomtom" && (
        <div className="setting wide">
          <label htmlFor="s-key">
            TomTom API key <span className="hint">stored only in this browser</span>
          </label>
          <input
            id="s-key"
            type="password"
            placeholder="paste key to enable live flow data"
            value={settings.tomtomKey}
            onChange={(e) => onChange({ tomtomKey: e.target.value.trim() })}
          />
        </div>
      )}
    </div>
  );
}

function clampNum(raw: string, lo: number, hi: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
