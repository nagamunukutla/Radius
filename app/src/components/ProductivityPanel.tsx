import type { CommuteEvaluation, UserSettings } from "../lib/types";
import { humanDuration, money, round } from "../lib/util";

/**
 * Translates the index into the only units an IT employee's manager cares
 * about: focus hours, money, and what a shifted departure minute returns.
 */
export default function ProductivityPanel({ e, settings }: { e: CommuteEvaluation; settings: UserSettings }) {
  const p = e.productivity;
  const reclaimableCost = (p.reclaimableWeeklyHours * settings.hourlyRate) / 1;
  const perWeekFocusBlocks = round(p.reclaimableWeeklyHours / 1.5, 1);

  return (
    <div>
      <div className="stats">
        <div className="stat neg">
          <b>{humanDuration(p.weeklyWastedMinutes / 2)}</b>
          <span>wasted / week*</span>
        </div>
        <div className="stat neg">
          <b>{round(p.annualWastedHours, 0)} h</b>
          <span>per year</span>
        </div>
        <div className="stat neg">
          <b>{money(p.weeklyCost, settings.currency)}</b>
          <span>at {money(settings.hourlyRate, settings.currency)}/h</span>
        </div>
        <div className="stat good">
          <b>{round(p.reclaimableWeeklyHours, 1)} h</b>
          <span>reclaimable / week</span>
        </div>
        <div className="stat">
          <b>{round(p.co2KgWeekly, 1)} kg</b>
          <span>CO₂ / week</span>
        </div>
      </div>
      <p className="notes" style={{ marginTop: 12 }}>
        * Delay over free-flow plus the buffer you carry for reliability, per direction,
        across {settings.daysPerWeek} office days. Reclaimable time assumes you move your
        departure to the recommended minute{" "}
        {e.recommended ? `(${e.recommended.clock})` : "(no slot beats leaving now)"}.
        {perWeekFocusBlocks >= 1
          ? ` That is about ${perWeekFocusBlocks} uninterrupted deep-work blocks a week.`
          : ""}{" "}
        {reclaimableCost > 0 ? `At your rate, ${money(reclaimableCost, settings.currency)}/week stays in the sprint instead of the car.` : ""}
      </p>
      {e.cdi.advice.length > 0 && (
        <ul className="clean advice" style={{ marginTop: 12 }}>
          {e.cdi.advice.map((a, i) => (
            <li className="notes" key={i} style={{ display: "block", color: "var(--text)", fontSize: 13 }}>
              {a}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
