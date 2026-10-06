"use client";

import { usePathname } from "next/navigation";
import { Badge, Tabs, type Tone } from "@eaop/design-system";
import { renderLink } from "@/components/link";

export const AG = "/m/agent-governance";

const STATUS_TONE: Record<string, Tone> = {
  unknown: "danger", pending: "warning", approved: "success", restricted: "info", suspended: "danger", retired: "neutral",
  allowed: "success", denied: "danger", pending_approval: "warning", rejected: "danger", clarification_requested: "info", escalated: "warning", executed: "success", failed: "danger", expired: "neutral", cancelled: "neutral",
  active: "success", disabled: "neutral", revoked: "neutral", completed: "success", terminated: "danger",
  open: "danger", investigating: "warning", resolved: "success", scheduled: "info",
};
export function StatusPill({ status, quarantined }: { status: string; quarantined?: boolean }) {
  if (quarantined) return <Badge tone="danger" dot>quarantined</Badge>;
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{status.replace(/_/g, " ")}</Badge>;
}

const EFFECT_TONE: Record<string, Tone> = { ALLOW: "success", REQUIRE_APPROVAL: "warning", ESCALATE: "warning", DENY: "danger" };
export function EffectBadge({ effect }: { effect: string | null | undefined }) {
  if (!effect) return <span className="text-subtle">—</span>;
  return <Badge tone={EFFECT_TONE[effect] ?? "neutral"}>{effect.replace(/_/g, " ").toLowerCase()}</Badge>;
}

const RISK_TONE: Record<string, Tone> = { low: "success", medium: "info", high: "warning", critical: "danger" };
export function RiskBadge({ band, score }: { band: string | null | undefined; score?: number | null }) {
  if (!band) return <span className="text-subtle">—</span>;
  return <Badge tone={RISK_TONE[band] ?? "neutral"}>{band}{score != null ? ` · ${Math.round(score)}` : ""}</Badge>;
}

/** Deterministic number formatting (identical on server and client). */
export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }));

export function AgNav({ items }: { items: Array<{ label: string; href: string }> }) {
  const pathname = usePathname();
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === AG ? pathname === AG : pathname.startsWith(i.href)))?.href ?? AG;
  return <Tabs ariaLabel="AI Agent Governance" value={active} items={items.map((i) => ({ value: i.href, label: i.label, href: i.href }))} renderLink={renderLink} />;
}

export const ACTION_TYPES = ["READ", "WRITE", "CREATE", "UPDATE", "DELETE", "SEND", "EXECUTE", "APPROVE", "EXPORT"] as const;
export const SENSITIVITY = ["public", "internal", "confidential", "restricted"] as const;
export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export const AUTONOMY = ["assistive", "supervised", "semi_autonomous", "autonomous"] as const;
export const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x.replace(/_/g, " ") }));
