"use client";

import { DataTable, EmptyState, StatusBadge } from "@eaop/design-system";

export function FailedJobsTable({ jobs }: { jobs: Array<{ id: string; type: string; status: string; attempts: number; lastError: string | null }> }) {
  if (jobs.length === 0) return <EmptyState compact title="No failed jobs" />;
  return (
    <DataTable rows={jobs} getRowId={(j) => j.id} density="compact" caption="Failed background jobs" columns={[
      { key: "type", header: "Type", cell: (j) => <code className="font-mono text-xs">{j.type}</code> },
      { key: "status", header: "Status", cell: (j) => <StatusBadge status={j.status} /> },
      { key: "att", header: "Attempts", align: "right", cell: (j) => j.attempts },
      { key: "err", header: "Last error", cell: (j) => <span className="text-xs">{j.lastError}</span> },
    ]} />
  );
}

export function RecentErrorsTable({ errors }: { errors: Array<{ id: string; occurredAt: string; severity: string; source: string; code: string | null; message: string; correlationId: string | null }> }) {
  if (errors.length === 0) return <EmptyState compact title="No recent errors" />;
  return (
    <DataTable rows={errors} getRowId={(e) => e.id} density="compact" caption="Recent errors" columns={[
      { key: "t", header: "Time", cell: (e) => new Date(e.occurredAt).toLocaleString() },
      { key: "sev", header: "Severity", cell: (e) => <StatusBadge status={e.severity === "critical" ? "failed" : "degraded"} label={e.severity} /> },
      { key: "src", header: "Source", cell: (e) => <span className="text-xs">{e.source}</span> },
      { key: "msg", header: "Message", cell: (e) => <span className="text-xs">{e.code}: {e.message}</span> },
      { key: "corr", header: "Correlation", cell: (e) => <code className="font-mono text-xs">{e.correlationId?.slice(0, 8)}</code> },
    ]} />
  );
}
