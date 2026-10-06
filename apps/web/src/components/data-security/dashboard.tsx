"use client";

import Link from "next/link";
import { ArrowRight, Radar } from "lucide-react";
import { BarChart, Card, CardBody, CardHeader, StatCard } from "@eaop/design-system";
import { type DashboardView } from "@eaop/module-data-security";
import { LocalDate } from "@/components/local-date";
import { DS, fmtNum, human, SeverityBadge } from "./common";

export function SecurityDashboard({ d, canShadow }: { d: DashboardView; canShadow: boolean }) {
  const r = d.permissionRisks;
  const stats: Array<{ label: string; value: string; hint: string; href?: string }> = [
    { label: "Sensitive assets", value: fmtNum(d.sensitiveAssets), hint: `Confidential or restricted, of ${fmtNum(d.totalAssets)} discovered`, href: `${DS}/assets?classification=restricted` },
    { label: "Exposed sensitive assets", value: fmtNum(d.exposedSensitiveAssets), hint: "Potential or observed AI exposure", href: `${DS}/findings` },
    { label: "Shadow AI tools", value: fmtNum(d.shadowAiTools), hint: `${fmtNum(d.unapprovedAiTools)} not approved`, href: canShadow ? `${DS}/shadow-ai` : undefined },
    { label: "Blocked AI transmissions (30 d)", value: fmtNum(d.blockedTransmissions30d), hint: "Stopped by DLP before reaching AI", href: `${DS}/dlp?decision=BLOCK` },
    { label: "Redacted transmissions (30 d)", value: fmtNum(d.redactedTransmissions30d), hint: "Sent with sensitive values removed", href: `${DS}/dlp?decision=REDACT` },
    { label: "Awaiting approval", value: fmtNum(d.pendingApprovals), hint: "AI data transfers held for a reviewer", href: `${DS}/dlp?approval=pending` },
    { label: "Open incidents", value: fmtNum(d.openIncidents), hint: `${fmtNum(d.criticalIncidents)} critical`, href: `${DS}/incidents` },
    { label: "Permission risks", value: fmtNum(r.critical + r.high + r.medium + r.low), hint: `${r.critical} critical · ${r.high} high · ${r.medium} medium`, href: `${DS}/findings` },
    { label: "Remediation progress", value: `${d.remediation.percent}%`, hint: `${d.remediation.completed} done · ${d.remediation.open} open`, href: `${DS}/remediation` },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {stats.map((s) => <StatCard key={s.label} label={s.href ? <Link className="hover:underline" href={s.href}>{s.label}</Link> : s.label} value={s.value} hint={s.hint} />)}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span>Last discovery scan: {d.lastScanAt ? <LocalDate value={d.lastScanAt} /> : "never"}</span>
        <span>Shadow AI telemetry: {d.telemetryConnected ? "receiving data" : <span className="text-warning">no telemetry source connected — employee AI use outside the platform is not visible</span>}</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Sensitive data by category" description="Assets carrying each category (medium or high confidence)." />
          <CardBody>{d.byCategory.length ? <BarChart data={d.byCategory} ariaLabel="Assets by data category" height={220} valueLabel="Assets" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /> : <p className="text-sm text-muted">No classified assets yet.</p>}</CardBody>
        </Card>
        <Card>
          <CardHeader title="AI DLP decisions (30 days)" description="Platform AI requests and enforcement-point checks." />
          <CardBody><BarChart data={d.dlp30d} ariaLabel="DLP decisions in the last 30 days" height={220} valueLabel="Transmissions" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /></CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Top permission risks" actions={<Link href={`${DS}/findings`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">All findings <ArrowRight className="size-3" /></Link>} />
        <CardBody className="space-y-2">
          {d.topFindings.length === 0 && <p className="flex items-center gap-2 text-sm text-muted"><Radar className="size-4" aria-hidden />No open findings. Run a discovery scan or push inventory to find exposure.</p>}
          {d.topFindings.map((f) => (
            <Link key={f.id} href={`${DS}/assets/${f.assetId}`} className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm hover:bg-surface-hover">
              <span className="min-w-0"><span className="block truncate font-medium">{f.assetName}</span><span className="text-xs text-muted">{human(f.kind)} — {f.detail}</span></span>
              <SeverityBadge value={f.severity} />
            </Link>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
