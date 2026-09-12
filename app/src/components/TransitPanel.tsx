import type { ModeComparison, TransitPlan } from "../lib/types";
import { round } from "../lib/util";

const KIND_GLYPH: Record<TransitPlan["legs"][number]["kind"], string> = {
  walk: "🚶",
  wait: "⏱",
  ride: "🚇",
};

/** Minute-by-minute itinerary, plus an honest statement of what is modelled. */
export default function TransitPanel({ plan, comparison }: { plan: TransitPlan; comparison: ModeComparison[] }) {
  if (!plan.available) {
    return (
      <div className="transit-empty">
        <p className="notes">
          <strong>No usable transit corridor found for these two points.</strong> Radius looked for metro, commuter
          rail, tram and bus stops around both ends in OpenStreetMap and could not pair them inside your walking
          limit. That is a real answer, not an error: on this corridor a car is genuinely the only door-to-door
          option, and the index scores it as one.
        </p>
        <ul className="clean notes">
          {plan.notes.slice(0, 4).map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>
    );
  }

  const max = Math.max(...plan.legs.map((l) => l.minutes), 1);
  const drive = comparison.find((c) => c.mode === "drive");
  const delta = drive?.minutes ? plan.totalMinutes - drive.minutes : null;

  return (
    <div>
      <ol className="legs">
        {plan.legs.map((leg, i) => (
          <li key={i} className={`leg leg-${leg.kind}`}>
            <span className="leg-glyph" aria-hidden="true">
              {KIND_GLYPH[leg.kind]}
            </span>
            <div className="leg-body">
              <div className="leg-top">
                <span>{leg.label}</span>
                <b>{round(leg.minutes, 0)} min</b>
              </div>
              <div className="leg-bar">
                <i style={{ width: `${Math.max(3, (leg.minutes / max) * 100)}%` }} />
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="stats" style={{ marginTop: 12 }}>
        <div className="stat">
          <b>{round(plan.walkMinutes, 0)} min</b>
          <span>walking</span>
        </div>
        <div className="stat">
          <b>{round(plan.waitMinutes, 0)} min</b>
          <span>waiting</span>
        </div>
        <div className="stat">
          <b>{round(plan.rideMinutes, 0)} min</b>
          <span>on board</span>
        </div>
        <div className="stat">
          <b>{plan.transfers}</b>
          <span>change{plan.transfers === 1 ? "" : "s"}</span>
        </div>
        <div className={`stat ${delta !== null && delta < 0 ? "good" : "neg"}`}>
          <b>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${Math.round(delta)} min`}</b>
          <span>vs driving</span>
        </div>
      </div>
      <p className="notes" style={{ marginTop: 12 }}>
        {round(plan.exposureFraction * 100, 0)}% of this journey happens outdoors, which is why rain moves your index
        more than it moves a driver’s. Stops come from OpenStreetMap; speeds, dwell and headways are modelled per mode,
        so treat the minutes as ±10% and the *comparison* as the point.
      </p>
      <ul className="clean notes">
        {plan.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
