"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { Button, Card, CardBody, CardHeader, DataTable, FormField, Input, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { human, OPS, opts, StatusPill, usd } from "./common";

type Req = Awaited<ReturnType<AiOpsService["listRequests"]>>[number];
type ReqDetail = Awaited<ReturnType<AiOpsService["getRequest"]>>;
const KINDS = ["tool", "automation", "model", "agent", "integration", "use_case"] as const;
const KIND_LABEL: Record<string, string> = { tool: "New AI tool", automation: "New automation", model: "New model", agent: "New agent", integration: "New integration", use_case: "New use case" };

export function RequestList({ requests, all, initialStage }: { requests: Req[]; all: boolean; initialStage?: string }) {
  const router = useRouter();
  const [stage, setStage] = useState(initialStage ?? "open");
  const [create, setCreate] = useState(false);
  const rows = requests.filter((r) => (stage === "open" ? !["rejected", "closed"].includes(r.stage) : !stage || r.stage === stage));
  const columns: Array<DataTableColumn<Req>> = [
    { key: "t", header: "Request", cell: (r) => <span><span className="font-medium">{r.title}</span><span className="block text-xs text-muted">{KIND_LABEL[r.kind]}{r.department ? ` · ${r.department}` : ""}</span></span> },
    { key: "s", header: "Stage", cell: (r) => <span><StatusPill status={r.stage} />{r.changesRequested ? <span className="block text-xs text-warning">changes requested</span> : null}</span> },
    ...(all ? [{ key: "r", header: "Requester", hideOnMobile: true, cell: (r: Req) => r.requester ?? "—" }] : []),
    { key: "c", header: "Est. cost / value", hideOnMobile: true, cell: (r) => <span className="text-xs">{usd(r.estimatedAnnualCost)} / {usd(r.expectedAnnualValue)}</span> },
    { key: "u", header: "Updated", hideOnMobile: true, cell: (r) => <LocalDate value={r.updatedAt} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Stage" className="w-56" value={stage} onChange={(e) => setStage(e.target.value)} options={[{ value: "open", label: "Open" }, ...opts(["submitted", "business_review", "security_review", "technical_review", "financial_review", "approved", "implementation", "measurement", "rejected", "closed"]), { value: "", label: "All" }]} />
        <span className="flex-1" />
        <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreate(true)}>New request</Button>
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} onRowClick={(r) => router.push(`${OPS}/requests/${r.id}`)} rowLabel={(r) => `Open ${r.title}`} caption="AI requests" emptyState={<p className="p-6 text-center text-sm text-muted">No requests.</p>} />
      {create && <RequestForm onClose={() => setCreate(false)} />}
    </div>
  );
}

