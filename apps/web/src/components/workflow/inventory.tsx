"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Database, FileUp, Plus, Sparkles } from "lucide-react";
import {
  Badge, Button, DataTable, Drawer, DropdownMenu, FilterBar, FormField, Input, Modal, Select, Textarea, type DataTableColumn,
} from "@eaop/design-system";
import { type ImportResult, type WorkflowSummary, type WorkflowView } from "@eaop/module-workflow-intelligence";
import { ActionButton, useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { fmtNum, QuadrantBadge, ScoreBar, WI, WI_API } from "./common";

export interface ConnectorOption {
  id: string;
  name: string;
  type: string;
  capabilities: Array<{ key: string; operations: string[]; enabled: boolean }>;
}

const FREQUENCIES = ["continuous", "daily", "weekly", "monthly", "quarterly", "yearly", "ad_hoc"];
const RISKS = ["low", "medium", "high", "critical"];
const SOURCE_LABEL: Record<string, string> = { manual: "Manual", csv: "CSV", api: "API", connector: "Connector" };

export function WorkflowInventory({ workflows, dataClass, connectors, canCreate, canDelete }: { workflows: WorkflowSummary[]; dataClass: "production" | "sample"; connectors: ConnectorOption[]; canCreate: boolean; canDelete: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [risk, setRisk] = useState("");
  const [dialog, setDialog] = useState<null | "create" | "csv" | "connector">(null);
  const suffix = dataClass === "sample" ? "?data=sample" : "";
  const departments = useMemo(() => [...new Set(workflows.map((w) => w.department).filter((d): d is string => !!d))].sort(), [workflows]);
  const rows = workflows.filter(
    (w) => (!q || `${w.name} ${w.description} ${w.department ?? ""} ${w.ownerName ?? ""}`.toLowerCase().includes(q.toLowerCase())) && (!dept || w.department === dept) && (!risk || w.riskCategory === risk),
  );
  const columns: Array<DataTableColumn<WorkflowSummary>> = [
    { key: "name", header: "Workflow", sortable: true, sortValue: (w) => w.name, cell: (w) => <span className="font-medium">{w.name}</span> },
    { key: "dept", header: "Department", sortable: true, sortValue: (w) => w.department ?? "", cell: (w) => w.department ?? <span className="text-subtle">—</span>, hideOnMobile: true },
    { key: "volume", header: "Volume / yr", align: "right", sortable: true, sortValue: (w) => w.annualVolume, cell: (w) => fmtNum(w.annualVolume), hideOnMobile: true },
    { key: "steps", header: "Steps", align: "right", sortable: true, sortValue: (w) => w.stepCount, cell: (w) => w.stepCount || <span className="text-subtle">0</span>, hideOnMobile: true },
    { key: "opp", header: "AI opportunity", sortable: true, sortValue: (w) => w.scores?.aiOpportunity ?? -1, cell: (w) => (w.scores ? <ScoreBar value={w.scores.aiOpportunity} label="AI opportunity" /> : <Badge>Not analyzed</Badge>) },
    { key: "ready", header: "Readiness", sortable: true, sortValue: (w) => w.scores?.automationReadiness ?? -1, cell: (w) => <ScoreBar value={w.scores?.automationReadiness} label="Automation readiness" />, hideOnMobile: true },
    { key: "risk", header: "Risk", sortable: true, sortValue: (w) => w.scores?.risk ?? -1, cell: (w) => <ScoreBar value={w.scores?.risk} higherIsBetter={false} label="Risk" />, hideOnMobile: true },
    { key: "quad", header: "Quadrant", cell: (w) => <span className="inline-flex items-center gap-1"><QuadrantBadge value={w.quadrant} />{w.aiReady && <Badge tone="success">AI-ready</Badge>}</span> },
    { key: "src", header: "Source", cell: (w) => <Badge>{SOURCE_LABEL[w.source] ?? w.source}</Badge>, hideOnMobile: true },
  ];
  return (
    <div className="space-y-4">
      <FilterBar
        onSearchChange={setQ}
        searchPlaceholder="Search workflows"
        actions={
          <div className="flex flex-wrap gap-2">
            {dataClass === "sample" && canCreate && (
              <ActionButton variant="secondary" path={`${WI_API}/sample-data`} success="Sample workflows loaded" leftIcon={<Sparkles className="size-4" />}>Load sample workflows</ActionButton>
            )}
            {dataClass === "sample" && canDelete && workflows.length > 0 && (
              <ActionButton variant="secondary" method="DELETE" path={`${WI_API}/sample-data`} success="Sample data cleared" confirm={{ title: "Clear all sample data?", message: "Every workflow in the Sample data set — and its scores, opportunities and implementations — will be deleted. Production data is not affected." }}>
                Clear sample data
              </ActionButton>
            )}
            {canCreate && (
              <DropdownMenu
                trigger={(props) => <Button {...props} leftIcon={<Plus className="size-4" />}>Add workflows</Button>}
                items={[
                  { id: "create", label: "New workflow", icon: <Plus className="size-4" />, onSelect: () => setDialog("create") },
                  { id: "csv", label: "Import CSV", icon: <FileUp className="size-4" />, onSelect: () => setDialog("csv") },
                  { id: "connector", label: "Discover via connector", icon: <Database className="size-4" />, onSelect: () => setDialog("connector") },
                ]}
              />
            )}
          </div>
        }
      >
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} options={[{ value: "", label: "All departments" }, ...departments.map((d) => ({ value: d, label: d }))]} />
        <Select aria-label="Risk category" value={risk} onChange={(e) => setRisk(e.target.value)} options={[{ value: "", label: "Any risk" }, ...RISKS.map((r) => ({ value: r, label: `${r[0]!.toUpperCase()}${r.slice(1)} risk` }))]} />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(w) => w.id}
        onRowClick={(w) => router.push(`${WI}/workflows/${w.id}${suffix}`)}
        rowLabel={(w) => `Open ${w.name}`}
        caption="Workflow inventory"
        emptyState={<p className="p-6 text-center text-sm text-muted">{workflows.length ? "No workflows match these filters." : dataClass === "sample" ? "No sample workflows. Load the sample set to explore the module." : "No workflows yet. Add one, import a CSV, or discover workflows through a connector."}</p>}
      />
      {dialog === "create" && <CreateWorkflow dataClass={dataClass} onClose={() => setDialog(null)} />}
      {dialog === "csv" && <CsvImport dataClass={dataClass} onClose={() => setDialog(null)} />}
      {dialog === "connector" && <ConnectorImport connectors={connectors} onClose={() => setDialog(null)} />}
    </div>
  );
}

