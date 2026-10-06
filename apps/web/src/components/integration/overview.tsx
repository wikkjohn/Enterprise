"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ArrowRight, Sparkles } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, DataTable, EmptyState, StatCard, type DataTableColumn } from "@eaop/design-system";
import { type ApprovalView, type ExecutionSummary, type OverviewView } from "@eaop/module-integration-hub";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { fmtMs, IH, RiskBadge, StatusPill } from "./common";

export function IntegrationOverview({ overview: o, approvals, recent, canHistory, canManage }: { overview: OverviewView; approvals: ApprovalView[]; recent: ExecutionSummary[]; canHistory: boolean; canManage: boolean }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const total7d = Object.values(o.executions7d).reduce((n, v) => n + v, 0);
  const execColumns: Array<DataTableColumn<ExecutionSummary>> = [
    { key: "what", header: "Run", cell: (e) => <span className="font-medium">{e.workflowName ?? `Tool: ${e.actionKey}`}</span> },
    { key: "status", header: "Status", cell: (e) => <StatusPill status={e.status} /> },
    { key: "mode", header: "Mode", hideOnMobile: true, cell: (e) => (e.mode === "test" ? "test" : e.trigger) },
    { key: "who", header: "By", hideOnMobile: true, cell: (e) => <span className="text-xs">{e.actor.label}{e.agent ? ` · agent ${e.agent.id}` : ""}</span> },
    { key: "dur", header: "Duration", align: "right", hideOnMobile: true, cell: (e) => fmtMs(e.durationMs) },
    { key: "when", header: "Started", cell: (e) => <LocalDate value={e.createdAt} /> },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Live runs (7 days)" value={canHistory ? total7d.toLocaleString("en-US") : "—"} hint={canHistory ? `${o.executions7d.succeeded ?? 0} succeeded · ${(o.executions7d.failed ?? 0) + (o.executions7d.partially_failed ?? 0)} failed` : "Requires integration.history.read"} />
        <StatCard label="Success rate (7 days)" value={o.successRate7d == null ? "—" : `${o.successRate7d}%`} hint={o.avgDurationMs7d == null ? "Finished live runs" : `Average duration ${fmtMs(o.avgDurationMs7d)}`} />
        <StatCard label="Pending approvals" value={String(o.pendingApprovals)} hint="Actions paused for a human decision" />
        <StatCard label="Dead letters" value={String(o.deadLetters)} hint={`${o.openErrors} other open error(s)`} />
        <StatCard label="Active workflows" value={String(o.activeWorkflows)} />
        <StatCard label="Actions in catalog" value={String(o.actions)} />
      </div>

      {o.actions === 0 && o.activeWorkflows === 0 && (
        <EmptyState
          icon={<Sparkles className="size-6" />}
          title="Start with the action catalog"
          description="Bind catalog actions to your shared connectors, then compose them into workflows. In non-production environments you can generate a sample quote workflow that runs against the simulated sandbox connector."
          action={canManage ? (
            <button type="button" className="text-accent underline" disabled={pending} onClick={async () => { const w = await run(() => apiFetch<{ id: string }>(`${IH}/workflows/sample`, { method: "POST" }), { success: "Sample workflow created", refresh: false }); if (w) router.push(`${IH}/workflows/${w.id}`); }}>
              Create the sample workflow
            </button>
          ) : undefined}
        />
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Waiting for approval" actions={<Link href={`${IH}/approvals`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">All approvals <ArrowRight className="size-3" /></Link>} />
          <CardBody className="space-y-2">
            {approvals.length === 0 && <p className="text-sm text-muted">Nothing is waiting.</p>}
            {approvals.map((a) => (
              <Link key={a.id} href={`${IH}/approvals?focus=${a.id}`} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm hover:bg-surface-hover">
                <span className="min-w-0"><span className="block truncate font-medium">{a.title}</span><span className="text-xs text-muted">{a.workflowName ?? "AI tool call"} · requested by {a.requestedBy.label}</span></span>
                <RiskBadge risk={a.risk} />
              </Link>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Connector circuit breakers" description="Calls to a connector pause after 5 transient failures in 5 minutes, then a probe is allowed after 60 s." />
          <CardBody className="space-y-2">
            {o.breakers.length === 0 && <p className="text-sm text-muted">No connectors in use yet.</p>}
            {o.breakers.map((b) => (
              <div key={b.connectorId} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2"><Activity className="size-4 text-subtle" aria-hidden />{b.connectorName}</span>
                <span className="flex items-center gap-2 text-xs text-muted">{b.recentFailures} recent failure(s)<Badge tone={b.state === "closed" ? "success" : b.state === "open" ? "danger" : "warning"}>{b.state.replace("_", "-")}</Badge></span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      {canHistory && (
        <Card>
          <CardHeader title="Recent executions" actions={<Link href={`${IH}/executions`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">History <ArrowRight className="size-3" /></Link>} />
          <DataTable columns={execColumns} rows={recent} getRowId={(e) => e.id} onRowClick={(e) => router.push(`${IH}/executions/${e.id}`)} rowLabel={(e) => `Open execution ${e.id}`} caption="Recent executions" emptyState={<p className="p-6 text-center text-sm text-muted">No executions yet.</p>} />
        </Card>
      )}
    </div>
  );
}