function RequestForm({ r, onClose }: { r?: ReqDetail; onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [f, setF] = useState({ kind: r?.kind ?? "tool", title: r?.title ?? "", description: r?.description ?? "", businessJustification: r?.businessJustification ?? "", department: r?.department ?? "", dataClassification: r?.dataClassification ?? "internal", estimatedAnnualCost: String(r?.estimatedAnnualCost ?? ""), expectedAnnualValue: String(r?.expectedAnnualValue ?? ""), vendorName: r?.vendorName ?? "" });
  const go = async () => {
    const body = { ...f, department: f.department || null, vendorName: f.vendorName || null, estimatedAnnualCost: Number(f.estimatedAnnualCost) || 0, expectedAnnualValue: Number(f.expectedAnnualValue) || 0 };
    const res = await run(() => apiFetch<{ id: string }>(r ? `${OPS}/requests/${r.id}` : `${OPS}/requests`, { method: r ? "PATCH" : "POST", body }), { success: r ? "Request updated" : "Request submitted", refresh: !!r });
    if (res) {
      onClose();
      if (!r) router.push(`${OPS}/requests/${res.id}`);
    }
  };
  return (
    <Modal open onClose={onClose} title={r ? "Edit request" : "Request something new"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={f.title.trim().length < 3} onClick={go}>{r ? "Save" : "Submit"}</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="rq-kind" label="What do you need?">{(x) => <Select {...x} disabled={!!r} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })} options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k]! }))} />}</FormField>
        <FormField id="rq-title" label="Title">{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
        <FormField id="rq-just" label="Business problem and justification" className="sm:col-span-2">{(x) => <Textarea {...x} rows={3} value={f.businessJustification} onChange={(e) => setF({ ...f, businessJustification: e.target.value })} />}</FormField>
        <FormField id="rq-desc" label="Details (systems, data, who would use it)" className="sm:col-span-2">{(x) => <Textarea {...x} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
        <FormField id="rq-class" label="Most sensitive data involved">{(x) => <Select {...x} value={f.dataClassification} onChange={(e) => setF({ ...f, dataClassification: e.target.value as typeof f.dataClassification })} options={opts(["public", "internal", "confidential", "restricted"])} />}</FormField>
        <FormField id="rq-vendor" label="Vendor (if known)">{(x) => <Input {...x} value={f.vendorName} onChange={(e) => setF({ ...f, vendorName: e.target.value })} />}</FormField>
        <FormField id="rq-cost" label="Estimated annual cost (USD)">{(x) => <Input {...x} type="number" value={f.estimatedAnnualCost} onChange={(e) => setF({ ...f, estimatedAnnualCost: e.target.value })} />}</FormField>
        <FormField id="rq-value" label="Expected annual value (USD)">{(x) => <Input {...x} type="number" value={f.expectedAnnualValue} onChange={(e) => setF({ ...f, expectedAnnualValue: e.target.value })} />}</FormField>
        <FormField id="rq-dept" label="Department" hint="Defaults to yours">{(x) => <Input {...x} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />}</FormField>
      </div>
      <p className="mt-2 text-xs text-muted">Requests go through business, security, technical and financial review before approval.</p>
    </Modal>
  );
}

