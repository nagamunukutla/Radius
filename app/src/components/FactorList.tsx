import type { CdiFactor } from "../lib/types";
import { clamp } from "../lib/util";

function colorFor(score: number): string {
  if (score < 25) return "#38e1c0";
  if (score < 45) return "#9ad86b";
  if (score < 65) return "#ffcf5c";
  if (score < 82) return "#ff9f68";
  return "#ff6b68";
}

/** Every factor, its weight, and the numbers that produced it. */
export default function FactorList({ factors }: { factors: CdiFactor[] }) {
  const sorted = [...factors].sort((a, b) => b.score * b.weight - a.score * a.weight);
  return (
    <div>
      {sorted.map((f) => (
        <div className="factor" key={f.key}>
          <div className="factor-top">
            <strong>{f.label}</strong>
            <span className="w">{Math.round(f.weight * 100)}% of index</span>
            <span className="score" style={{ color: colorFor(f.score) }}>
              {f.score}/100
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${clamp(f.score, 2, 100)}%`, background: colorFor(f.score) }} />
          </div>
          <p>{f.detail}</p>
        </div>
      ))}
    </div>
  );
}
