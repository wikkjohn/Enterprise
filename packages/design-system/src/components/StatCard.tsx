import { type ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "../lib/cn";
import { Sparkline } from "./Sparkline";

export interface StatDelta {
  /** Pre-formatted, signed, e.g. "+12.4%" or "−3". */
  value: string;
  direction: "up" | "down" | "flat";
  /** Whether "up" is good (default) — controls tone. */
  upIsGood?: boolean;
  /** Comparison period, e.g. "vs last week". */
  period?: string;
}

export interface StatCardProps {
  /** Sentence case, no trailing colon. */
  label: ReactNode;
  /** Pre-formatted value (e.g. "12.9K", "$4.2M"). */
  value: ReactNode;
  delta?: StatDelta;
  hint?: ReactNode;
  /** Trend points for an inline sparkline. */
  trend?: number[];
  trendLabel?: string;
  /** Optional icon shown next to the label. */
  icon?: ReactNode;
  className?: string;
}

export function StatCard({ label, value, delta, hint, trend, trendLabel, icon, className }: StatCardProps) {
  let tone = "text-muted";
  if (delta && delta.direction !== "flat") {
    const good = (delta.direction === "up") === (delta.upIsGood ?? true);
    tone = good ? "text-success" : "text-danger";
  }
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : ArrowRight;
  const dirWord = delta?.direction === "up" ? "Increased" : delta?.direction === "down" ? "Decreased" : "Unchanged";

  return (
    <div className={cn("flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4", className)}>
      <div className="flex items-center gap-2 text-sm text-muted [&_svg]:size-4">
        {icon && <span aria-hidden="true">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-2xl font-semibold tracking-tight text-fg">{value}</div>
          {delta && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs">
              <span className={cn("inline-flex items-center gap-0.5 font-medium", tone)}>
                <DeltaIcon aria-hidden="true" className="size-3.5" />
                <span className="sr-only">{dirWord} </span>
                {delta.value}
              </span>
              {delta.period && <span className="text-subtle">{delta.period}</span>}
            </div>
          )}
        </div>
        {trend && trend.length > 1 && <Sparkline data={trend} ariaLabel={trendLabel} className="mb-1" />}
      </div>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
