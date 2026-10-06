"use client";

import { usePathname } from "next/navigation";
import { Badge, Tabs, type Tone } from "@eaop/design-system";
import { renderLink } from "@/components/link";

export const KV = "/m/knowledge-verification";

export const human = (s: string) => s.replace(/_/g, " ");
export const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: human(x) }));
export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

const AUTH_TONE: Record<string, Tone> = { authoritative: "success", preferred: "info", secondary: "neutral", deprecated: "warning" };
export function AuthorityBadge({ value, inherited }: { value: string; inherited?: boolean }) {
  return <Badge tone={AUTH_TONE[value] ?? "neutral"} title={inherited ? "Inherited from the source" : undefined}>{value}{inherited ? " (source)" : ""}</Badge>;
}

const FRESH_TONE: Record<string, Tone> = { fresh: "success", stale: "warning", expired: "danger" };
export function FreshnessBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-subtle">—</span>;
  return <Badge tone={FRESH_TONE[value] ?? "neutral"} dot>{value}</Badge>;
}

const CONF_TONE: Record<string, Tone> = { high: "success", medium: "info", low: "warning", insufficient: "danger" };
export function ConfidenceBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-subtle">—</span>;
  return <Badge tone={CONF_TONE[value] ?? "neutral"}>{value} confidence</Badge>;
}

const VERIFY_TONE: Record<string, Tone> = { VERIFIED: "success", PARTIALLY_VERIFIED: "info", UNSUPPORTED: "warning", CONTRADICTED: "danger" };
export function VerificationBadge({ value }: { value: string }) {
  return <Badge tone={VERIFY_TONE[value] ?? "neutral"}>{human(value).toLowerCase()}</Badge>;
}

const SENS_TONE: Record<string, Tone> = { public: "neutral", internal: "info", confidential: "warning", restricted: "danger" };
export function ClassificationBadge({ value }: { value: string }) {
  return <Badge tone={SENS_TONE[value] ?? "neutral"}>{value}</Badge>;
}

const STATUS_TONE: Record<string, Tone> = {
  active: "success", archived: "neutral", superseded: "warning", indexed: "success", failed: "danger", pending: "neutral",
  open: "danger", in_progress: "warning", resolved: "success", dismissed: "neutral",
  answered: "success", unanswered: "warning", escalated: "danger",
  queued: "neutral", running: "info", succeeded: "success", paused: "neutral",
  duplicate: "neutral", near_duplicate: "info", newer_version: "warning", contradiction: "danger",
};
export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-subtle">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{human(status)}</Badge>;
}

export function KvNav({ items }: { items: Array<{ label: string; href: string }> }) {
  const pathname = usePathname();
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === KV ? pathname === KV : pathname.startsWith(i.href)))?.href ?? KV;
  return <Tabs ariaLabel="AI Knowledge & Verification" value={active} items={items.map((i) => ({ value: i.href, label: i.label, href: i.href }))} renderLink={renderLink} />;
}
