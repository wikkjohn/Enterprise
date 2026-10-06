"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { BarChart, Card, CardBody, CardHeader, StatCard } from "@eaop/design-system";
import { type ApprovalView, type DashboardView } from "@eaop/module-agent-governance";
import { LocalDate } from "@/components/local-date";
import { AG, EffectBadge, fmtNum } from "./common";

export function AgentDashboard({ d, approvals }: { d: DashboardView; approvals: ApprovalView[] }) {
  const stats: Array<{ label: string; value: number; hint: string; href?: string }> = [
    { label: "Active agents", value: d.activeAgents, hint: "Approved or restricted, not quarantined", href: `${AG}/agents?status=approved` },
    { label: "Unknown agents", value: d.unknownAgents, hint: "Discovered but never registered", href: `${AG}/agents?status=unknown` },
    { label: "High-risk agents", value: d.highRiskAgents, hint: "Risk band or category high/critical", href: `${AG}/agents` },
    { label: "Suspended agents", value: d.suspendedAgents, hint: "Stopped by the kill switch", href: `${AG}/agents?status=suspended` },
    { label: "Privileged agents", value: d.privilegedAgents, hint: "Write/send/execute in production, restricted data or ≥10k financial authority" },
    { label: "Policy violations (30 d)", value: d.policyViolations30d, hint: "Denied actions + violation incidents" },
    { label: "Denied actions (30 d)", value: d.deniedActions30d, hint: "Bindings or policies said no", href: `${AG}/activity?decision=DENY` },
    { label: "Approval requests", value: d.pendingApprovals, hint: "Waiting for a person", href: `${AG}/approvals` },
    { label: "Sensitive-data requests (30 d)", value: d.sensitiveDataAccess30d, hint: "Confidential or restricted data" },
    { label: "Agents without owners", value: d.agentsWithoutOwners, hint: "Cannot be approved until owned" },
    { label: "Stale reviews", value: d.staleReviews, hint: "Attestation overdue", href: `${AG}/reviews` },
    { label: "Open incidents", value: d.openIncidents, hint: "Kill switch, violations, manual", href: `${AG}/incidents` },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <StatCard key={s.label} label={s.href ? <Link className="hover:underline" href={s.href}>{s.label}</Link> : s.label} value={fmtNum(s.value)} hint={s.hint} />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Agents by status" />
          <CardBody><BarChart data={d.byStatus} ariaLabel="Agents by status" height={200} valueLabel="Agents" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Decisions (30 days)" description="Every evaluation of an agent action — direct requests and Integration tool calls." />
          <CardBody><BarChart data={d.decisions30d.map((x) => ({ ...x, label: x.label.replace("_", " ").toLowerCase() }))} ariaLabel="Policy decisions in the last 30 days" height={200} valueLabel="Decisions" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /></CardBody>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Needs attention" />
          <CardBody className="space-y-2">
            {d.attention.length === 0 && <p className="text-sm text-muted">Nothing needs attention.</p>}
            {d.attention.map((a) => (
              <Link key={a.agentId} href={`${AG}/agents/${a.agentId}`} className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-sm hover:bg-surface-hover">
                <span className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-warning" aria-hidden />{a.name}</span>
                <span className="text-right text-xs text-muted">{a.reasons.join(" · ")}</span>
              </Link>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Waiting for approval" actions={<Link href={`${AG}/approvals`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">All approvals <ArrowRight className="size-3" /></Link>} />
          <CardBody className="space-y-2">
            {approvals.length === 0 && <p className="text-sm text-muted">Nothing is waiting.</p>}
            {approvals.map((a) => (
              <Link key={a.id} href={`${AG}/approvals?focus=${a.id}`} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm hover:bg-surface-hover">
                <span className="min-w-0"><span className="block truncate font-medium">{a.agentName} — {a.request?.action}</span><span className="text-xs text-muted">{a.request?.actionType} on {a.request?.system} · <LocalDate value={a.createdAt} /></span></span>
                <EffectBadge effect={(a.policy as { effect?: string } | null)?.effect} />
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
