"use client";

import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { formatCompact, formatNumber, niceTicks, seriesColor, useElementWidth } from "../lib/chart";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { ChartDataTable, ChartTooltip, LegendItem } from "./ChartParts";

export interface LinePoint {
  /** Category / time label (pre-formatted, e.g. "Mar 4"). Points align by index across series. */
  x: string;
  y: number | null;
}

export interface LineSeries {
  id: string;
  label: string;
  data: LinePoint[];
  /** Override color; default is the fixed categorical slot for the series' index. */
  color?: string;
}

export interface LineChartProps {
  /** One or more series (max 5 colors; extra series fall back to neutral — fold them into "Other"). */
  series: LineSeries[];
  ariaLabel: string;
  height?: number;
  valueFormatter?: (value: number) => string;
  tickFormatter?: (value: number) => string;
  /** Soft area wash under a single series. */
  area?: boolean;
  /** Force y-axis to include 0. Default true. */
  zeroBaseline?: boolean;
  /** Show legend. Default: when there are 2+ series. */
  showLegend?: boolean;
  className?: string;
}

const M = { top: 12, right: 12, bottom: 28, left: 44 };

export function LineChart({
  series,
  ariaLabel,
  height = 240,
  valueFormatter = formatNumber,
  tickFormatter = formatCompact,
  area = false,
  zeroBaseline = true,
  showLegend,
  className,
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const [active, setActive] = useState<number | null>(null);

  const xLabels = series.reduce<string[]>((acc, s) => (s.data.length > acc.length ? s.data.map((p) => p.x) : acc), []);
  const n = xLabels.length;
  const allY = series.flatMap((s) => s.data.map((p) => p.y)).filter((v): v is number => v !== null && Number.isFinite(v));
  const dataMin = allY.length ? Math.min(...allY) : 0;
  const dataMax = allY.length ? Math.max(...allY) : 1;
  const ticks = niceTicks(zeroBaseline ? Math.min(0, dataMin) : dataMin, zeroBaseline ? Math.max(0, dataMax) : dataMax);
  const yMin = ticks[0] ?? 0;
  const yMax = ticks[ticks.length - 1] ?? 1;

  const innerW = Math.max(width - M.left - M.right, 10);
  const innerH = Math.max(height - M.top - M.bottom, 10);
  const x = (i: number) => M.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const colorOf = (s: LineSeries, i: number) => s.color ?? seriesColor(i);

  const pathFor = (s: LineSeries) => {
    let d = "";
    let pen = false;
    s.data.forEach((p, i) => {
      if (p.y === null || !Number.isFinite(p.y)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i)},${y(p.y)}`;
      pen = true;
    });
    return d;
  };

  const areaFor = (s: LineSeries) => {
    const pts = s.data.map((p, i) => (p.y === null ? null : ([x(i), y(p.y)] as const))).filter((p) => p !== null);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return "";
    const base = y(Math.max(yMin, 0));
    return `M${first[0]},${base}${pts.map(([px, py]) => `L${px},${py}`).join("")}L${last[0]},${base}Z`;
  };

  const maxLabels = Math.max(Math.floor(innerW / 72), 2);
  const labelEvery = Math.max(Math.ceil(n / maxLabels), 1);
  const labelIdx: number[] = [];
  for (let i = 0; i < n; i += labelEvery) labelIdx.push(i);
  if (n > 1 && labelIdx[labelIdx.length - 1] !== n - 1) {
    // Always label the last point; drop the previous label if it would collide.
    if (n - 1 - (labelIdx[labelIdx.length - 1] ?? 0) < labelEvery / 2 + 1) labelIdx.pop();
    labelIdx.push(n - 1);
  }

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / (rect.width || 1);
    setActive(Math.min(Math.max(Math.round(rel * (n - 1)), 0), n - 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      setActive((prev) => (prev === null ? n - 1 : Math.min(Math.max(prev + dir, 0), n - 1)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const legend = showLegend ?? series.length > 1;
  const activeLabel = active !== null ? xLabels[active] : undefined;
  const readout =
    active !== null
      ? series.map((s, i) => ({ s, i, v: s.data[active]?.y ?? null }))
      : [];

  return (
    <figure className={cn("m-0 flex w-full flex-col gap-3", className)}>
      {legend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1" aria-hidden="true">
          {series.map((s, i) => (
            <LegendItem key={s.id} color={colorOf(s, i)} label={s.label} />
          ))}
        </div>
      )}
      <div
        ref={wrapRef}
        tabIndex={n ? 0 : undefined}
        role="group"
        aria-label={`${ariaLabel}. Use left and right arrow keys to inspect values.`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        className={cn("relative w-full rounded-md", focusRing)}
      >
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + innerW}
                y1={y(t)}
                y2={y(t)}
                strokeWidth={1}
                shapeRendering="crispEdges"
                style={{ stroke: t === yMin ? "var(--color-chart-axis)" : "var(--color-chart-grid)" }}
              />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-subtle text-[11px] tabular-nums">
                {tickFormatter(t)}
              </text>
            </g>
          ))}
          {labelIdx.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={M.top + innerH + 18}
              textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"}
              className="fill-subtle text-[11px]"
            >
              {xLabels[i]}
            </text>
          ))}
          {area &&
            series.length === 1 &&
            series[0] && <path d={areaFor(series[0])} style={{ fill: colorOf(series[0], 0), opacity: 0.1 }} />}
          {series.map((s, i) => (
            <path
              key={s.id}
              d={pathFor(s)}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ stroke: colorOf(s, i) }}
            />
          ))}
          {/* end dots with surface ring */}
          {active === null &&
            series.map((s, i) => {
              const lastIdx = s.data.length - 1;
              const p = s.data[lastIdx];
              if (!p || p.y === null) return null;
              return (
                <circle
                  key={s.id}
                  cx={x(lastIdx)}
                  cy={y(p.y)}
                  r={4}
                  strokeWidth={2}
                  style={{ fill: colorOf(s, i), stroke: "var(--color-surface)" }}
                />
              );
            })}
          {active !== null && (
            <g className="pointer-events-none">
              <line
                x1={x(active)}
                x2={x(active)}
                y1={M.top}
                y2={M.top + innerH}
                strokeWidth={1}
                shapeRendering="crispEdges"
                style={{ stroke: "var(--color-border-strong)" }}
              />
              {readout.map(({ s, i, v }) =>
                v === null ? null : (
                  <circle
                    key={s.id}
                    cx={x(active)}
                    cy={y(v)}
                    r={4}
                    strokeWidth={2}
                    style={{ fill: colorOf(s, i), stroke: "var(--color-surface)" }}
                  />
                ),
              )}
            </g>
          )}
          <rect
            x={M.left}
            y={M.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {active !== null && (
          <ChartTooltip x={x(active)} y={M.top} containerWidth={width}>
            <div className="mb-1 text-muted">{activeLabel}</div>
            <div className="flex flex-col gap-0.5">
              {readout.map(({ s, i, v }) => (
                <div key={s.id} className="flex items-center gap-2">
                  <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: colorOf(s, i) }} />
                  <span className="font-semibold tabular-nums text-fg">{v === null ? "—" : valueFormatter(v)}</span>
                  {series.length > 1 && <span className="truncate text-muted">{s.label}</span>}
                </div>
              ))}
            </div>
          </ChartTooltip>
        )}
      </div>
      <div aria-live="polite" className="sr-only">
        {activeLabel !== undefined
          ? `${activeLabel}: ${readout.map(({ s, v }) => `${s.label} ${v === null ? "no data" : valueFormatter(v)}`).join(", ")}`
          : ""}
      </div>
      <ChartDataTable
        caption={ariaLabel}
        headers={["Period", ...series.map((s) => s.label)]}
        rows={xLabels.map((lbl, idx) => [
          lbl,
          ...series.map((s) => {
            const v = s.data[idx]?.y;
            return v === null || v === undefined ? "—" : valueFormatter(v);
          }),
        ])}
      />
    </figure>
  );
}