export interface WorkflowFormValue {
  name: string;
  description: string;
  department: string;
  ownerName: string;
  businessSponsor: string;
  status: string;
  frequency: string;
  annualVolume: string;
  systems: string;
  roles: string;
  riskCategory: string;
  regulatoryCategory: string;
}

export const toForm = (w?: WorkflowView): WorkflowFormValue => ({
  name: w?.name ?? "", description: w?.description ?? "", department: w?.department ?? "", ownerName: w?.ownerName ?? "", businessSponsor: w?.businessSponsor ?? "",
  status: w?.status ?? "active", frequency: w?.frequency ?? "daily", annualVolume: String(w?.annualVolume ?? ""), systems: (w?.systems ?? []).join(", "), roles: (w?.roles ?? []).join(", "),
  riskCategory: w?.riskCategory ?? "medium", regulatoryCategory: w?.regulatoryCategory ?? "",
});

export const fromForm = (f: WorkflowFormValue) => ({
  name: f.name.trim(), description: f.description, department: f.department.trim() || null, ownerName: f.ownerName.trim() || null, businessSponsor: f.businessSponsor.trim() || null,
  status: f.status, frequency: f.frequency, annualVolume: Number(f.annualVolume || 0), systems: f.systems.split(",").map((s) => s.trim()).filter(Boolean), roles: f.roles.split(",").map((s) => s.trim()).filter(Boolean),
  riskCategory: f.riskCategory, regulatoryCategory: f.regulatoryCategory.trim() || null,
});

