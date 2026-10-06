"use client";

import { usePathname } from "next/navigation";
import { Badge, Tabs, type Tone } from "@eaop/design-system";
import { renderLink } from "@/components/link";

export const DS = "/m/data-security";

const SENS_TONE: Record<string, Tone> = { public: "neutral", internal: "info", confidential: "warning", restricted: "danger" };
export function SensitivityBadge({ value, locked }: { value: string; locked?: boolean }) {
  return <Badge tone={SENS_TONE[value] ?? "neutral"}>{value}{locked ? " · locked" : ""}</Badge>;
}

const SEV_TONE: Record<string, Tone> = { low: "neutral", medium: "info", high: "warning", critical: "danger" };
export function SeverityBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-subtle">—</span>;
  return <Badge tone={SEV_TONE[value] ?? "neutral"}>{value}</Badge>;
}

const DECISION_TONE: Record<string, Tone> = { ALLOW: "success", REDACT: "info", REQUIRE_APPROVAL: "warning", BLOCK: "danger" };
export function DecisionBadge({ value }: { value: string }) {
  return <Badge tone={DECISION_TONE[value] ?? "neutral"}>{value.replace("_", " ").toLowerCase()}</Badge>;
}

const STATUS_TONE: Record<string, Tone> = {
  open: "danger", investigating: "warning", contained: "info", resolved: "success", accepted: "neutral",
  recommended: "warning", completed: "success", dismissed: "neutral", failed: "danger",
  approved: "success", experimental: "info", unknown: "warning", restricted: "warning", blocked: "danger",
  pending: "warning", rejected: "danger", expired: "neutral", used: "neutral",
  queued: "neutral", running: "info", succeeded: "success",
  none: "neutral", potential: "warning", observed: "danger",
  unreviewed: "neutral", confirmed: "success",
};
export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-subtle">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{status.replace(/_/g, " ")}</Badge>;
}

export const human = (s: string) => s.replace(/_/g, " ");
export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 }));
export const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: human(x) }));

export function DsNav({ items }: { items: Array<{ label: string; href: string }> }) {
  const pathname = usePathname();
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === DS ? pathname === DS : pathname.startsWith(i.href)))?.href ?? DS;
  return <Tabs ariaLabel="AI Data Security" value={active} items={items.map((i) => ({ value: i.href, label: i.label, href: i.href }))} renderLink={renderLink} />;
}