export function RequestDetailView({ r, members }: { r: ReqDetail; members: Array<{ userId: string; name: string }> }) {
  const { run, pending } = useMutation();
  const [notes, setNotes] = useState("");
  const [decision, setDecision] = useState("approve");
  const [outcome, setOutcome] = useState("");
  const [value, setValue] = useState("");
  const [assignee, setAssignee] = useState(r.assigneeUserId ?? "");
  const [edit, setEdit] = useState(false);
  const act = (body: Record<string, unknown>, success: string) => run(() => apiFetch(`${OPS}/requests/${r.id}/actions`, { body: { notes, ...body } }), { success }).then((x) => { if (x) setNotes(""); });
  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Request progress">
        {r.progress.map((p) => (
          <li key={p.stage} className={`flex items-center gap-1 rounded-full border px-2 py-1 ${p.state === "current" ? "border-accent bg-accent-subtle font-medium text-accent" : p.state === "done" ? "border-success/40 text-success" : "border-border text-muted"}`}>
            {p.state === "done" && <Check className="size-3" aria-hidden />}{human(p.stage)}
          </li>
        ))}
      </ol>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Request" actions={r.can.edit ? <Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Edit</Button> : undefined} />
          <CardBody>
            <KeyValueList columns={2} items={[
              { key: "k", label: "Type", value: KIND_LABEL[r.kind] }, { key: "rq", label: "Requested by", value: r.requester ?? "—" },
              { key: "d", label: "Department", value: r.department ?? "—" }, { key: "dc", label: "Data", value: r.dataClassification },
              { key: "c", label: "Estimated annual cost", value: usd(r.estimatedAnnualCost) }, { key: "v", label: "Expected annual value", value: usd(r.expectedAnnualValue) },
              { key: "vn", label: "Vendor", value: r.vendorName ?? "—" }, { key: "as", label: "Assigned to", value: r.assignee ?? "—" },
              { key: "j", label: "Justification", value: r.businessJustification || "—" }, { key: "ds", label: "Details", value: r.description || "—" },
              ...(r.outcome ? [{ key: "o", label: "Outcome", value: r.outcome }] : []),
              ...(r.toolId ? [{ key: "t", label: "Tool", value: <a className="text-accent hover:underline" href={`${OPS}/tools/${r.toolId}`}>Open in inventory</a> }] : []),
            ]} />
            {r.changesRequested && <p className="mt-3 text-sm text-warning">The reviewers asked for changes. Update the request and resubmit.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Next step" />
          <CardBody className="space-y-3">
            {(r.can.review || r.can.startReview || r.can.implement || r.can.measure || r.can.close || r.can.withdraw || (r.can.edit && r.changesRequested)) ? (
              <FormField id="rd-notes" label="Notes">{(x) => <Textarea {...x} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}</FormField>
            ) : <p className="text-sm text-muted">Nothing for you to do at this stage.</p>}
            {r.can.startReview && (
              <div className="space-y-2">
                <FormField id="rd-assignee" label="Assign reviewer">{(x) => <Select {...x} value={assignee} onChange={(e) => setAssignee(e.target.value)} options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.userId, label: m.name }))]} />}</FormField>
                <Button loading={pending} onClick={() => act({ action: "start_review", assigneeUserId: assignee || null }, "Review started")}>Start business review</Button>
              </div>
            )}
            {r.can.review && (
              <div className="space-y-2">
                <FormField id="rd-decision" label={`${human(r.stage)} decision`}>{(x) => <Select {...x} value={decision} onChange={(e) => setDecision(e.target.value)} options={[{ value: "approve", label: "Approve — next stage" }, { value: "not_applicable", label: "Not applicable — skip with reason" }, { value: "request_changes", label: "Request changes" }, { value: "reject", label: "Reject" }]} />}</FormField>
                <Button loading={pending} disabled={decision !== "approve" && !notes.trim()} onClick={() => act({ action: "review", decision }, "Decision recorded")}>Record decision</Button>
              </div>
            )}
            {r.can.implement && <Button loading={pending} onClick={() => act({ action: "start_implementation" }, "Implementation started")}>Start implementation{r.kind === "tool" && !r.toolId ? " (adds the tool to the inventory)" : ""}</Button>}
            {r.can.measure && (
              <div className="space-y-2">
                <FormField id="rd-outcome" label="Outcome">{(x) => <Textarea {...x} rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)} />}</FormField>
                <FormField id="rd-value" label="Measured annual value (USD)" hint="Optional; recorded as measured value">{(x) => <Input {...x} type="number" value={value} onChange={(e) => setValue(e.target.value)} />}</FormField>
                <Button loading={pending} onClick={() => act({ action: "start_measurement", outcome: outcome || undefined, realizedAnnualValue: value ? Number(value) : undefined }, "Measurement started")}>Move to measurement</Button>
              </div>
            )}
            {r.can.close && <Button variant="secondary" loading={pending} onClick={() => act({ action: "close" }, "Request closed")}>Close request</Button>}
            {r.can.edit && r.changesRequested && <Button loading={pending} onClick={() => act({ action: "resubmit" }, "Resubmitted")}>Resubmit</Button>}
            {r.can.withdraw && <Button variant="ghost" loading={pending} onClick={() => act({ action: "withdraw" }, "Request withdrawn")}>Withdraw</Button>}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="History" />
        <CardBody className="space-y-2">
          {r.history.map((h) => (
            <div key={h.id} className="flex flex-wrap gap-3 border-b border-border pb-2 text-sm last:border-0">
              <span className="w-40 shrink-0 text-xs text-muted"><LocalDate value={h.createdAt} /></span>
              <span className="w-56 shrink-0 text-xs font-medium">{human(h.action)}{h.decision ? ` — ${human(h.decision)}` : ""}{h.fromStage !== h.toStage ? ` (${human(h.fromStage)} → ${human(h.toStage)})` : ""}</span>
              <span className="min-w-0 flex-1">{h.notes}<span className="block text-xs text-muted">{h.actorLabel}</span></span>
            </div>
          ))}
        </CardBody>
      </Card>
      {edit && <RequestForm r={r} onClose={() => setEdit(false)} />}
    </div>
  );
}