export function WorkflowFields({ value, onChange }: { value: WorkflowFormValue; onChange: (v: WorkflowFormValue) => void }) {
  const set = (k: keyof WorkflowFormValue) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField id="wf-name" label="Name" required className="sm:col-span-2">{(a) => <Input {...a} value={value.name} onChange={set("name")} maxLength={200} />}</FormField>
      <FormField id="wf-desc" label="Description" className="sm:col-span-2">{(a) => <Textarea {...a} rows={3} value={value.description} onChange={set("description")} />}</FormField>
      <FormField id="wf-dept" label="Department">{(a) => <Input {...a} value={value.department} onChange={set("department")} />}</FormField>
      <FormField id="wf-owner" label="Process owner">{(a) => <Input {...a} value={value.ownerName} onChange={set("ownerName")} />}</FormField>
      <FormField id="wf-sponsor" label="Business sponsor">{(a) => <Input {...a} value={value.businessSponsor} onChange={set("businessSponsor")} />}</FormField>
      <FormField id="wf-status" label="Status">{(a) => <Select {...a} value={value.status} onChange={set("status")} options={["draft", "active", "under_review", "retired"].map((s) => ({ value: s, label: s.replace("_", " ") }))} />}</FormField>
      <FormField id="wf-freq" label="Frequency">{(a) => <Select {...a} value={value.frequency} onChange={set("frequency")} options={FREQUENCIES.map((s) => ({ value: s, label: s.replace("_", " ") }))} />}</FormField>
      <FormField id="wf-vol" label="Annual volume" hint="Executions per year">{(a) => <Input {...a} type="number" min={0} value={value.annualVolume} onChange={set("annualVolume")} />}</FormField>
      <FormField id="wf-sys" label="Systems involved" hint="Comma-separated">{(a) => <Input {...a} value={value.systems} onChange={set("systems")} />}</FormField>
      <FormField id="wf-roles" label="Roles involved" hint="Comma-separated">{(a) => <Input {...a} value={value.roles} onChange={set("roles")} />}</FormField>
      <FormField id="wf-risk" label="Risk category">{(a) => <Select {...a} value={value.riskCategory} onChange={set("riskCategory")} options={RISKS.map((r) => ({ value: r, label: r }))} />}</FormField>
      <FormField id="wf-reg" label="Regulatory category" hint="e.g. SOX, HIPAA, GDPR">{(a) => <Input {...a} value={value.regulatoryCategory} onChange={set("regulatoryCategory")} />}</FormField>
    </div>
  );
}

function CreateWorkflow({ dataClass, onClose }: { dataClass: "production" | "sample"; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState(toForm());
  const { run, pending } = useMutation();
  async function create() {
    const w = await run(() => apiFetch<WorkflowView>(`${WI_API}/workflows`, { body: { ...fromForm(form), dataClass }, idempotencyKey: crypto.randomUUID() }), { success: "Workflow created", refresh: false });
    if (w) router.push(`${WI}/workflows/${w.id}${dataClass === "sample" ? "?data=sample" : ""}`);
  }
  return (
    <Drawer open onClose={onClose} width="lg" title="New workflow" description={dataClass === "sample" ? "This workflow will be stored as SAMPLE data." : "Model its steps after creating it."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!form.name.trim()} onClick={create}>Create workflow</Button></>}>
      <WorkflowFields value={form} onChange={setForm} />
    </Drawer>
  );
}

function ImportSummary({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm" role="status">
      <p>
        <strong>{result.created}</strong> created · <strong>{result.updated}</strong> updated · <strong>{result.skipped}</strong> skipped (already present) · data set: <Badge tone={result.dataClass === "sample" ? "warning" : "neutral"}>{result.dataClass}</Badge>
      </p>
      {result.errors.length > 0 && (
        <ul className="max-h-40 list-disc space-y-1 overflow-auto pl-5 text-danger">
          {result.errors.map((e, i) => <li key={i}>{e.line ? `Line ${e.line}: ` : e.index != null ? `Record ${e.index + 1}: ` : ""}{e.message}</li>)}
        </ul>
      )}
    </div>
  );
}

