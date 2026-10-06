"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BarChart, Card, CardBody, CardHeader, StatCard } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { LocalDate } from "@/components/local-date";
import { BasisBadge, CostSplit, human, num, OPS, StatusPill, usd, usdCompact } from "./common";

type Dash = Awaited<ReturnType<AiOpsService["dashboard"]>>;
type Exec = Extract<Dash, { mode: "executive" }>;
type Personal = Extract<Dash, { mode: "personal" }>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;

function Stat({ label, value, hint, href }: { label: string; value: string; hint?: React.ReactNode; href?: string | null }) {
  return <StatCard label={href ? <Link className="hover:underline" href={href}>{label}</Link> : label} value={value} hint={hint} />;
}

export function ExecutiveDashboard({ d }: { d: Exec }) {
  const lic = d.licenses;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="AI spend (last 12 months)" value={usdCompact(d.spend.total)} hint={<CostSplit c={d.spend} />} href={d.spend.href} />
        <Stat label="Active AI tools" value={num(d.tools.active)} hint={`${d.vendors.active} active vendors`} href={d.tools.href} />
        <Stat label="Licenses in use" value={`${num(lic.active)} / ${num(lic.assigned)}`} hint={`${num(lic.unused)} unused for ${lic.windowDays}+ days · ${num(lic.seats)} seats bought`} href={lic.href} />
        <Stat label="Adoption" value={`${d.adoption.activePct}%`} hint={`${num(d.adoption.activeUsers)} of ${num(d.adoption.members)} people active (30 days)`} href={d.adoption.href} />
        <Stat label="Model spend (12 months)" value={usdCompact(d.modelSpend.total)} hint="Metered by the platform AI layer" href={d.modelSpend.href} />
        <Stat label="Agents" value={d.agents.total == null ? "—" : num(d.agents.total)} hint={d.agents.total == null ? "Agent Governance not enabled" : `${num(d.agents.highRisk)} high or critical risk`} href={d.agents.href} />
        <Stat label="Business value (annual)" value={usdCompact(d.value.realized)} hint={<span>realized (measured) · {usdCompact(d.value.projected)} projected (estimated)</span>} href={`${OPS}/costs?tab=value`} />
        <Stat label="Savings opportunities" value={usdCompact(d.savings.projected)} hint={`${d.savings.openFindings} open findings · ${usdCompact(d.savings.actioned)} actioned (estimated)`} href={d.savings.href} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Spend trend" description="Monthly AI spend. Measured includes metered platform AI; estimated is contract run-rate where nothing was recorded." actions={<Link href={`${OPS}/costs`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">Costs <ArrowRight className="size-3" /></Link>} />
          <CardBody>
            <BarChart data={d.trend.map((t) => ({ label: monthLabel(t.key), value: t.total }))} ariaLabel="AI spend per month" height={220} valueLabel="Spend (USD)" tickFormatter={usdCompact} valueFormatter={(v) => usd(v)} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Pending decisions" />
          <CardBody className="space-y-3 text-sm">
            <Link href={`${OPS}/requests?stage=open`} className="flex items-center justify-between hover:underline"><span>AI requests awaiting review</span><span className="font-semibold">{d.requests.pending}</span></Link>
            <Link href={`${OPS}/requests`} className="flex items-center justify-between hover:underline"><span>Requests in implementation</span><span className="font-semibold">{d.requests.inImplementation}</span></Link>
            <Link href={`${OPS}/optimization`} className="flex items-center justify-between hover:underline"><span>Optimization findings</span><span className="font-semibold">{d.savings.openFindings}</span></Link>
            <Link href={`${OPS}/tools`} className="flex items-center justify-between hover:underline"><span>Tools without security approval</span><span className="font-semibold">{d.governance.toolsMissingSecurityReview}</span></Link>
            <Link href={`${OPS}/tools`} className="flex items-center justify-between hover:underline"><span>Tools without privacy approval</span><span className="font-semibold">{d.governance.toolsMissingPrivacyReview}</span></Link>
            <Link href={`${OPS}/vendors`} className="flex items-center justify-between hover:underline"><span>Vendors not security-approved</span><span className="font-semibold">{d.governance.vendorsNotApproved}</span></Link>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Spend by category" description="Last 12 months" />
          <CardBody className="space-y-2">
            {d.byCategory.length === 0 && <p className="text-sm text-muted">No spend recorded yet.</p>}
            {d.byCategory.map((c) => <Link key={c.key} href={`${OPS}/costs?by=category`} className="flex items-center justify-between gap-2 text-sm hover:underline"><span>{human(c.key)}</span><span>{usd(c.total)}</span></Link>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Model spend" description="Top models, 12 months" actions={<BasisBadge basis="measured" />} />
          <CardBody className="space-y-2">
            {d.modelSpend.rows.length === 0 && <p className="text-sm text-muted">No metered AI usage yet.</p>}
            {d.modelSpend.rows.map((m) => <Link key={m.key} href={`${OPS}/models`} className="flex items-center justify-between gap-2 text-sm hover:underline"><span className="truncate font-mono text-xs">{m.key}</span><span>{usd(m.total, 2)}</span></Link>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Budgets" actions={<Link href={`${OPS}/costs?tab=budgets`} className="text-sm text-accent hover:underline">All</Link>} />
          <CardBody className="space-y-2">
            {d.budgets.length === 0 && <p className="text-sm text-muted">No budgets yet.</p>}
            {d.budgets.map((b) => (
              <div key={b.id} className="text-sm">
                <div className="flex items-center justify-between gap-2"><span className="truncate">{b.name}</span><StatusPill status={b.status} /></div>
                <div className="mt-1 h-1.5 rounded bg-surface-hover"><div className={b.pctSpent >= 100 ? "h-1.5 rounded bg-danger" : b.pctSpent >= 80 ? "h-1.5 rounded bg-warning" : "h-1.5 rounded bg-accent"} style={{ width: `${Math.min(100, b.pctSpent)}%` }} /></div>
                <p className="text-xs text-muted">{usd(b.spent)} of {usd(b.amount)} · {b.periodLabel} · run-rate {Math.round(b.projectedPct)}%</p>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Value and unit economics" description={d.unitEconomics.window.note} actions={<Link href={`${OPS}/costs?tab=economics`} className="text-sm text-accent hover:underline">Details</Link>} />
        <CardBody className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {d.unitEconomics.metrics.map((m) => (
            <div key={m.key} className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">{m.label}</p>
              <p className="text-2xl font-semibold">{m.total == null ? "—" : usd(m.total, m.total < 1 ? 4 : m.total < 100 ? 2 : 0)}</p>
              {m.perUnit ? <CostSplit c={m.perUnit} /> : <p className="text-xs text-muted">Not enough data yet ({m.denominatorNote}).</p>}
              <p className="mt-1 text-xs text-subtle">per {m.unit}</p>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Across the platform" description="Summaries each enabled module publishes about itself (no data is copied)." />
          <CardBody className="space-y-4">
            {d.modules.length === 0 && <p className="text-sm text-muted">No other module is enabled.</p>}
            {d.modules.map((m) => (
              <div key={m.moduleId}>
                <p className="text-sm font-medium">{m.label}</p>
                {m.error && <p className="text-xs text-warning">{m.error}</p>}
                <div className="mt-1 grid gap-x-4 sm:grid-cols-2">
                  {m.metrics.map((x) => (
                    <Link key={x.key} href={x.href ?? "#"} className="flex items-center justify-between gap-2 py-0.5 text-sm hover:underline">
                      <span className="text-muted">{x.label}</span>
                      <span className="font-medium">{x.unit === "count" ? num(x.value) : x.unit === "percent" ? `${x.value}%` : usdCompact(x.value)}{x.basis === "estimated" ? "*" : ""}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            {d.modules.some((m) => m.metrics.some((x) => x.basis === "estimated")) && <p className="text-xs text-subtle">* estimated</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Business value sources" description="Realized value is measured; projections are estimates and are never added to realized value." />
          <CardBody className="space-y-2">
            {d.value.sources.map((s) => <div key={s.label} className="flex items-center justify-between gap-2 text-sm"><span className="text-muted">{s.label}</span><span className="flex items-center gap-2">{usd(s.value)}<BasisBadge basis={s.basis} /></span></div>)}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export function PersonalWorkspace({ d }: { d: Personal }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Approved AI tools" description="Strategic and approved tools you can use." actions={<Link href={`${OPS}/tools`} className="text-sm text-accent hover:underline">All tools</Link>} />
        <CardBody className="space-y-2">
          {d.approvedTools.length === 0 && <p className="text-sm text-muted">No tools have been approved yet.</p>}
          {d.approvedTools.slice(0, 10).map((t) => <Link key={t.id} href={`${OPS}/tools/${t.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline"><span><span className="font-medium">{t.name}</span><span className="block text-xs text-muted">{t.purpose.slice(0, 120)}</span></span><StatusPill status={t.status} /></Link>)}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="My training" actions={<Link href={`${OPS}/training`} className="text-sm text-accent hover:underline">Open</Link>} />
        <CardBody className="space-y-2">
          {d.training.length === 0 && <p className="text-sm text-muted">No training assigned.</p>}
          {d.training.map((a) => <div key={a.id} className="flex items-center justify-between gap-2 text-sm"><span>{a.programName}{a.dueDate ? <span className="block text-xs text-muted">due {a.dueDate}{a.overdue ? " — overdue" : ""}</span> : null}</span><StatusPill status={a.status} /></div>)}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="My AI requests" actions={<Link href={`${OPS}/requests`} className="text-sm text-accent hover:underline">New request</Link>} />
        <CardBody className="space-y-2">
          {d.requests.length === 0 && <p className="text-sm text-muted">You have not requested anything yet.</p>}
          {d.requests.slice(0, 8).map((r) => <Link key={r.id} href={`${OPS}/requests/${r.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline"><span>{r.title}<span className="block text-xs text-muted">updated <LocalDate value={r.updatedAt} dateOnly /></span></span><StatusPill status={r.stage} /></Link>)}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Approved use cases" actions={<Link href={`${OPS}/enablement`} className="text-sm text-accent hover:underline">Library</Link>} />
        <CardBody className="space-y-2">
          {d.useCases.length === 0 && <p className="text-sm text-muted">The use-case library has not been published yet.</p>}
          {d.useCases.slice(0, 8).map((u) => <Link key={u.id} href={`${OPS}/enablement?focus=${u.id}`} className="block text-sm hover:underline"><span className="font-medium">{u.title}</span><span className="block text-xs text-muted">{u.department} · {u.toolName ?? "tool to be named"}</span></Link>)}
        </CardBody>
      </Card>
    </div>
  );
}
