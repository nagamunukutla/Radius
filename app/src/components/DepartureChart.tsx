import { useMemo, useRef, useState } from "react";
import type { DepartureOption } from "../lib/types";
import { round } from "../lib/util";

/**
 * Departure-time curve: travel minutes and CDI for every candidate slot, with
 * the recommended minute marked. Hand-rolled SVG so the bundle has no chart
 * library and no CDN to half-load.
 */
export default function DepartureChart({
  options,
  recommended,
}: {
  options: DepartureOption[];
  recommended: DepartureOption | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const geometry = useMemo(() => {
    const w = 700;
    const h = 230;
    const pad = { l: 44, r: 44, t: 14, b: 26 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    if (options.length < 2) return null;
    const travel = options.map((o) => o.travelSeconds / 60);
    const maxT = Math.max(...travel) * 1.08;
    const minT = Math.min(...travel) * 0.9;
    const x = (i: number) => pad.l + (i / (options.length - 1)) * plotW;
    const yT = (v: number) => pad.t + plotH - ((v - minT) / Math.max(0.001, maxT - minT)) * plotH;
    const yC = (v: number) => pad.t + plotH - (v / 100) * plotH;
    const travelPath = travel.map((v, i) => `${i === 0 ? "M" : "L"}${round(x(i), 1)},${round(yT(v), 1)}`).join(" ");
    const cdiPath = options.map((o, i) => `${i === 0 ? "M" : "L"}${round(x(i), 1)},${round(yC(o.cdi), 1)}`).join(" ");
    const areaPath = `${cdiPath} L${round(x(options.length - 1), 1)},${pad.t + plotH} L${round(x(0), 1)},${pad.t + plotH} Z`;
    const bestIdx = recommended ? options.findIndex((o) => o.clock === recommended.clock) : -1;
    const worstTravel = travel.indexOf(Math.max(...travel));
    return { w, h, pad, plotW, plotH, x, yT, yC, travelPath, cdiPath, areaPath, bestIdx, worstTravel, maxT, minT };
  }, [options, recommended]);

  if (!geometry) {
    return <p className="notes">Not enough slots in the window to draw a curve — widen your work start in Settings.</p>;
  }
  const g = geometry;
  const idx = hover ?? (g.bestIdx >= 0 ? g.bestIdx : 0);
  const active = options[Math.min(Math.max(0, idx), options.length - 1)];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = ((e.clientX - rect.left) / rect.width) * g.w;
    const i = Math.round(((rel - g.pad.l) / g.plotW) * (options.length - 1));
    setHover(Math.min(options.length - 1, Math.max(0, i)));
  };

  const yTicks = 4;

  return (
    <div className="chart">
      <div className="chart-legend">
        <span><i style={{ background: "#38e1c0" }} /> travel minutes</span>
        <span><i style={{ background: "#ff9f68" }} /> Commute Drag Index</span>
        <span><i style={{ background: "rgba(255,107,104,0.25)" }} /> drag area</span>
        <span style={{ marginLeft: "auto" }}>
          {active.clock} · {round(active.travelSeconds / 60, 0)} min · CDI {active.cdi}
          {g.bestIdx >= 0 && active.clock === recommended?.clock ? " · best" : ""}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${g.w} ${g.h}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Departure time curve. Best departure ${recommended?.clock ?? "unknown"}.`}
      >
        {Array.from({ length: yTicks + 1 }, (_, k) => {
          const frac = k / yTicks;
          const y = g.pad.t + g.plotH - frac * g.plotH;
          const minutes = g.minT + frac * (g.maxT - g.minT);
          return (
            <g key={`y${k}`}>
              <line x1={g.pad.l} x2={g.w - g.pad.r} y1={y} y2={y} stroke="rgba(255,255,255,0.07)" />
              <text x={g.pad.l - 8} y={y + 3.5} textAnchor="end" fontSize="10" fill="#93a1bb">
                {Math.round(minutes)}m
              </text>
              <text x={g.w - g.pad.r + 8} y={y + 3.5} fontSize="10" fill="#93a1bb">
                {Math.round(frac * 100)}
              </text>
            </g>
          );
        })}

        <path d={g.areaPath} fill="rgba(255,159,104,0.13)" />
        <path d={g.cdiPath} fill="none" stroke="#ff9f68" strokeWidth={1.8} strokeDasharray="4 3" />
        <path d={g.travelPath} fill="none" stroke="#38e1c0" strokeWidth={2.6} strokeLinejoin="round" />

        {g.worstTravel >= 0 && (
          <g>
            <circle cx={g.x(g.worstTravel)} cy={g.yT(Math.max(...options.map((o) => o.travelSeconds / 60)))} r={4} fill="#ff6b68" />
            <text x={g.x(g.worstTravel)} y={g.yT(Math.max(...options.map((o) => o.travelSeconds / 60))) - 9} textAnchor="middle" fontSize="10" fill="#ff9f68">
              worst {options[g.worstTravel].clock}
            </text>
          </g>
        )}

        {g.bestIdx >= 0 && (
          <g>
            <line x1={g.x(g.bestIdx)} x2={g.x(g.bestIdx)} y1={g.pad.t} y2={g.pad.t + g.plotH} stroke="rgba(56,225,192,0.5)" strokeWidth={1.2} />
            <circle cx={g.x(g.bestIdx)} cy={g.yT(options[g.bestIdx].travelSeconds / 60)} r={5} fill="#38e1c0" stroke="#04231d" strokeWidth={1.5} />
            <text x={g.x(g.bestIdx)} y={g.pad.t + 8} textAnchor="middle" fontSize="10.5" fill="#38e1c0" fontWeight="700">
              leave {recommended?.clock}
            </text>
          </g>
        )}

        <line x1={g.x(idx)} x2={g.x(idx)} y1={g.pad.t} y2={g.pad.t + g.plotH} stroke="rgba(255,255,255,0.22)" />
        <circle cx={g.x(idx)} cy={g.yT(active.travelSeconds / 60)} r={3.4} fill="#eaf0fa" />

        {options.map((o, i) =>
          i % Math.ceil(options.length / 8) === 0 ? (
            <text key={`x${o.clock}`} x={g.x(i)} y={g.h - 8} textAnchor="middle" fontSize="10" fill="#93a1bb">
              {o.clock}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
