"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Badge, Tabs, cn, type Tone } from "@eaop/design-system";
import { renderLink } from "@/components/link";

export const WI = "/m/workflow-intelligence";
export const WI_API = "/m/workflow-intelligence";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

// Compact only from 1,000 up, with explicit fraction digits: server (Node ICU) and browser ICU must render identical text or hydration fails.
export const fmtUsd = (v: number | null | undefined, compact = false) => (v == null ? "—" : (compact && Math.abs(v) >= 1000 ? compactUsd : usd).format(v));
/** Y-axis ticks for count charts: whole numbers only. */
export const countTick = (v: number) => (Number.isInteger(v) ? String(v) : "");
export const fmtNum = (v: number | null | undefined) => (v == null ? "—" : num.format(v));
export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${num.format(v)}%`);
export const fmtMonths = (v: number | null | undefined) => (v == null ? "—" : `${num.format(v)} mo`);
export function fmtUnit(v: number | null | undefined, unit: string) {
  if (unit === "usd" || unit === "usd_per_year") return `${fmtUsd(v)}${unit === "usd_per_year" && v != null ? "/yr" : ""}`;
  if (unit === "pct") return fmtPct(v);
  if (unit === "months") return fmtMonths(v);
  if (unit === "hours") return v == null ? "—" : `${fmtNum(v)} h`;
  return fmtNum(v);
}

const PROVENANCE: Record<string, { label: string; tone: Tone; title: string }> = {
  fact: { label: "FACT", tone: "success", title: "Measured or documented fact" },
  assumption: { label: "ASSUMPTION", tone: "warning", title: "Assumption — editable, review before relying on it" },
  ai_estimate: { label: "AI ESTIMATE", tone: "info", title: "Estimated by an AI model — verify before relying on it" },
};

export function ProvenanceBadge({ value, className }: { value: string; className?: string }) {
  const p = PROVENANCE[value] ?? { label: value.toUpperCase(), tone: "neutral" as Tone, title: value };
  return (
    <Badge tone={p.tone} className={className} title={p.title}>
      {p.label}
    </Badge>
  );
}

export const PROVENANCE_OPTIONS = [
  { value: "fact", label: "Fact" },
  { value: "assumption", label: "Assumption" },
  { value: "ai_estimate", label: "AI estimate" },
];

export const QUADRANT: Record<string, { label: string; tone: Tone }> = {
  quick_win: { label: "Quick win", tone: "success" },
  strategic_bet: { label: "Strategic bet", tone: "accent" },
  fill_in: { label: "Fill-in", tone: "neutral" },
  deprioritize: { label: "Deprioritize", tone: "warning" },
};

export function QuadrantBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-subtle">—</span>;
  const q = QUADRANT[value] ?? { label: value, tone: "neutral" as Tone };
  return <Badge tone={q.tone}>{q.label}</Badge>;
}

/** 0–100 score with a bar. For risk/complexity, high is bad. */
export function ScoreBar({ value, higherIsBetter = true, label }: { value: number | null | undefined; higherIsBetter?: boolean; label?: string }) {
  if (value == null) return <span className="text-subtle">—</span>;
  const good = higherIsBetter ? value >= 67 : value < 34;
  const bad = higherIsBetter ? value < 34 : value >= 67;
  return (
    <span className="inline-flex items-center gap-2" aria-label={label ? `${label}: ${value} of 100` : `${value} of 100`}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
        <span className={cn("block h-full rounded-full", good ? "bg-success" : bad ? "bg-danger" : "bg-warning")} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
      </span>
      <span className="tabular-nums text-sm">{Math.round(value)}</span>
    </span>
  );
}

export function SampleBanner() {
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning">
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        <strong>Sample data.</strong> You are viewing demo / simulated workflows. They are stored separately and never included in production totals.
      </p>
    </div>
  );
}

/** Production ⇄ Sample switch (URL ?data=sample). */
export function DataClassToggle({ value }: { value: "production" | "sample" }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const go = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v === "sample") next.set("data", "sample");
    else next.delete("data");
    router.push(`${pathname}${next.size ? `?${next}` : ""}`);
  };
  return (
    <div className="inline-flex rounded-md border border-border p-0.5 text-sm" role="group" aria-label="Data set">
      {(["production", "sample"] as const).map((v) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => go(v)} className={cn("ds-ring rounded px-2.5 py-1", value === v ? "bg-accent text-accent-fg" : "text-muted hover:text-fg")}>
          {v === "production" ? "Production" : "Sample"}
        </button>
      ))}
    </div>
  );
}

export function WiNav({ items }: { items: Array<{ label: string; href: string }> }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const suffix = params.get("data") === "sample" ? "?data=sample" : "";
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === WI ? pathname === WI : pathname.startsWith(i.href)))?.href ?? WI;
  return (
    <Tabs
      ariaLabel="Workflow Intelligence"
      value={active}
      items={items.map((i) => ({ value: i.href, label: i.label, href: `${i.href}${suffix}` }))}
      renderLink={renderLink}
    />
  );
}

export const STEP_TYPE_META: Record<string, { label: string; color: string; short: string }> = {
  trigger: { label: "Trigger", color: "var(--color-chart-5)", short: "TRG" },
  human_task: { label: "Human task", color: "var(--color-chart-2)", short: "HUM" },
  system_action: { label: "System action", color: "var(--color-chart-1)", short: "SYS" },
  ai_task: { label: "AI task", color: "var(--color-chart-3)", short: "AI" },
  decision: { label: "Decision", color: "var(--color-chart-4)", short: "DEC" },
  approval: { label: "Approval", color: "var(--color-danger)", short: "APR" },
  delay: { label: "Delay", color: "var(--color-subtle)", short: "WAIT" },
  exception: { label: "Exception", color: "var(--color-warning)", short: "EXC" },
  completion: { label: "Completion", color: "var(--color-success)", short: "END" },
};

/**
 * Timestamp in the viewer's locale/timezone. Renders the UTC date on the
 * server and the first client pass, then the local form after mount, so SSR
 * (server timezone) and hydration never disagree.
 */
export function LocalDate({ value, dateOnly = false }: { value: string | null | undefined; dateOnly?: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!value) return <>—</>;
  const d = new Date(value);
  if (!mounted) return <time dateTime={value}>{value.slice(0, dateOnly ? 10 : 16).replace("T", " ")}{dateOnly ? "" : " UTC"}</time>;
  return <time dateTime={value}>{dateOnly ? d.toLocaleDateString() : d.toLocaleString()}</time>;
}
