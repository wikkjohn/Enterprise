"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bot, Brain, CheckCircle2, CircleSlash, Cog, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, FormField, KeyValueList, Modal, Select, StatCard, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type ApprovalView, type ErrorView, type ExecutionDetail, type ExecutionSummary } from "@eaop/module-integration-hub";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { fmtCost, fmtMs, IH, NODE_META, RiskBadge, StatusPill } from "./common";

// ── Approvals ───────────────────────────────────────────────────────────────

export function ApprovalQueue({ approvals, focus, viewerId, canApprove, canHistory }: { approvals: ApprovalView[]; focus?: string; viewerId: string; canApprove: boolean; canHistory: boolean }) {
  const [status, setStatus] = useState("pending");
  const [open, setOpen] = useState<ApprovalView | null>(approvals.find((a) => a.id === focus) ?? null);
  const rows = approvals.filter((a) => !status || a.status === status);
  const columns: Array<DataTableColumn<ApprovalView>> = [
    { key: "t", header: "Request", cell: (a) => <span><span className="font-medium">{a.title}</span><span className="block text-xs text-muted">{a.workflowName ?? "AI tool call"} · {a.system ?? "workflow step"}</span></span> },
    { key: "r", header: "Risk", cell: (a) => <RiskBadge risk={a.risk} /> },
    { key: "by", header: "Requested by", hideOnMobile: true, cell: (a) => <span className="text-xs">{a.requestedBy.label}</span> },
    { key: "s", header: "Status", cell: (a) => <StatusPill status={a.status} /> },
    { key: "when", header: "Requested", hideOnMobile: true, cell: (a) => <LocalDate value={a.createdAt} /> },
    { key: "exp", header: "Expires", hideOnMobile: true, cell: (a) => (a.status === "pending" ? <LocalDate value={a.expiresAt} /> : "—") },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Status" className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }, { value: "expired", label: "Expired" }, { value: "cancelled", label: "Cancelled" }, { value: "", label: "All" }]} />
      <DataTable columns={columns} rows={rows} getRowId={(a) => a.id} onRowClick={setOpen} rowLabel={(a) => `Review ${a.title}`} caption="Approval requests" emptyState={<p className="p-6 text-center text-sm text-muted">Nothing here.</p>} />
      {open && <ApprovalModal approval={open} own={open.requestedBy.id === viewerId} canApprove={canApprove} canHistory={canHistory} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ApprovalModal({ approval: a, own, canApprove, canHistory, onClose }: { approval: ApprovalView; own: boolean; canApprove: boolean; canHistory: boolean; onClose: () => void }) {
  const [note, setNote] = useState("");
  const { run, pending } = useMutation();
  const decide = async (decision: "approve" | "reject") => {
    if (await run(() => apiFetch(`${IH}/approvals/${a.id}/decision`, { body: { decision, note: note || undefined } }), { success: decision === "approve" ? "Approved — the run continues" : "Rejected" })) onClose();
  };
  return (
    <Modal open onClose={onClose} size="lg" title={a.title} description={a.reason}>
      <div className="space-y-4 text-sm">
        <KeyValueList columns={2} items={[
          { key: "action", label: "Action", value: a.title },
          { key: "system", label: "System", value: a.system ?? "—" },
          { key: "risk", label: "Risk", value: <RiskBadge risk={a.risk} /> },
          { key: "impact", label: "Business impact", value: a.businessImpact ?? "—" },
          { key: "by", label: "Requested by", value: a.requestedBy.label },
          { key: "status", label: "Status", value: <StatusPill status={a.status} /> },
        ]} />
        <div>
          <p className="mb-1 font-medium">Affected data</p>
          <CodeBlock code={JSON.stringify(a.affectedData ?? {}, null, 2)} language="json" maxHeight="160px" />
        </div>
        <div>
          <p className="mb-1 font-medium">Proposed payload</p>
          <CodeBlock code={JSON.stringify(a.proposedPayload ?? {}, null, 2)} language="json" maxHeight="220px" />
        </div>
        {a.policyDecision ? (
          <div>
            <p className="mb-1 font-medium">Policy decision</p>
            <CodeBlock code={JSON.stringify(a.policyDecision, null, 2)} language="json" maxHeight="160px" />
          </div>
        ) : null}
        {canHistory && <Link className="text-accent hover:underline" href={`${IH}/executions/${a.executionId}`}>Open the execution →</Link>}
        {a.status === "pending" && canApprove && (
          own ? (
            <p className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning">Separation of duties: you started this execution, so someone else must decide.</p>
          ) : (
            <div className="space-y-3 border-t border-border pt-3">
              <FormField id="ap-note" label="Decision note">{(f) => <Textarea {...f} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" leftIcon={<XCircle className="size-4" />} loading={pending} onClick={() => decide("reject")}>Reject</Button>
                <Button leftIcon={<CheckCircle2 className="size-4" />} loading={pending} onClick={() => decide("approve")}>Approve</Button>
              </div>
            </div>
          )
        )}
        {a.decidedAt && <p className="text-muted">Decided <LocalDate value={a.decidedAt} />{a.decisionNote ? ` — “${a.decisionNote}”` : ""}</p>}
      </div>
    </Modal>
  );
}

// ── Executions ──────────────────────────────────────────────────────────────

export function ExecutionList({ initial, nextCursor, errors, canManage }: { initial: ExecutionSummary[]; nextCursor: string | null; errors: ErrorView[]; canManage: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(nextCursor);
  const [status, setStatus] = useState("");
  const { run, pending } = useMutation();
  async function reload(next?: { status?: string; append?: boolean }) {
    const s = next?.status ?? status;
    const qs = new URLSearchParams({ limit: "50", ...(s ? { status: s } : {}), ...(next?.append && cursor ? { cursor } : {}) });
    const r = await run(() => apiFetch<{ data: ExecutionSummary[]; nextCursor: string | null }>(`${IH}/executions?${qs}`), { refresh: false });
    if (r) {
      setRows(next?.append ? [...rows, ...r.data] : r.data);
      setCursor(r.nextCursor);
    }
  }
  const columns: Array<DataTableColumn<ExecutionSummary>> = [
    { key: "what", header: "Run", cell: (e) => <span><span className="font-medium">{e.workflowName ?? `Tool: ${e.actionKey}`}</span>{e.workflowVersion ? <span className="ml-1 text-xs text-subtle">v{e.workflowVersion}</span> : null}</span> },
    { key: "status", header: "Status", cell: (e) => <StatusPill status={e.status} /> },
    { key: "trigger", header: "Trigger", hideOnMobile: true, cell: (e) => <span className="flex items-center gap-1">{e.mode === "test" && <Badge tone="info">test</Badge>}{e.trigger}{e.agent && <Badge tone="accent" icon={<Bot />}>{e.agent.id}</Badge>}</span> },
    { key: "by", header: "Actor", hideOnMobile: true, cell: (e) => <span className="text-xs">{e.actor.label}</span> },
    { key: "calls", header: "System calls", align: "right", hideOnMobile: true, cell: (e) => e.systemCalls },
    { key: "dur", header: "Duration", align: "right", cell: (e) => fmtMs(e.durationMs) },
    { key: "when", header: "Started", hideOnMobile: true, cell: (e) => <LocalDate value={e.createdAt} /> },
  ];
  const dead = errors.filter((e) => e.status === "dead_letter");
  return (
    <div className="space-y-4">
      {dead.length > 0 && (
        <Card>
          <CardHeader title={`Dead letters (${dead.length})`} description="Retryable failures that exhausted their attempts. Retry the execution from the failed step, or resolve after handling it outside the platform." />
          <DataTable
            density="compact"
            caption="Dead-lettered errors"
            rows={dead}
            getRowId={(e) => e.id}
            columns={[
              { key: "c", header: "Class", cell: (e) => <Badge tone="danger">{e.errorClass}</Badge> },
              { key: "m", header: "Message", cell: (e) => <span className="text-xs">{e.message}</span> },
              { key: "n", header: "Step", hideOnMobile: true, cell: (e) => e.nodeKey ?? "—" },
              { key: "a", header: "Attempts", align: "right", cell: (e) => e.attempts },
              { key: "x", header: "", cell: (e) => <span className="flex gap-2">{e.executionId && <Link className="text-xs text-accent hover:underline" href={`${IH}/executions/${e.executionId}`}>Open</Link>}{canManage && <ActionButton size="sm" variant="ghost" path={`${IH}/errors/${e.id}/resolve`} success="Marked resolved">Resolve</ActionButton>}</span> },
            ]}
          />
        </Card>
      )}
      <Select aria-label="Status filter" className="max-w-xs" value={status} onChange={(e) => { setStatus(e.target.value); void reload({ status: e.target.value }); }}
        options={[{ value: "", label: "All statuses" }, ...["succeeded", "failed", "partially_failed", "waiting_approval", "waiting_delay", "running", "queued", "cancelled"].map((s) => ({ value: s, label: s.replace(/_/g, " ") }))]} />
      <DataTable columns={columns} rows={rows} getRowId={(e) => e.id} onRowClick={(e) => router.push(`${IH}/executions/${e.id}`)} rowLabel={(e) => `Open execution ${e.id}`} caption="Execution history" emptyState={<p className="p-6 text-center text-sm text-muted">No executions.</p>} />
      {cursor && <Button variant="secondary" loading={pending} onClick={() => reload({ append: true })}>Load more</Button>}
    </div>
  );
}

const STEP_ICON: Record<string, typeof Cog> = { ai_step: Brain, connector_action: Cog, human_approval: ShieldAlert };

export function ExecutionDetailView({ execution: e, perms }: { execution: ExecutionDetail; perms: { manage: boolean; execute: boolean; viewerId: string } }) {
  const [open, setOpen] = useState<ExecutionDetail["steps"][number] | null>(null);
  const terminal = ["succeeded", "failed", "partially_failed", "cancelled"].includes(e.status);
  const totalCost = e.steps.reduce((n, s) => n + s.costUsd, 0);
  const retries = e.steps.filter((s) => s.attempt > 1).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={e.status} />
        {e.mode === "test" && <Badge tone="info">test mode — sandbox / dry run</Badge>}
        <Badge>trigger: {e.trigger}</Badge>
        {e.agent && <Badge tone="accent" icon={<Bot />}>agent {e.agent.id}{(e.agent as { verified?: boolean }).verified ? " (verified)" : " (claimed)"}</Badge>}
        <span className="ml-auto flex gap-2">
          {!terminal && (perms.manage || e.actor.id === perms.viewerId) && perms.execute && <ActionButton size="sm" variant="secondary" path={`${IH}/executions/${e.id}/cancel`} success="Cancelled" leftIcon={<CircleSlash className="size-4" />} confirm={{ title: "Cancel this execution?", message: "Steps already completed in external systems are not undone." }}>Cancel</ActionButton>}
          {(e.status === "failed" || e.status === "partially_failed") && perms.manage && <ActionButton size="sm" path={`${IH}/executions/${e.id}/retry`} success="Retry queued" leftIcon={<RotateCcw className="size-4" />}>Retry from failed step</ActionButton>}
        </span>
      </div>
      {e.errorMessage && <p className="rounded-md border border-danger/40 bg-danger-subtle p-3 text-sm text-danger" role="status"><strong>{e.errorClass}</strong>: {e.errorMessage}</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Duration" value={fmtMs(e.durationMs)} />
        <StatCard label="Steps" value={String(e.steps.length)} hint={retries ? `${retries} retried attempt(s)` : undefined} />
        <StatCard label="System calls" value={String(e.systemCalls)} />
        <StatCard label="AI cost" value={fmtCost(e.aiCostUsd || totalCost)} />
        <StatCard label="Started by" value={<span className="text-base">{e.actor.label}</span>} hint={e.actor.type} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Timeline" description="Every step with its input, output, system or AI call, policy decision and errors. Select a step for details." />
          <ol className="divide-y divide-border">
            {e.steps.map((s) => {
              const Icon = STEP_ICON[s.nodeType] ?? Cog;
              return (
                <li key={s.seq}>
                  <button type="button" className="ds-ring flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-hover" onClick={() => setOpen(s)}>
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded" style={{ background: NODE_META[s.nodeType]?.color ?? "var(--color-subtle)" }} aria-hidden><Icon className="size-3.5 text-white" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{s.nodeKey}</span><span className="text-xs text-subtle">{NODE_META[s.nodeType]?.label ?? s.nodeType}</span>{s.attempt > 1 && <Badge>attempt {s.attempt}</Badge>}<StatusPill status={s.status} /></span>
                      {s.errorMessage && <span className="block text-xs text-danger">{s.errorClass}: {s.errorMessage}</span>}
                      {s.systemCall ? <span className="block truncate text-xs text-muted">{summarizeCall(s.systemCall)}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{fmtMs(s.durationMs)}{s.costUsd ? ` · ${fmtCost(s.costUsd)}` : ""}</span>
                  </button>
                </li>
              );
            })}
            {e.steps.length === 0 && <li className="p-4 text-sm text-muted">No steps yet — the run is queued.</li>}
          </ol>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Input" />
            <CardBody><CodeBlock code={JSON.stringify(e.input, null, 2)} language="json" maxHeight="220px" /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Result" />
            <CardBody><CodeBlock code={JSON.stringify(e.output ?? null, null, 2)} language="json" maxHeight="220px" /></CardBody>
          </Card>
          {e.approvals.length > 0 && (
            <Card>
              <CardHeader title="Approvals" />
              <CardBody className="space-y-2 text-sm">
                {e.approvals.map((a) => (
                  <Link key={a.id} href={`${IH}/approvals?focus=${a.id}`} className="flex items-center justify-between rounded-md border border-border p-2 hover:bg-surface-hover"><span>{a.title}</span><StatusPill status={a.status} /></Link>
                ))}
              </CardBody>
            </Card>
          )}
          {e.errors.length > 0 && (
            <Card>
              <CardHeader title="Errors" />
              <CardBody className="space-y-2 text-xs">
                {e.errors.map((x) => <p key={x.id}><Badge tone={x.status === "dead_letter" ? "danger" : "warning"}>{x.status.replace("_", " ")}</Badge> <strong>{x.errorClass}</strong> at {x.nodeKey}: {x.message}</p>)}
              </CardBody>
            </Card>
          )}
          <Card>
            <CardBody className="text-xs text-muted">
              <KeyValueList items={[
                { key: "id", label: "Execution", value: <span className="font-mono">{e.id}</span> },
                { key: "created", label: "Created", value: <LocalDate value={e.createdAt} /> },
                { key: "finished", label: "Finished", value: <LocalDate value={e.finishedAt} /> },
                { key: "wf", label: "Workflow", value: e.workflowId ? <Link className="text-accent hover:underline" href={`${IH}/workflows/${e.workflowId}`}>{e.workflowName} v{e.workflowVersion}</Link> : `Tool: ${e.actionKey}` },
              ]} />
            </CardBody>
          </Card>
        </div>
      </div>
      {open && (
        <Modal open onClose={() => setOpen(null)} size="lg" title={`${open.nodeKey} — ${NODE_META[open.nodeType]?.label ?? open.nodeType}`} description={`Attempt ${open.attempt} · ${open.status} · ${fmtMs(open.durationMs)}`}>
          <div className="space-y-3 text-sm">
            {open.errorMessage && <p className="text-danger"><strong>{open.errorClass}</strong>: {open.errorMessage}</p>}
            {open.aiRunId && <p>AI run: <span className="font-mono text-xs">{open.aiRunId}</span> (shared AI run log)</p>}
            {[["Input", open.input], ["Output", open.output], ["System / AI call", open.systemCall], ["Policy decision", open.policyDecision]].filter(([, v]) => v != null).map(([label, v]) => (
              <div key={label as string}><p className="mb-1 font-medium">{label as string}</p><CodeBlock code={JSON.stringify(v, null, 2)} language="json" maxHeight="220px" /></div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function summarizeCall(c: unknown): string {
  const x = c as { connector?: string; capability?: string; operation?: string; ai?: { model?: string; inputTokens?: number; outputTokens?: number; simulated?: boolean }; compensates?: string };
  if (x.ai) return `AI ${x.ai.model ?? ""} · ${x.ai.inputTokens ?? 0}+${x.ai.outputTokens ?? 0} tokens${x.ai.simulated ? " · simulated" : ""}`;
  if (x.compensates) return `compensating ${x.compensates} via ${x.capability}`;
  return `${x.connector ?? "connector"} · ${x.capability ?? ""} · ${x.operation ?? ""}`;
}
