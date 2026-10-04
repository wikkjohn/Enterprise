import { cn } from "../lib/cn";

export interface SparklineProps {
  data: number[];
  /** Accessible description, e.g. "Requests, last 12 weeks, trending up". Omit to mark decorative. */
  ariaLabel?: string;
  width?: number;
  height?: number;
  /** Stroke color (CSS color/var). Default chart slot 1 (accent). */
  color?: string;
  /** Soft area wash under the line. */
  area?: boolean;
  className?: string;
}

export function Sparkline({
  data,
  ariaLabel,
  width = 96,
  height = 28,
  color = "var(--color-chart-1)",
  area = false,
  className,
}: SparklineProps) {
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const px = pad + (data.length <= 1 ? (width - pad * 2) / 2 : (i / (data.length - 1)) * (width - pad * 2));
    const py = pad + (height - pad * 2) - ((v - min) / span) * (height - pad * 2);
    return [px, py] as const;
  });
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
  const last = pts[pts.length - 1];
  const first = pts[0];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn("block shrink-0 overflow-visible", className)}
    >
      {ariaLabel && <title>{ariaLabel}</title>}
      {area && first && last && (
        <path
          d={`${line}L${last[0]},${height - pad}L${first[0]},${height - pad}Z`}
          style={{ fill: color, opacity: 0.1 }}
        />
      )}
      {data.length > 0 && (
        <path d={line} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: color }} />
      )}
      {last && <circle cx={last[0]} cy={last[1]} r={2.5} style={{ fill: color }} />}
    </svg>
  );
}
