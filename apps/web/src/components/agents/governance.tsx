"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowUpCircle, CheckCircle2, ChevronLeft, ChevronRight, HelpCircle, Pause, Play, XCircle } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, FormField, Input, KeyValueList, Modal, Select, Switch, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type ActivityView, type AgentGovernanceService, type ApprovalView } from "@eaop/module-agent-governance";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { ACTION_TYPES, AG, EffectBadge, fmtNum, opts, StatusPill } from "./common";

// ── Approvals ───────────────────────────────────────────────────────────────

const OPEN = new Set(["pending", "escalated", "clarification_requested"]);

export function AgentApprovalQueue({ approvals, focus, canManage }: { approvals: ApprovalView[]; focus?: string; canManage: boolean }) {
  const [status, setStatus] = useState("open");
  const [open, setOpen] = useState<ApprovalView | null>(approvals.find((a) => a.id === focus) ?? null);
  const rows = approvals.filter((a) => (status === "open" ? OPEN.has(a.status) : !status || a.status === status));
  const columns: Array<DataTableColumn<ApprovalView>> = [
    { key: "a", header: "Request", cell: (a) => <span><span className="font-medium">{a.agentName} — {a.request?.action}</span><span className="block text-xs text-muted">{a.request?.actionType} on {a.request?.system}/{a.request?.resource}</span></span> },
    { key: "f", header: "Financial impact", align: "right", hideOnMobile: true, cell: (a) => (a.financialImpact == null ? "—" : `${fmtNum(a.financialImpact)} ${a.request?.currency ?? ""}`) },
    { key: "d", header: "Data", hideOnMobile: true, cell: (a) => a.dataSensitivity },
    { key: "s", header: "Status", cell: (a) => <span className="flex items-center gap-1"><StatusPill status={a.status} />{a.escalationLevel > 0 && <Badge tone="warning">L{a.escalationLevel}</Badge>}</span> },
    { key: "w", header: "Requested", hideOnMobile: true, cell: (a) => <LocalDate value={a.createdAt} /> },
    { key: "e", header: "Expires", hideOnMobile: true, cell: (a) => (OPEN.has(a.status) ? <LocalDate value={a.expiresAt} /> : "—") },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Status" className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "open", label: "Open (pending, escalated, clarifying)" }, ...opts(["approved", "rejected", "expired", "cancelled"]), { value: "", label: "All" }]} />
      <DataTable columns={columns} rows={rows} getRowId={(a) => a.id} onRowClick={setOpen} rowLabel={(a) => `Review request from ${a.agentName}`} caption="Agent approval requests" emptyState={<p className="p-6 text-center text-sm text-muted">Nothing here.</p>} />
      {open && <AgentApprovalModal approval={open} canManage={canManage} onClose={() => setOpen(null)} />}
    </div>
  );
}