function CsvImport({ dataClass, onClose }: { dataClass: "production" | "sample"; onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const { run, pending } = useMutation();
  return (
    <Modal open onClose={onClose} size="lg" title="Import workflows from CSV" description="Columns: name (required), description, department, owner, sponsor, status, frequency, annual volume, systems, roles, risk, regulatory category, id. Separate multiple systems/roles with ; or |."
      footer={<><Button variant="secondary" onClick={onClose}>{result ? "Done" : "Cancel"}</Button><Button loading={pending} disabled={!csv.trim()} onClick={async () => { const r = await run(() => apiFetch<ImportResult>(`${WI_API}/imports/csv`, { body: { csv, dataClass } }), { success: "Import finished" }); if (r) setResult(r); }}>Import</Button></>}>
      <div className="space-y-4">
        <FormField id="csv-file" label="CSV file">
          {(a) => <input {...a} type="file" accept=".csv,text/csv" className="text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />}
        </FormField>
        <FormField id="csv-text" label="…or paste CSV">{(a) => <Textarea {...a} rows={8} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"name,department,annual volume,systems,risk\nInvoice processing,Finance,24000,ERP; Email,medium"} />}</FormField>
        {result && <ImportSummary result={result} />}
      </div>
    </Modal>
  );
}

function ConnectorImport({ connectors, onClose }: { connectors: ConnectorOption[]; onClose: () => void }) {
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const connector = connectors.find((c) => c.id === connectorId);
  const caps = connector?.capabilities.filter((c) => c.enabled && c.operations.includes("list")) ?? [];
  const [capability, setCapability] = useState("");
  const [nameField, setNameField] = useState("name");
  const [idField, setIdField] = useState("id");
  const [result, setResult] = useState<(ImportResult & { simulated: boolean }) | null>(null);
  const { run, pending } = useMutation();
  const cap = capability || caps[0]?.key || "";
  return (
    <Modal open onClose={onClose} size="lg" title="Discover workflows through a connector" description="Uses a connector configured under Administration → Connectors. Records from simulated (sandbox) connectors are stored as SAMPLE data only."
      footer={<><Button variant="secondary" onClick={onClose}>{result ? "Done" : "Cancel"}</Button><Button loading={pending} disabled={!connectorId || !cap} onClick={async () => { const r = await run(() => apiFetch<ImportResult & { simulated: boolean }>(`${WI_API}/imports/connector`, { body: { connectorId, capability: cap, nameField, idField } }), { success: "Discovery finished" }); if (r) setResult(r); }}>Discover</Button></>}>
      {connectors.length === 0 ? (
        <p className="text-sm text-muted">No usable connectors. Configure one under Administration → Connectors (requires connector.read and connector.use).</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="ci-conn" label="Connector">{(a) => <Select {...a} value={connectorId} onChange={(e) => { setConnectorId(e.target.value); setCapability(""); }} options={connectors.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))} />}</FormField>
          <FormField id="ci-cap" label="Capability" hint="Must support the list operation">{(a) => <Select {...a} value={cap} onChange={(e) => setCapability(e.target.value)} options={caps.map((c) => ({ value: c.key, label: c.key }))} placeholder={caps.length ? undefined : "No list capability enabled"} />}</FormField>
          <FormField id="ci-name" label="Name field">{(a) => <Input {...a} value={nameField} onChange={(e) => setNameField(e.target.value)} />}</FormField>
          <FormField id="ci-id" label="External id field">{(a) => <Input {...a} value={idField} onChange={(e) => setIdField(e.target.value)} />}</FormField>
          {connector?.type === "sandbox" && <p className="text-sm text-warning sm:col-span-2">This is a simulated connector: its records will be imported into the Sample data set.</p>}
          {result && <div className="sm:col-span-2"><ImportSummary result={result} /></div>}
        </div>
      )}
    </Modal>
  );
}
