"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bot, Plus } from "lucide-react";
import { Button, DataTable, EmptyState, FormField, Input, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type AgentSummary } from "@eaop/module-agent-governance";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { AG, AUTONOMY, ENVIRONMENTS, opts, RiskBadge, StatusPill } from "./common";

export interface MemberOption { userId: string; name: string; email: string }

export function AgentInventory({ agents, initialStatus, canRegister, members }: { agents: AgentSummary[]; initialStatus?: string; canRegister: boolean; members: MemberOption[] }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus ?? "");
  const [env, setEnv] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const needle = q.trim().toLowerCase();
  const rows = agents.filter((a) => (!status || a.status === status) && (!env || a.environment === env) && (!needle || `${a.name} ${a.department ?? ""} ${a.ownerName ?? ""} ${a.provider ?? ""}`.toLowerCase().includes(needle)));
  const columns: Array<DataTableColumn<AgentSummary>> = [
    { key: "name", header: "Agent", sortable: true, sortValue: (a) => a.name, cell: (a) => <span><span className="font-medium">{a.name}</span><span className="block text-xs text-muted">{a.department ?? "No department"} · {a.provider ? `${a.provider}${a.model ? ` / ${a.model}` : ""}` : "provider not set"}</span></span> },
    { key: "status", header: "Status", sortable: true, sortValue: (a) => a.status, cell: (a) => <StatusPill status={a.status} quarantined={a.quarantined} /> },
    { key: "owner", header: "Owner", hideOnMobile: true, cell: (a) => (a.ownerName ?? <span className="text-danger">No owner</span>) },
    { key: "env", header: "Environment", hideOnMobile: true, cell: (a) => a.environment },
    { key: "aut", header: "Autonomy", hideOnMobile: true, cell: (a) => a.autonomyLevel.replace("_", " ") },
    { key: "risk", header: "Risk", sortable: true, sortValue: (a) => a.riskScore ?? -1, cell: (a) => <RiskBadge band={a.riskBand} score={a.riskScore} /> },
    { key: "sys", header: "Systems", hideOnMobile: true, cell: (a) => <span className="text-xs">{a.connectedSystems.slice(0, 3).join(", ") || "—"}{a.connectedSystems.length > 3 ? ` +${a.connectedSystems.length - 3}` : ""}</span> },
    { key: "last", header: "Last activity", hideOnMobile: true, sortable: true, sortValue: (a) => a.lastActivityAt ?? "", cell: (a) => <LocalDate value={a.lastActivityAt} /> },
    { key: "rev", header: "Last review", hideOnMobile: true, cell: (a) => <LocalDate value={a.lastReviewAt} dateOnly /> },
    { key: "reg", header: "Registered", hideOnMobile: true, cell: (a) => <LocalDate value={a.createdAt} dateOnly /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input aria-label="Search agents" placeholder="Search name, department, owner…" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "All statuses" }, ...opts(["unknown", "pending", "approved", "restricted", "suspended", "retired"])]} />
        <Select aria-label="Environment" className="w-40" value={env} onChange={(e) => setEnv(e.target.value)} options={[{ value: "", label: "All environments" }, ...opts(ENVIRONMENTS)]} />
        <span className="flex-1" />
        {canRegister && <Button leftIcon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Register agent</Button>}
      </div>
      <DataTable
        columns={columns} rows={rows} getRowId={(a) => a.id} onRowClick={(a) => router.push(`${AG}/agents/${a.id}`)} rowLabel={(a) => `Open ${a.name}`} caption="Agent inventory" defaultSort={{ key: "name", direction: "asc" }}
        emptyState={<EmptyState icon={<Bot className="size-6" />} title={agents.length ? "No agents match" : "No agents yet"} description={agents.length ? "Change the filters." : "Register the AI agents that act in your organization. Agents seen on the Integration tool gateway are discovered automatically as unknown."} />}
      />
      {open && <RegisterAgentModal members={members} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RegisterAgentModal({ members, onClose }: { members: MemberOption[]; onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: "", description: "", ownerUserId: "", department: "", businessPurpose: "", environment: "development", provider: "", model: "", autonomyLevel: "supervised", riskCategory: "medium", connectedSystems: "", customerImpact: "", regulatoryImpact: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const body = {
      name: f.name, description: f.description, ownerUserId: f.ownerUserId || null, department: f.department || null, businessPurpose: f.businessPurpose, environment: f.environment,
      provider: f.provider || null, model: f.model || null, autonomyLevel: f.autonomyLevel, riskCategory: f.riskCategory,
      connectedSystems: f.connectedSystems.split(",").map((s) => s.trim()).filter(Boolean), customerImpact: f.customerImpact ? Number(f.customerImpact) : null, regulatoryImpact: f.regulatoryImpact ? Number(f.regulatoryImpact) : null,
    };
    const a = await run(() => apiFetch<{ id: string }>(`${AG}/agents`, { body }), { success: "Agent registered — pending approval", refresh: false });
    if (a) router.push(`${AG}/agents/${a.id}`);
  };
  const impact = [{ value: "", label: "Not rated" }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}` }))];
  return (
    <Modal open onClose={onClose} size="lg" title="Register an AI agent" description="New agents start as pending. Someone other than you must approve it, and it needs an owner first." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name.trim()} onClick={submit}>Register</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="ag-name" label="Name" required>{(a) => <Input {...a} value={f.name} onChange={set("name")} maxLength={120} />}</FormField>
        <FormField id="ag-owner" label="Owner">{(a) => <Select {...a} value={f.ownerUserId} onChange={set("ownerUserId")} options={[{ value: "", label: "No owner yet" }, ...members.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` }))]} />}</FormField>
        <FormField id="ag-dept" label="Department">{(a) => <Input {...a} value={f.department} onChange={set("department")} />}</FormField>
        <FormField id="ag-env" label="Environment">{(a) => <Select {...a} value={f.environment} onChange={set("environment")} options={opts(ENVIRONMENTS)} />}</FormField>
        <FormField id="ag-provider" label="Provider">{(a) => <Input {...a} value={f.provider} onChange={set("provider")} placeholder="e.g. internal, vendor name" />}</FormField>
        <FormField id="ag-model" label="Model">{(a) => <Input {...a} value={f.model} onChange={set("model")} />}</FormField>
        <FormField id="ag-aut" label="Autonomy level">{(a) => <Select {...a} value={f.autonomyLevel} onChange={set("autonomyLevel")} options={opts(AUTONOMY)} />}</FormField>
        <FormField id="ag-risk" label="Risk category">{(a) => <Select {...a} value={f.riskCategory} onChange={set("riskCategory")} options={opts(["low", "medium", "high", "critical"])} />}</FormField>
        <FormField id="ag-cust" label="Customer impact (1–5)">{(a) => <Select {...a} value={f.customerImpact} onChange={set("customerImpact")} options={impact} />}</FormField>
        <FormField id="ag-reg" label="Regulatory impact (1–5)">{(a) => <Select {...a} value={f.regulatoryImpact} onChange={set("regulatoryImpact")} options={impact} />}</FormField>
        <FormField id="ag-sys" label="Connected systems" hint="Comma-separated, e.g. stripe, salesforce" className="sm:col-span-2">{(a) => <Input {...a} value={f.connectedSystems} onChange={set("connectedSystems")} />}</FormField>
        <FormField id="ag-purpose" label="Business purpose" className="sm:col-span-2">{(a) => <Textarea {...a} rows={2} value={f.businessPurpose} onChange={set("businessPurpose")} />}</FormField>
        <FormField id="ag-desc" label="Description" className="sm:col-span-2">{(a) => <Textarea {...a} rows={2} value={f.description} onChange={set("description")} />}</FormField>
      </div>
    </Modal>
  );
}
