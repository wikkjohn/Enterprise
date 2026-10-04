import { type ReactNode } from "react";
import { cn } from "../lib/cn";

/** Visually hidden data table: the non-visual (and non-hover) route to every value. */
export function ChartDataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) =>
              j === 0 ? (
                <th key={j} scope="row">
                  {c}
                </th>
              ) : (
                <td key={j}>{c}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChartTooltip({
  x,
  y,
  containerWidth,
  children,
}: {
  x: number;
  y: number;
  containerWidth: number;
  children: ReactNode;
}) {
  const flip = x > containerWidth * 0.6;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 min-w-28 rounded-md border border-border bg-surface-raised px-2.5 py-2 text-xs shadow-overlay",
        flip ? "-translate-x-full" : "",
      )}
      style={{ left: flip ? x - 12 : x + 12, top: Math.max(y - 12, 0) }}
    >
      {children}
    </div>
  );
}

export function LegendItem({ color, label, shape = "line" }: { color: string; label: ReactNode; shape?: "line" | "rect" }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span
        aria-hidden="true"
        className={cn("inline-block shrink-0", shape === "line" ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-[2px]")}
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
