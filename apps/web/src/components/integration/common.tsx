"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { Badge, Tabs, Textarea, cn, type Tone } from "@eaop/design-system";
import { renderLink } from "@/components/link";

export const IH = "/m/integration-hub";

const STATUS_TONE: Record<string, Tone> = {
  queued: "neutral", running: "info", waiting_approval: "warning", waiting_delay: "warning", succeeded: "success", failed: "danger", partially_failed: "warning", cancelled: "neutral",
  pending: "warning", approved: "success", rejected: "danger", expired: "neutral",
  draft: "neutral", active: "success", paused: "warning", archived: "neutral", disabled: "neutral",
  open: "warning", retrying: "info", dead_letter: "danger", resolved: "success",
  skipped: "neutral", waiting: "warning", dry_run: "info", compensated: "info", compensation_failed: "danger",
};
export function StatusPill({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>{status.replace(/_/g, " ")}</Badge>;
}

const RISK_TONE: Record<string, Tone> = { low: "success", medium: "info", high: "warning", critical: "danger" };
export function RiskBadge({ risk }: { risk: string }) {
  return <Badge tone={RISK_TONE[risk] ?? "neutral"}>{risk} risk</Badge>;
}

export const fmtMs = (ms: number | null | undefined) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
export const fmtCost = (usd: number | null | undefined) => (usd == null ? "—" : usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export function IhNav({ items }: { items: Array<{ label: string; href: string }> }) {
  const pathname = usePathname();
  const active = [...items].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === IH ? pathname === IH : pathname.startsWith(i.href)))?.href ?? IH;
  return <Tabs ariaLabel="Enterprise AI Integration" value={active} items={items.map((i) => ({ value: i.href, label: i.label, href: i.href }))} renderLink={renderLink} />;
}

/** JSON textarea with live parse feedback. `onValid` only fires with parseable JSON. */
export function JsonField({ id, value, onValid, rows = 6, disabled, label }: { id: string; value: unknown; onValid: (v: unknown) => void; rows?: number; disabled?: boolean; label: string }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Textarea
        id={id}
        rows={rows}
        disabled={disabled}
        spellCheck={false}
        className={cn("font-mono text-xs", error && "border-danger")}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = e.target.value.trim() === "" ? {} : JSON.parse(e.target.value);
            setError(null);
            onValid(v);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid JSON");
          }
        }}
      />
      {error && <p id={`${id}-err`} className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export const NODE_META: Record<string, { label: string; color: string; short: string; help: string }> = {
  trigger: { label: "Trigger", color: "var(--color-chart-5)", short: "TRG", help: "Where a run starts. Input is validated against the workflow's input schema." },
  connector_action: { label: "Connector action", color: "var(--color-chart-1)", short: "ACT", help: "Runs a catalog action through a shared connector: validation → permissions → policy → approval → call." },
  ai_step: { label: "AI step", color: "var(--color-chart-3)", short: "AI", help: "Calls the shared AI layer and validates the JSON output against a schema." },
  transform: { label: "Transform", color: "var(--color-chart-2)", short: "MAP", help: "Maps source fields to normalized / destination fields with types, transforms and fallbacks." },
  condition: { label: "Condition", color: "var(--color-chart-4)", short: "IF", help: "Evaluated by the shared policy engine. Follows the true or false edge." },
  human_approval: { label: "Human approval", color: "var(--color-danger)", short: "APR", help: "Pauses until someone with integration.approve decides. Initiators cannot approve their own runs." },
  delay: { label: "Delay", color: "var(--color-subtle)", short: "WAIT", help: "Waits, then continues (scheduled through the shared job queue)." },
  retry: { label: "Retry", color: "var(--color-info)", short: "RTY", help: "Sets the retry policy for the next action or AI step (transient, rate-limit, timeout and circuit-open errors)." },
  branch: { label: "Branch", color: "var(--color-chart-4)", short: "SW", help: "Routes on a value: each case edge's label is matched; the next edge is the default." },
  exception_handler: { label: "Exception handler", color: "var(--color-warning)", short: "EXC", help: "Reached through an error edge. Can run best-effort compensations and notify the initiator." },
  completion: { label: "Completion", color: "var(--color-success)", short: "END", help: "Ends the run; its output template becomes the execution result." },
};
export const EDGE_META: Record<string, { label: string; color: string; dash?: string }> = {
  next: { label: "next", color: "var(--color-border-strong)" },
  true: { label: "true", color: "var(--color-success)" },
  false: { label: "false", color: "var(--color-danger)" },
  error: { label: "on error", color: "var(--color-danger)", dash: "5 4" },
  case: { label: "case", color: "var(--color-chart-4)" },
  rejected: { label: "rejected", color: "var(--color-warning)", dash: "5 4" },
  exhausted: { label: "exhausted", color: "var(--color-subtle)", dash: "2 3" },
};