function AgentApprovalModal({ approval: a, canManage, onClose }: { approval: ApprovalView; canManage: boolean; onClose: () => void }) {
  const [note, setNote] = useState("");
  const { run, pending } = useMutation();
  const policy = (a.policy ?? {}) as { effect?: string; reasons?: string[]; policies?: Array<{ key: string; version: number; effect: string }> };
  const decide = async (decision: "approve" | "reject" | "request_clarification" | "escalate") => {
    const labels = { approve: "Approved — the agent may proceed", reject: "Rejected", request_clarification: "Clarification requested from the agent", escalate: "Escalated to agent managers" };
    if (await run(() => apiFetch(`${AG}/approvals/${a.id}/decision`, { body: { decision, note: note || undefined } }), { success: labels[decision] })) onClose();
  };
  const needsManager = a.escalationLevel > 0 && !canManage;
  return (
    <Modal open onClose={onClose} size="lg" title={`${a.agentName} wants to ${a.request?.action ?? "act"}`} description={a.reason}>
      <div className="space-y-4 text-sm">
        <KeyValueList columns={2} items={[
          { key: "agent", label: "Agent", value: <Link className="text-accent hover:underline" href={`${AG}/agents/${a.agentId}`}>{a.agentName}</Link> },
          { key: "action", label: "Proposed action", value: `${a.request?.action} (${a.request?.actionType})` },
          { key: "systems", label: "Affected systems", value: a.affectedSystems.join(", ") },
          { key: "env", label: "Environment", value: a.request?.environment ?? "—" },
          { key: "fin", label: "Financial impact", value: a.financialImpact == null ? "—" : `${fmtNum(a.financialImpact)} ${a.request?.currency ?? ""}` },
          { key: "sens", label: "Data sensitivity", value: a.dataSensitivity },
          { key: "status", label: "Status", value: <StatusPill status={a.status} /> },
          { key: "exp", label: "Expires", value: <LocalDate value={a.expiresAt} /> },
        ]} />
        <div>
          <p className="mb-1 font-medium">Why approval is needed</p>
          <div className="flex items-center gap-2"><EffectBadge effect={policy.effect} />{policy.policies?.length ? <span className="text-xs text-muted">policies: {policy.policies.map((p) => `${p.key} v${p.version}`).join(", ")}</span> : null}</div>
          <ul className="mt-1 list-disc pl-5 text-muted">{(policy.reasons ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
        <div>
          <p className="mb-1 font-medium">Affected records</p>
          <CodeBlock code={JSON.stringify(a.affectedRecords ?? [], null, 2)} language="json" maxHeight="140px" />
        </div>
        <div>
          <p className="mb-1 font-medium">Supporting context</p>
          <CodeBlock code={JSON.stringify(a.supportingContext ?? {}, null, 2)} language="json" maxHeight="180px" />
        </div>
        {a.conversation.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Conversation</p>
            <ol className="space-y-1">{a.conversation.map((c, i) => <li key={i} className="rounded-md border border-border p-2"><span className="text-xs text-muted">{c.by} · {c.kind.replace(/_/g, " ")} · <LocalDate value={c.at} /></span><p>{c.message}</p></li>)}</ol>
          </div>
        )}
        {OPEN.has(a.status) && (
          <div className="space-y-3 border-t border-border pt-3">
            {needsManager && <p className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning">Escalated: approving or rejecting needs agent.manage. You can still ask for clarification or escalate further.</p>}
            {a.status === "clarification_requested" && <p className="text-muted">Waiting for the agent to answer. You can still decide now.</p>}
            <FormField id="aa-note" label="Note to the agent / audit trail">{(f) => <Textarea {...f} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" leftIcon={<HelpCircle className="size-4" />} loading={pending} disabled={!note.trim()} title={note.trim() ? undefined : "Write your question in the note"} onClick={() => decide("request_clarification")}>Ask for clarification</Button>
              <Button variant="ghost" leftIcon={<ArrowUpCircle className="size-4" />} loading={pending} onClick={() => decide("escalate")}>Escalate</Button>
              <Button variant="secondary" leftIcon={<XCircle className="size-4" />} loading={pending} disabled={needsManager} onClick={() => decide("reject")}>Reject</Button>
              <Button leftIcon={<CheckCircle2 className="size-4" />} loading={pending} disabled={needsManager} onClick={() => decide("approve")}>Approve</Button>
            </div>
          </div>
        )}
        {a.decidedAt && <p className="text-muted">Decided <LocalDate value={a.decidedAt} />{a.decisionNote ? ` — “${a.decisionNote}”` : ""}</p>}
      </div>
    </Modal>
  );
}

// ── Audit replay ────────────────────────────────────────────────────────────

export type SessionRow = Awaited<ReturnType<AgentGovernanceService["listSessions"]>>[number];
export type SessionDetail = Awaited<ReturnType<AgentGovernanceService["getSession"]>>;
export interface ReplayFilters { agentId?: string; userId?: string; system?: string; action?: string; decision?: string; from?: string; to?: string; incidentId?: string }

export function ReplayBrowser({ sessions, filters, agents, users, incidents, activity }: { sessions: SessionRow[]; filters: ReplayFilters; agents: Array<{ id: string; name: string }>; users: Array<{ userId: string; name: string }>; incidents: Array<{ id: string; title: string }>; activity: Array<ActivityView & { agentName: string }> }) {
  const router = useRouter();
  const [f, setF] = useState<ReplayFilters>(filters);
  const apply = () => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as Array<[string, string]>);
    router.push(`${AG}/activity${q.size ? `?${q}` : ""}`);
  };
  const set = (k: keyof ReplayFilters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined });
  const columns: Array<DataTableColumn<SessionRow>> = [
    { key: "a", header: "Agent", cell: (s) => <span className="font-medium">{s.agentName}</span> },
    { key: "i", header: "Instruction", hideOnMobile: true, cell: (s) => <span className="line-clamp-1 text-xs text-muted">{s.instruction ?? "—"}</span> },
    { key: "u", header: "On behalf of", hideOnMobile: true, cell: (s) => s.onBehalfOf ?? "—" },
    { key: "s", header: "Status", cell: (s) => <StatusPill status={s.status} /> },
    { key: "e", header: "Events", align: "right", cell: (s) => <span>{s.events}{s.denied ? <Badge className="ml-1" tone="danger">{s.denied} denied</Badge> : null}</span> },
    { key: "t", header: "Started", cell: (s) => <LocalDate value={s.startedAt} /> },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Filters" />
        <CardBody>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Select aria-label="Agent" value={f.agentId ?? ""} onChange={set("agentId")} options={[{ value: "", label: "All agents" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
            <Select aria-label="User" value={f.userId ?? ""} onChange={set("userId")} options={[{ value: "", label: "Any user" }, ...users.map((u) => ({ value: u.userId, label: u.name }))]} />
            <Input aria-label="System" placeholder="System, e.g. stripe" value={f.system ?? ""} onChange={set("system")} />
            <Select aria-label="Action type" value={f.action ?? ""} onChange={set("action")} options={[{ value: "", label: "Any action" }, ...opts(ACTION_TYPES)]} />
            <Select aria-label="Policy result" value={f.decision ?? ""} onChange={set("decision")} options={[{ value: "", label: "Any policy result" }, ...["ALLOW", "REQUIRE_APPROVAL", "ESCALATE", "DENY"].map((x) => ({ value: x, label: x.replace("_", " ").toLowerCase() }))]} />
            <Select aria-label="Incident" value={f.incidentId ?? ""} onChange={set("incidentId")} options={[{ value: "", label: "Any incident" }, ...incidents.map((i) => ({ value: i.id, label: i.title }))]} />
            <Input aria-label="From date" type="date" value={f.from ?? ""} onChange={set("from")} />
            <Input aria-label="To date" type="date" value={f.to ?? ""} onChange={set("to")} />
          </div>
          <div className="mt-3 flex gap-2"><Button size="sm" onClick={apply}>Apply</Button><Button size="sm" variant="ghost" onClick={() => router.push(`${AG}/activity`)}>Reset</Button></div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Sessions" description="Open a session to replay it step by step." />
        <DataTable columns={columns} rows={sessions} getRowId={(s) => s.id} onRowClick={(s) => router.push(`${AG}/activity/${s.id}`)} rowLabel={(s) => `Replay session of ${s.agentName}`} caption="Agent sessions" emptyState={<p className="p-6 text-center text-sm text-muted">No sessions match.</p>} />
      </Card>
      <Card>
        <CardHeader title="Latest activity" description="Includes Integration tool calls and platform decisions outside sessions." />
        <CardBody className="space-y-1">
          {activity.length === 0 && <p className="text-sm text-muted">No activity.</p>}
          {activity.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 border-b border-border py-1.5 text-sm last:border-0">
              <span className="w-40 shrink-0 text-xs text-muted"><LocalDate value={x.occurredAt} /></span>
              <span className="w-32 shrink-0 truncate font-medium">{x.agentName}</span>
              <Badge>{x.kind.replace(/_/g, " ")}</Badge>
              {x.decision && <EffectBadge effect={x.decision} />}
              <span className="min-w-0 flex-1 truncate">{x.summary}</span>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

export function SessionPlayer({ session: s }: { session: SessionDetail }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const steps = s.steps;
  const step = steps[i];
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setI((n) => {
      if (n >= steps.length - 1) {
        setPlaying(false);
        return n;
      }
      return n + 1;
    }), 900);
    return () => clearInterval(t);
  }, [playing, steps.length]);
  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <KeyValueList columns={2} items={[
            { key: "agent", label: "Agent", value: <Link className="text-accent hover:underline" href={`${AG}/agents/${s.agentId}`}>{s.agentName}</Link> },
            { key: "user", label: "On behalf of", value: s.onBehalfOf ?? "—" },
            { key: "status", label: "Status", value: <StatusPill status={s.status} /> },
            { key: "time", label: "Started / ended", value: <><LocalDate value={s.startedAt} /> → <LocalDate value={s.endedAt} /></> },
            { key: "instr", label: "Instruction", value: s.instruction ?? "—" },
          ]} />
        </CardBody>
      </Card>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title={`Timeline (${steps.length})`} />
          <CardBody className="max-h-[520px] space-y-1 overflow-auto">
            {steps.length === 0 && <p className="text-sm text-muted">No events recorded.</p>}
            {steps.map((x, n) => (
              <button key={x.id} type="button" onClick={() => setI(n)} aria-current={n === i ? "step" : undefined} className={`flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm ${n === i ? "bg-accent-subtle" : "hover:bg-surface-hover"}`}>
                <span className="w-6 text-xs text-muted">{n + 1}</span>
                <Badge>{x.kind.replace(/_/g, " ")}</Badge>
                <span className="min-w-0 flex-1 truncate">{x.summary}</span>
              </button>
            ))}
          </CardBody>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader
            title={step ? `Step ${i + 1} of ${steps.length}` : "Replay"}
            actions={
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" aria-label="Previous step" disabled={i === 0} onClick={() => setI(i - 1)}><ChevronLeft className="size-4" /></Button>
                <Button size="sm" variant="secondary" aria-label={playing ? "Pause" : "Play"} disabled={!playing && i >= steps.length - 1} onClick={() => setPlaying(!playing)}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</Button>
                <Button size="sm" variant="ghost" aria-label="Next step" disabled={i >= steps.length - 1} onClick={() => setI(i + 1)}><ChevronRight className="size-4" /></Button>
              </div>
            }
          />
          <CardBody className="space-y-3 text-sm">
            {step ? (
              <>
                <KeyValueList columns={2} items={[
                  { key: "kind", label: "Kind", value: step.kind.replace(/_/g, " ") },
                  { key: "when", label: "Time", value: <LocalDate value={step.occurredAt} /> },
                  { key: "src", label: "Source", value: step.source },
                  { key: "dec", label: "Decision", value: <EffectBadge effect={step.decision} /> },
                  { key: "sys", label: "System / resource", value: `${step.system ?? "—"} / ${step.resource ?? "—"}` },
                  { key: "act", label: "Action type", value: step.actionType ?? "—" },
                ]} />
                <p>{step.summary}</p>
                <CodeBlock code={JSON.stringify(step.detail ?? {}, null, 2)} language="json" maxHeight="260px" />
              </>
            ) : <p className="text-muted">Nothing to replay.</p>}
          </CardBody>
        </Card>
      </div>
      {s.requests.length > 0 && (
        <Card>
          <CardHeader title="Action requests in this session" />
          <CardBody className="space-y-1">
            {s.requests.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm"><EffectBadge effect={r.decision} /><StatusPill status={r.status} /><span className="flex-1">{r.action} ({r.actionType}) on {r.system}/{r.resource}{r.amount != null ? ` · ${fmtNum(r.amount)} ${r.currency ?? ""}` : ""}</span><span className="text-xs text-muted"><LocalDate value={r.createdAt} /></span></div>)}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// ── Incidents ───────────────────────────────────────────────────────────────

export type IncidentRow = Awaited<ReturnType<AgentGovernanceService["listIncidents"]>>[number];

export function IncidentList({ incidents, focus, canManage, canAudit }: { incidents: IncidentRow[]; focus?: string; canManage: boolean; canAudit: boolean }) {
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<IncidentRow | null>(incidents.find((i) => i.id === focus) ?? null);
  const rows = incidents.filter((i) => !status || i.status === status);
  const columns: Array<DataTableColumn<IncidentRow>> = [
    { key: "t", header: "Incident", cell: (i) => <span><span className="font-medium">{i.title}</span><span className="block text-xs text-muted">{i.agentName} · {i.kind.replace("_", " ")}</span></span> },
    { key: "sev", header: "Severity", cell: (i) => <Badge tone={i.severity === "critical" ? "danger" : i.severity === "high" ? "warning" : "neutral"}>{i.severity}</Badge> },
    { key: "s", header: "Status", cell: (i) => <StatusPill status={i.status} /> },
    { key: "w", header: "Opened", hideOnMobile: true, cell: (i) => <LocalDate value={i.createdAt} /> },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Status" className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "All" }, ...opts(["open", "investigating", "resolved"])]} />
      <DataTable columns={columns} rows={rows} getRowId={(i) => i.id} onRowClick={setOpen} rowLabel={(i) => `Open incident ${i.title}`} caption="Agent incidents" emptyState={<p className="p-6 text-center text-sm text-muted">No incidents.</p>} />
      {open && <IncidentModal i={open} canManage={canManage} canAudit={canAudit} onClose={() => setOpen(null)} />}
    </div>
  );
}

function IncidentModal({ i, canManage, canAudit, onClose }: { i: IncidentRow; canManage: boolean; canAudit: boolean; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [resolution, setResolution] = useState("");
  const set = async (status: "investigating" | "resolved") => { if (await run(() => apiFetch(`${AG}/incidents/${i.id}`, { method: "PATCH", body: { status, resolution: resolution || undefined } }), { success: `Incident ${status}` })) onClose(); };
  return (
    <Modal open onClose={onClose} size="lg" title={i.title} description={i.description}>
      <div className="space-y-3 text-sm">
        <KeyValueList columns={2} items={[
          { key: "agent", label: "Agent", value: <Link className="text-accent hover:underline" href={`${AG}/agents/${i.agentId}`}>{i.agentName}</Link> },
          { key: "kind", label: "Kind", value: i.kind.replace("_", " ") },
          { key: "sev", label: "Severity", value: i.severity },
          { key: "st", label: "Status", value: <StatusPill status={i.status} /> },
        ]} />
        {i.actionsTaken.length > 0 && <div><p className="mb-1 font-medium">Actions taken</p><ul className="list-disc pl-5">{(i.actionsTaken as Array<{ action: string; detail?: string; at: string; by: string }>).map((x, n) => <li key={n}>{x.action.replace("_", " ")}{x.detail ? ` — ${x.detail}` : ""} <span className="text-xs text-muted">({x.by})</span></li>)}</ul></div>}
        {i.resolution && <p><span className="font-medium">Resolution:</span> {i.resolution}</p>}
        {canAudit && <Link className="text-accent hover:underline" href={`${AG}/activity?incidentId=${i.id}`}>Replay activity around this incident →</Link>}
        {canManage && i.status !== "resolved" && (
          <div className="space-y-2 border-t border-border pt-3">
            <FormField id="inc-res" label="Resolution">{(f) => <Textarea {...f} rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} />}</FormField>
            <div className="flex justify-end gap-2">
              {i.status === "open" && <Button variant="secondary" loading={pending} onClick={() => set("investigating")}>Mark investigating</Button>}
              <Button loading={pending} onClick={() => set("resolved")}>Resolve</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Reviews ─────────────────────────────────────────────────────────────────

export type ReviewRow = Awaited<ReturnType<AgentGovernanceService["listReviews"]>>[number];

export function ReviewList({ reviews, focus, viewerId, canManage }: { reviews: ReviewRow[]; focus?: string; viewerId: string; canManage: boolean }) {
  const [status, setStatus] = useState("scheduled");
  const [open, setOpen] = useState<ReviewRow | null>(reviews.find((r) => r.id === focus) ?? null);
  const rows = reviews.filter((r) => !status || r.status === status);
  const columns: Array<DataTableColumn<ReviewRow>> = [
    { key: "a", header: "Agent", cell: (r) => <span className="font-medium">{r.agentName}</span> },
    { key: "o", header: "Review owner", hideOnMobile: true, cell: (r) => r.reviewOwnerName ?? "—" },
    { key: "d", header: "Due", cell: (r) => <span className={r.overdue ? "text-danger" : ""}><LocalDate value={r.dueAt} dateOnly />{r.overdue ? " (overdue)" : ""}</span> },
    { key: "s", header: "Status", cell: (r) => <StatusPill status={r.status} /> },
    { key: "out", header: "Outcome", hideOnMobile: true, cell: (r) => r.outcome?.replace("_", " ") ?? "—" },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Status" className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[...opts(["scheduled", "completed", "cancelled"]), { value: "", label: "All" }]} />
      <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} onRowClick={setOpen} rowLabel={(r) => `Open review of ${r.agentName}`} caption="Agent reviews" emptyState={<p className="p-6 text-center text-sm text-muted">No reviews.</p>} />
      {open && <ReviewModal r={open} canComplete={open.status === "scheduled" && (canManage || open.reviewOwnerUserId === viewerId)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ReviewModal({ r, canComplete, onClose }: { r: ReviewRow; canComplete: boolean; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ purposeValid: true, permissionsValid: true, systemsRequired: true, riskStatus: "", outcome: "approved", notes: "" });
  const go = async () => { if (await run(() => apiFetch(`${AG}/reviews/${r.id}/complete`, { body: { ...f, notes: f.notes || undefined } }), { success: "Review completed" })) onClose(); };
  const toggle = (k: "purposeValid" | "permissionsValid" | "systemsRequired", label: string) => <div className="flex items-center gap-2"><Switch checked={f[k]} onCheckedChange={(v) => setF({ ...f, [k]: v })} aria-label={label} /><span>{label}</span></div>;
  return (
    <Modal open onClose={onClose} title={`Review: ${r.agentName}`} description={<>Due <LocalDate value={r.dueAt} dateOnly /> · owner {r.reviewOwnerName ?? "—"}</>} footer={canComplete ? <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.riskStatus.trim()} onClick={go}>Complete review</Button></div> : undefined}>
      {canComplete ? (
        <div className="grid gap-3 text-sm">
          {toggle("purposeValid", "Business purpose is still valid")}
          {toggle("permissionsValid", "Permissions are still appropriate")}
          {toggle("systemsRequired", "Connected systems are still required")}
          <FormField id="rv-risk" label="Risk status" required>{(x) => <Input {...x} value={f.riskStatus} onChange={(e) => setF({ ...f, riskStatus: e.target.value })} placeholder="e.g. acceptable, elevated" />}</FormField>
          <FormField id="rv-out" label="Outcome" hint="Restricted limits the agent to READ; retired stops it permanently">{(x) => <Select {...x} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} options={opts(["approved", "changes_required", "restricted", "retired"])} />}</FormField>
          <FormField id="rv-notes" label="Notes">{(x) => <Textarea {...x} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</FormField>
        </div>
      ) : (
        <KeyValueList items={[
          { key: "s", label: "Status", value: <StatusPill status={r.status} /> },
          { key: "o", label: "Outcome", value: r.outcome?.replace("_", " ") ?? "—" },
          { key: "p", label: "Purpose valid", value: r.purposeValid == null ? "—" : r.purposeValid ? "Yes" : "No" },
          { key: "pe", label: "Permissions valid", value: r.permissionsValid == null ? "—" : r.permissionsValid ? "Yes" : "No" },
          { key: "sy", label: "Systems required", value: r.systemsRequired == null ? "—" : r.systemsRequired ? "Yes" : "No" },
          { key: "r", label: "Risk status", value: r.riskStatus ?? "—" },
          { key: "n", label: "Notes", value: r.notes ?? "—" },
        ]} />
      )}
    </Modal>
  );
}
