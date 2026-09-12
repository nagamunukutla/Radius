import { useMemo, useRef, useState } from "react";
import type { DepartureOption } from "../lib/types";
import { round } from "../lib/util";

interface Props {
  options: DepartureOption[];
  recommended: DepartureOption | null;
  leaveNow: DepartureOption | null;
  latestSafeClock: string | null;
  earliestSaneClock: string | null;
  workStartMinutes: number;
  riskBudget: number;
}

/**
 * Departure curve with the decision marked on it: the recommended minute, the
 * hard deadline, the region where you arrive late, and where "now" sits.
 * Hand-rolled SVG so the bundle carries no chart library and no CDN.
 */
export default function DepartureChart({
  options,
  recommended,
  leaveNow,
  latestSafeClock,
  earliestSaneClock,
  workStartMinutes,
  riskBudget,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const geometry = useMemo(() => {
    const w = 720;
    const h = 240;
    const pad = { l: 42, r: 42, t: 22, b: 26 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    if (options.length < 2) return null;
    const travel = options.map((o) => o.travelSeconds / 60);
    const maxT = Math.max(...travel) * 1.06;
    const minT = Math.min(...travel) * 0.94;
    const x = (i: number) => pad.l + (i / (options.length - 1)) * plotW;
    const yT = (v: number) => pad.t + plotH - ((v - minT) / Math.max(0.001, maxT - minT)) * plotH;
    const yC = (v: number) => pad.t + plotH - (v / 100) * plotH;
    const travelPath = travel.map((v, i) => `${i === 0 ? "M" : "L"}${round(x(i), 1)},${round(yT(v), 1)}`).join(" ");
    const cdiPath = options.map((o, i) => `${i === 0 ? "M" : "L"}${round(x(i), 1)},${round(yC(o.cdi), 1)}`).join(" ");
    const areaPath = `${cdiPath} L${round(x(options.length - 1), 1)},${pad.t + plotH} L${round(x(0), 1)},${pad.t + plotH} Z`;

    const idxOf = (clock: string | null) => (clock ? options.findIndex((o) => o.clock === clock) : -1);
    const lateStart = options.findIndex((o) => o.lateMinutes > 0.5);
    const riskyStart = options.findIndex((o) => o.onTimeRisk > riskBudget);
    const firstPast = riskyStart >= 0 ? riskyStart : lateStart;

    return {
      w,
      h,
      pad,
      plotW,
      plotH,
      x,
      yT,
      yC,
      travelPath,
      cdiPath,
      areaPath,
      bestIdx: idxOf(recommended?.clock ?? null),
      deadlineIdx: idxOf(latestSafeClock),
      firstSaneIdx: idxOf(earliestSaneClock),
      nowIdx: idxOf(leaveNow?.clock ?? null),
      worstIdx: travel.indexOf(Math.max(...travel)),
      lateIdx: firstPast,
      maxT,
      minT,
    };
  }, [options, recommended, latestSafeClock, earliestSaneClock, leaveNow, riskBudget]);

  if (!geometry) {
    return (
      <p className="notes">
        Not enough candidate minutes to draw a curve. Widen your “never leave before” time or move your start later in
        Settings — the planner refuses to plot a day you would not live.
      </p>
    );
  }

  const g = geometry;
  const idx = Math.min(Math.max(0, hover ?? (g.bestIdx >= 0 ? g.bestIdx : 0)), options.length - 1);
  const active = options[idx];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = ((e.clientX - rect.left) / rect.width) * g.w;
    const i = Math.round(((rel - g.pad.l) / g.plotW) * (options.length - 1));
    setHover(Math.min(options.length - 1, Math.max(0, i)));
  };

  return (
    <div className="chart">
      <div className="chart-legend">
        <span>
          <i style={{ background: "#38e1c0" }} /> travel minutes
        </span>
        <span>
          <i style={{ background: "#ff9f68" }} /> drag index
        </span>
        <span>
          <i style={{ background: "rgba(255,107,104,0.5)" }} /> late / risky
        </span>
        <span style={{ marginLeft: "auto" }}>
          {active.clock} · {round(active.travelSeconds / 60, 0)} min · CDI {active.cdi} ·{" "}
          {active.lateMinutes > 0.5
            ? `${Math.round(active.lateMinutes)} min late`
            : active.earlyMinutes > 0.5
              ? `${Math.round(active.earlyMinutes)} min early`
              : "lands on your start"}{" "}
          · {Math.round(active.onTimeRisk * 100)}% risk
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${g.w} ${g.h}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Departure curve. Recommended ${recommended?.clock ?? "none"}. Deadline ${latestSafeClock ?? "none"}.`}
      >
        {g.lateIdx > 0 && (
          <rect
            x={g.x(g.lateIdx)}
            y={g.pad.t}
            width={Math.max(0, g.w - g.pad.r - g.x(g.lateIdx))}
            height={g.plotH}
            fill="rgba(255,107,104,0.10)"
          />
        )}

        {Array.from({ length: 5 }, (_, k) => {
          const frac = k / 4;
          const y = g.pad.t + g.plotH - frac * g.plotH;
          const minutes = g.minT + frac * (g.maxT - g.minT);
          return (
            <g key={`y${k}`}>
              <line x1={g.pad.l} x2={g.w - g.pad.r} y1={y} y2={y} stroke="rgba(255,255,255,0.07)" />
              <text x={g.pad.l - 7} y={y + 3.5} textAnchor="end" fontSize="10" fill="#93a1bb">
                {Math.round(minutes)}m
              </text>
              <text x={g.w - g.pad.r + 7} y={y + 3.5} fontSize="10" fill="#93a1bb">
                {Math.round(frac * 100)}
              </text>
            </g>
          );
        })}

        <path d={g.areaPath} fill="rgba(255,159,104,0.12)" />
        <path d={g.cdiPath} fill="none" stroke="#ff9f68" strokeWidth={1.8} strokeDasharray="4 3" />
        <path d={g.travelPath} fill="none" stroke="#38e1c0" strokeWidth={2.6} strokeLinejoin="round" />

        {g.nowIdx >= 0 && (
          <g>
            <line x1={g.x(g.nowIdx)} x2={g.x(g.nowIdx)} y1={g.pad.t} y2={g.pad.t + g.plotH} stroke="rgba(234,240,250,0.34)" strokeDasharray="2 3" />
            <text x={g.x(g.nowIdx)} y={g.h - 8} textAnchor="middle" fontSize="9.5" fill="#93a1bb">
              now
            </text>
          </g>
        )}

        {g.firstSaneIdx >= 0 && g.firstSaneIdx !== g.bestIdx && (
          <text x={g.x(g.firstSaneIdx)} y={g.pad.t - 8} textAnchor="start" fontSize="9.5" fill="#5f6d86">
            no need to leave before {options[g.firstSaneIdx].clock}
          </text>
        )}

        {g.deadlineIdx >= 0 && (
          <g>
            <line x1={g.x(g.deadlineIdx)} x2={g.x(g.deadlineIdx)} y1={g.pad.t - 4} y2={g.pad.t + g.plotH} stroke="#ffcf5c" strokeWidth={1.4} strokeDasharray="5 3" />
            <circle cx={g.x(g.deadlineIdx)} cy={g.pad.t - 4} r={2.6} fill="#ffcf5c" />
            <text x={g.x(g.deadlineIdx)} y={g.pad.t + g.plotH + 30} textAnchor="end" fontSize="10" fill="#ffcf5c" fontWeight="700">
              leave no later than {options[g.deadlineIdx].clock}
            </text>
          </g>
        )}

        {g.worstIdx >= 0 && g.worstIdx !== g.bestIdx && (
          <g>
            <circle cx={g.x(g.worstIdx)} cy={g.yT(options[g.worstIdx].travelSeconds / 60)} r={3.6} fill="#ff6b68" />
            <text x={g.x(g.worstIdx)} y={g.yT(options[g.worstIdx].travelSeconds / 60) - 8} textAnchor="middle" fontSize="9.5" fill="#ff9f68">
              worst {options[g.worstIdx].clock}
            </text>
          </g>
        )}

        {g.bestIdx >= 0 && (
          <g>
            <line x1={g.x(g.bestIdx)} x2={g.x(g.bestIdx)} y1={g.pad.t} y2={g.pad.t + g.plotH} stroke="rgba(56,225,192,0.55)" strokeWidth={1.3} />
            <circle cx={g.x(g.bestIdx)} cy={g.yT(options[g.bestIdx].travelSeconds / 60)} r={5} fill="#38e1c0" stroke="#04231d" strokeWidth={1.5} />
            <text x={g.x(g.bestIdx)} y={g.pad.t - 8} textAnchor="middle" fontSize="11" fill="#38e1c0" fontWeight="700">
              leave {recommended?.clock}
            </text>
          </g>
        )}

        <line x1={g.x(idx)} x2={g.x(idx)} y1={g.pad.t} y2={g.pad.t + g.plotH} stroke="rgba(255,255,255,0.2)" />
        <circle cx={g.x(idx)} cy={g.yT(active.travelSeconds / 60)} r={3.4} fill="#eaf0fa" />

        {options.map((o, i) =>
          i % Math.max(1, Math.ceil(options.length / 8)) === 0 ? (
            <text key={`x${o.clock}`} x={g.x(i)} y={g.pad.t + g.plotH + 14} textAnchor="middle" fontSize="10" fill="#93a1bb">
              {o.clock}
            </text>
          ) : null,
        )}
      </svg>
      {workStartMinutes > 0 && (
        <p className="notes" style={{ marginTop: 6 }}>
          Shaded region: minutes that put you past your {String(Math.floor(workStartMinutes / 60)).padStart(2, "0")}:
          {String(workStartMinutes % 60).padStart(2, "0")} start or above your{" "}
          {Math.round(riskBudget * 100)}% lateness budget. The planner will not recommend a minute inside it — which
          is why the curve is allowed to look flat and boring on the left.
        </p>
      )}
    </div>
  );
}
