"use client";

import { type KeyboardEvent, useRef, useState } from "react";
import { barPath, formatCompact, formatNumber, niceTicks, useElementWidth } from "../lib/chart";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { ChartDataTable, ChartTooltip } from "./ChartParts";

export interface BarDatum {
  label: string;
  value: number;
}

export interface BarChartProps {
  data: BarDatum[];
  /** Accessible name, e.g. "Requests per module, last 30 days". */
  ariaLabel: string;
  height?: number;
  /** Formats tooltip values and the data table. Default: 1,234.5 */
  valueFormatter?: (value: number) => string;
  /** Formats y-axis ticks. Default: compact (1.2K). */
  tickFormatter?: (value: number) => string;
  /** Series name for the table header / tooltip. Default "Value". */
  valueLabel?: string;
  /** Override the bar color (a CSS color/var). Default chart slot 1 (accent). */
  color?: string;
  /** Label the maximum bar's value at its cap. Default true. */
  labelMax?: boolean;
  className?: string;
}

const M = { top: 16, right: 8, bottom: 28, left: 44 };

export function BarChart({
  data,
  ariaLabel,
  height = 240,
  valueFormatter = formatNumber,
  tickFormatter = formatCompact,
  valueLabel = "Value",
  color = "var(--color-chart-1)",
  labelMax = true,
  className,
}: BarChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const [active, setActive] = useState<number | null>(null);

  const values = data.map((d) => d.value);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const yMin = ticks[0] ?? 0;
  const yMax = ticks[ticks.length - 1] ?? 1;
  const innerW = Math.max(width - M.left - M.right, 10);
  const innerH = Math.max(height - M.top - M.bottom, 10);
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  const band = innerW / Math.max(data.length, 1);
  const barW = Math.max(Math.min(24, band - 2), 2);
  const y0 = y(0);
  const maxIndex = values.length ? values.indexOf(Math.max(...values)) : -1;

  // Thin x labels when crowded.
  const maxLabels = Math.max(Math.floor(innerW / 64), 1);
  const labelEvery = Math.ceil(data.length / maxLabels);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!data.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      setActive((prev) => (prev === null ? 0 : (prev + dir + data.length) % data.length));
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const activeDatum = active !== null ? data[active] : undefined;

  return (
    <figure className={cn("relative m-0 w-full", className)}>
      <div
        ref={wrapRef}
        tabIndex={data.length ? 0 : undefined}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className={cn("relative w-full rounded-md", focusRing)}
        aria-label={`${ariaLabel}. Use left and right arrow keys to inspect values.`}
        role="group"
      >
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {/* gridlines + y ticks */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + innerW}
                y1={y(t)}
                y2={y(t)}
                strokeWidth={1}
                style={{ stroke: t === 0 ? "var(--color-chart-axis)" : "var(--color-chart-grid)" }}
                shapeRendering="crispEdges"
              />
              <text
                x={M.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-subtle text-[11px] tabular-nums"
              >
                {tickFormatter(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = M.left + band * i + band / 2;
            const isActive = active === i;
            return (
              <g key={`${d.label}-${i}`}>
                {/* hit target: full band */}
                <rect
                  x={M.left + band * i}
                  y={M.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                />
                <path
                  d={barPath(cx - barW / 2, barW, y0, y(d.value))}
                  style={{ fill: color, opacity: active === null || isActive ? 1 : 0.55 }}
                  className="pointer-events-none transition-opacity motion-reduce:transition-none"
                />
                {labelMax && i === maxIndex && d.value > 0 && (
                  <text x={cx} y={y(d.value) - 6} textAnchor="middle" className="fill-muted text-[11px] font-medium tabular-nums">
                    {tickFormatter(d.value)}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text
                    x={cx}
                    y={M.top + innerH + 18}
                    textAnchor="middle"
                    className="pointer-events-none fill-subtle text-[11px]"
                  >
                    {d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {activeDatum && active !== null && (
          <ChartTooltip x={M.left + band * active + band / 2} y={y(Math.max(activeDatum.value, 0))} containerWidth={width}>
            <div className="text-sm font-semibold tabular-nums text-fg">{valueFormatter(activeDatum.value)}</div>
            <div className="text-muted">{activeDatum.label}</div>
          </ChartTooltip>
        )}
      </div>
      <div aria-live="polite" className="sr-only">
        {activeDatum ? `${activeDatum.label}: ${valueFormatter(activeDatum.value)}` : ""}
      </div>
      <ChartDataTable
        caption={ariaLabel}
        headers={["Category", valueLabel]}
        rows={data.map((d) => [d.label, valueFormatter(d.value)])}
      />
    </figure>
  );
}
