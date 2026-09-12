import type { CommuteEvaluation } from "../lib/types";
import type { CommuteMode } from "../lib/departure";
import { humanDuration, round } from "../lib/util";

/**
 * Modes side by side. This is the table that settles the argument the CDI
 * exists for: a slower door-to-door trip is not automatically a worse one,
 * because a metro reads a book while a car sits at 12 km/h.
 */
export default function ModeTable({ e, onPick }: { e: CommuteEvaluation; onPick: (m: CommuteMode) => void }) {
  const rows = e.comparison.filter((c) => c.minutes !== null);
  if (rows.length < 2) {
    return (
      <p className="notes">
        Only one mode is scoreable on this corridor — {e.comparison.find((c) => c.viable)?.label ?? "car"}. The rest
        are either too far to walk or have no stops, so comparing them would be theatre.
      </p>
    );
  }

  const fastest = rows.reduce((a, b) => ((b.minutes ?? 1e9) < (a.minutes ?? 1e9) ? b : a));
  const calmest = rows.reduce((a, b) => ((b.cdi ?? 1e9) < (a.cdi ?? 1e9) ? b : a));
  const cleanest = rows.reduce((a, b) => ((b.co2Kg ?? 1e9) < (a.co2Kg ?? 1e9) ? b : a));

  return (
    <div>
      <table className="slots">
        <thead>
          <tr>
            <th>Mode</th>
            <th>Door to door</th>
            <th>Buffer</th>
            <th>CDI</th>
            <th>CO₂ / trip</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const tags = [
              c.mode === e.primaryMode ? "scoring" : null,
              c.mode === fastest.mode ? "fastest" : null,
              c.mode === calmest.mode ? "least drag" : null,
              c.mode === cleanest.mode && c.mode !== "bike" ? "lowest CO₂" : null,
            ].filter(Boolean) as string[];
            return (
              <tr key={c.mode} className={c.mode === e.primaryMode ? "best" : undefined}>
                <td>{c.label}</td>
                <td>{humanDuration(c.minutes ?? 0)}</td>
                <td>+{round(c.bufferMinutes ?? 0, 0)} min</td>
                <td>{c.cdi ?? "—"}</td>
                <td>{round(c.co2Kg ?? 0, 2)} kg</td>
                <td style={{ textAlign: "right" }}>
                  {tags.length > 0 && (
                    <span className={c.mode === e.primaryMode ? "chip best" : "chip"}>{tags.join(" · ")}</span>
                  )}
                  {c.mode !== e.primaryMode && (
                    <button className="btn small ghost" type="button" onClick={() => onPick(c.mode)} style={{ marginLeft: 6 }}>
                      score it
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="notes" style={{ marginTop: 10 }}>
        Buffer is what you must carry to be on time 19 days in 20 — for transit that is mostly a missed connection,
        for a car it is the variance of a queue. Lowest door-to-door is not the same column as lowest index, and that
        gap is the entire reason this tool exists.
      </p>
    </div>
  );
}
