"use client";

import { usePathname } from "next/navigation";
import { Badge, Tabs, type Tone } from "@eaop/design-system";
import { renderLink } from "@/components/link";

export const OPS = "/m/ai-operations";

export const human = (s: string) => s.replace(/_/g, " ");
export const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: human(x) }));
const usdFmt = (n: number, digits: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const usd = (n: number | null | undefined, digits = 0) => (n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
export const usdCompact = (n: number | null | undefined) => (n == null ? "—" : Math.abs(n) >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 10_000 ? `$${Math.round(n / 1000)}k` : usd(n));
export const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

const STATUS_TONE: Record<string, Tone> = {
  strategic: "success", approved: "success", experimental: "info", restricted: "warning", retiring: "neutral",
  not_started: "neutral", not_reviewed: "neutral", in_progress: "info", in_review: "info", conditional: "warning", rejected: "danger",
  active: "success", inactive: "neutral", draft: "neutral", published: "success", retired: "neutral", expired: "neutral", terminated: "neutral",
  open: "warning", accepted: "info", dismissed: "neutral", resolved: "success",
  submitted: "info", business_review: "info", security_review: "info", technical_review: "info", financial_review: "info", implementation: "info", measurement: "info", closed: "neutral",
  assigned: "info", completed: "success", waived: "neutral",
  ok: "success", at_risk: "warning", warning: "warning", exceeded: "danger",
  advisory: "info", enforced: "warning", disabled: "neutral", void: "neutral", allocated: "info",
};
export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-subtle">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{human(status)}</Badge>;
}

const BASIS_TONE: Record<string, Tone> = { measured: "success", estimated: "warning", allocated: "info" };
/** Every money figure says how it was obtained. */
export function BasisBadge({ basis }: { basis: string }) {
  return <Badge tone={BASIS_TONE[basis] ?? "neutral"}>{basis}</Badge>;
}

const SEV_TONE: Record<string, Tone> = { low: "neutral", medium: "warning", high: "danger" };
export function SeverityBadge({ value }: { value: string }) {
  return <Badge tone={SEV_TONE[value] ?? "neutral"}>{value}</Badge>;
}

/** Measured · estimated · allocated split, compact. */
export function CostSplit({ c }: { c: { measured: number; estimated: number; allocated: number } }) {
  const max = Math.max(Math.abs(c.measured), Math.abs(c.estimated), Math.abs(c.allocated));
  const usd = (n: number) => usdFmt(n, max < 1 ? 4 : max < 100 ? 2 : 0);
  return (
    <span className="text-xs text-muted">
      {usd(c.measured)} measured{c.estimated ? ` · ${usd(c.estimated)} estimated` : ""}{c.allocated ? ` · ${usd(c.allocated)} allocated` : ""}
    </span>
  );
}

export function OpsNav({ items }: { items: Array<{ label: string; href: string }> }) {
  const pathname = usePathname();
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === OPS ? pathname === OPS : pathname.startsWith(i.href)))?.href ?? OPS;
  return <Tabs ariaLabel="AI Operations" value={active} items={items.map((i) => ({ value: i.href, label: i.label, href: i.href }))} renderLink={renderLink} />;
}
