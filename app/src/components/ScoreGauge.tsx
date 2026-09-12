import type { CdiBand } from "../lib/types";
import { clamp } from "../lib/util";

/** Animated 0–100 arc gauge for the Commute Drag Index. */
export default function ScoreGauge({ score, band }: { score: number; band: CdiBand }) {
  const size = 190;
  const stroke = 15;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 135;
  const sweep = 270;
  const circumference = 2 * Math.PI * r;
  const arcLength = (sweep / 360) * circumference;
  const pct = clamp(score, 0, 100) / 100;

  const polar = (angleDeg: number) => {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const ticks = [0, 20, 40, 60, 80, 100].map((v) => {
    const [x, y] = polar(startAngle + (v / 100) * sweep);
    return { v, x, y };
  });

  return (
    <div className="gauge">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Commute Drag Index ${Math.round(score)} out of 100, ${band.label}`}>
        <defs>
          <linearGradient id="cdiGrad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#38e1c0" />
            <stop offset="45%" stopColor="#ffcf5c" />
            <stop offset="100%" stopColor="#ff6b68" />
          </linearGradient>
        </defs>
        <g transform={`rotate(${startAngle + 90} ${cx} ${cy})`}>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.09)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
            transform={`rotate(${-sweep / 2} ${cx} ${cy})`}
          />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="url(#cdiGrad)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLength * pct} ${circumference}`}
            transform={`rotate(${-sweep / 2} ${cx} ${cy})`}
            style={{ transition: "stroke-dasharray 0.75s cubic-bezier(0.22, 1, 0.36, 1)" }}
          />
        </g>
        {ticks.map((t) => (
          <circle key={t.v} cx={t.x} cy={t.y} r={1.6} fill="rgba(255,255,255,0.28)" />
        ))}
      </svg>
      <div className="gauge-value">
        {Math.round(score)}
        <small>COMMUTE DRAG INDEX</small>
      </div>
      <div style={{ textAlign: "center", marginTop: -6 }}>
        <span className="band-chip" style={{ background: `${band.color}22`, color: band.color, border: `1px solid ${band.color}55` }}>
          {band.label}
        </span>
      </div>
    </div>
  );
}
