"use client";

import { type RefObject, useEffect, useState } from "react";

/** Fixed categorical order (validated for CVD separation in light + dark). Never cycled. */
export const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
] as const;

export const MAX_SERIES = CHART_COLORS.length;

export function seriesColor(index: number): string {
  return CHART_COLORS[index] ?? "var(--color-subtle)";
}

const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export const formatCompact = (n: number): string => compactFmt.format(n);
export const formatNumber = (n: number): string => fullFmt.format(n);

/** "Nice" axis ticks from 0 (or a negative min) to max. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    max = min === 0 ? 1 : min > 0 ? min * 2 : 0;
    if (min > 0) min = 0;
  }
  const span = max - min;
  const raw = span / Math.max(count, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** Track an element's content width (for responsive SVG without distorting text). */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 600): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return width;
}

/** Path for a vertical bar with 4px rounded data-end and square baseline. */
export function barPath(x: number, w: number, yBase: number, yEnd: number, r = 4): string {
  const h = Math.abs(yBase - yEnd);
  const rr = Math.min(r, w / 2, h);
  if (h === 0) return "";
  if (yEnd < yBase) {
    // Positive bar: rounded top.
    return `M${x},${yBase}V${yEnd + rr}Q${x},${yEnd} ${x + rr},${yEnd}H${x + w - rr}Q${x + w},${yEnd} ${x + w},${yEnd + rr}V${yBase}Z`;
  }
  // Negative bar: rounded bottom.
  return `M${x},${yBase}V${yEnd - rr}Q${x},${yEnd} ${x + rr},${yEnd}H${x + w - rr}Q${x + w},${yEnd} ${x + w},${yEnd - rr}V${yBase}Z`;
}
