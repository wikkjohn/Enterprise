"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, FormField, Input, KeyValueList, Select, cn, type DataTableColumn } from "@eaop/design-system";
import { type ImplementationDetail, type ImplementationView } from "@eaop/module-workflow-intelligence";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { fmtUnit, fmtUsd, LocalDate, ProvenanceBadge, PROVENANCE_OPTIONS, WI, WI_API } from "./common";

const STAGES = ["proposed", "approved", "design", "build", "testing", "pilot", "production", "measured"] as const;
const STAGE_HINT: Record<string, string> = {
  approved: "Requires the opportunity to be approved.",
  production: "Requires a pre-deployment baseline.",
  measured: "Requires at least one post-deployment measurement.",
};
const METRICS = [
  { key: "executions", label: "Executions" },
  { key: "labor_hours", label: "Labor hours" },
  { key: "operating_cost", label: "Operating cost ($)" },
  { key: "cycle_time_minutes", label: "Avg cycle time (min)" },
  { key: "error_rate", label: "Error rate (0–1)" },
  { key: "revenue", label: "Attributable revenue ($)" },
];

export function ImplementationList({ implementations, dataClass }: { implementations: ImplementationView[]; dataClass: string }) {
  const router = useRouter();
  const [stage, setStage] = useState("");
  const suffix = dataClass === "sample" ? "?data=sample" : "";
  const rows = implementations.filter((i) => !stage || i.stage === stage);
  const columns: Array<DataTableColumn<ImplementationView>> = [
    { key: "wf", header: "Workflow", cell: (i) => <span className="font-medium">{i.workflowName}</span> },
    { key: "stage", header: "Stage", cell: (i) => <StageBadge stage={i.stage} /> },
    { key: "owner", header: "Owner", hideOnMobile: true, cell: (i) => i.owner ?? "—" },
    { key: "sponsor", header: "Sponsor", hideOnMobile: true, cell: (i) => i.sponsor ?? "—" },
    { key: "ms", header: "Milestones", hideOnMobile: true, cell: (i) => (i.milestones.length ? `${i.milestones.filter((m) => m.done).length}/${i.milestones.length}` : "—") },
    { key: "exp", header: "Expected savings / yr", align: "right", cell: (i) => fmtUsd(i.expectedAnnualSavings) },
    { key: "dep", header: "Deployed", hideOnMobile: true, cell: (i) => i.deploymentDate ?? "—" },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Stage" className="max-w-xs" value={stage} onChange={(e) => setStage(e.target.value)} options={[{ value: "", label: "All stages" }, ...STAGES.map((s) => ({ value: s, label: s }))]} />
      <DataTable columns={columns} rows={rows} getRowId={(i) => i.id} onRowClick={(i) => router.push(`${WI}/implementations/${i.id}${suffix}`)} rowLabel={(i) => `Open ${i.workflowName}`} caption="Implementations"
        emptyState={<p className="p-6 text-center text-sm text-muted">No implementations. Start one from an opportunity in the portfolio.</p>} />
    </div>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const tone = stage === "measured" ? "success" : stage === "production" ? "success" : stage === "proposed" ? "neutral" : "accent";
  return <Badge tone={tone} className="capitalize">{stage}</Badge>;
}

export function ImplementationDetailView({ impl, perms }: { impl: ImplementationDetail; perms: { manage: boolean; roiManage: boolean } }) {
  const idx = STAGES.indexOf(impl.stage);
  const { run, pending } = useMutation();
  const move = (stage: string) => run(() => apiFetch(`${WI_API}/implementations/${impl.id}/stage`, { body: { stage } }), { success: `Moved to ${stage}` });
  const next = STAGES[idx + 1];
  const prev = STAGES[idx - 1];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Stage" description="Stages advance one at a time; moving back is allowed. Gates are enforced by the server." />
        <CardBody className="space-y-4">
          <ol className="flex flex-wrap gap-1" aria-label="Implementation stages">
            {STAGES.map((s, i) => (
              <li key={s} aria-current={i === idx ? "step" : undefined} className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-xs capitalize", i < idx ? "border-success/40 bg-success-subtle text-success" : i === idx ? "border-accent bg-accent text-accent-fg" : "border-border text-muted")}>
                {i < idx && <Check className="size-3" aria-hidden />}
                {s}
              </li>
            ))}
          </ol>
          {perms.manage && (
            <div className="flex flex-wrap items-center gap-2">
              {prev && <Button variant="secondary" size="sm" leftIcon={<ChevronLeft className="size-4" />} loading={pending} onClick={() => move(prev)}>Back to {prev}</Button>}
              {next && <Button size="sm" leftIcon={<ChevronRight className="size-4" />} loading={pending} onClick={() => move(next)}>Advance to {next}</Button>}
              {next && STAGE_HINT[next] && <span className="text-xs text-muted">{STAGE_HINT[next]}</span>}
            </div>
          )}
        </CardBody>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Plan impl={impl} canEdit={perms.manage} canEditCost={perms.roiManage} />
        <RealizedRoi impl={impl} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Baseline impl={impl} canEdit={perms.roiManage && STAGES.indexOf(impl.stage) < STAGES.indexOf("production")} />
        <Measurements impl={impl} canEdit={perms.roiManage && STAGES.indexOf(impl.stage) >= STAGES.indexOf("pilot")} />
      </div>
    </div>
  );
}

function Plan({ impl, canEdit, canEditCost }: { impl: ImplementationDetail; canEdit: boolean; canEditCost: boolean }) {
  const [f, setF] = useState({
    sponsor: impl.sponsor ?? "", owner: impl.owner ?? "", team: impl.team.join(", "), dependencies: impl.dependencies.join("\n"), systems: impl.systems.join(", "),
    actualCost: impl.actualCost?.toString() ?? "", deploymentDate: impl.deploymentDate ?? "",
  });
  const [milestones, setMilestones] = useState(impl.milestones);
  const [newMs, setNewMs] = useState("");
  const { run, pending } = useMutation();
  const split = (s: string, sep: RegExp) => s.split(sep).map((x) => x.trim()).filter(Boolean);
  const save = () =>
    run(() => apiFetch(`${WI_API}/implementations/${impl.id}`, {
      method: "PATCH",
      body: {
        sponsor: f.sponsor || null, owner: f.owner || null, team: split(f.team, /,/), dependencies: split(f.dependencies, /\n/), systems: split(f.systems, /,/), milestones,
        deploymentDate: f.deploymentDate || null, ...(canEditCost && f.actualCost !== "" ? { actualCost: Number(f.actualCost) } : {}),
      },
    }), { success: "Implementation updated" });
  const field = (k: keyof typeof f, label: string, opts: { type?: string; disabled?: boolean } = {}) => (
    <FormField id={`impl-${k}`} label={label}>{(a) => <Input {...a} type={opts.type} disabled={!canEdit || opts.disabled} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>
  );
  return (
    <Card>
      <CardHeader title="Plan" actions={canEdit ? <Button size="sm" loading={pending} onClick={save}>Save</Button> : undefined} />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {field("sponsor", "Sponsor")}
          {field("owner", "Owner")}
          {field("team", "Team (comma-separated)")}
          {field("systems", "Systems (comma-separated)")}
          {field("actualCost", "Actual implementation cost ($)", { type: "number", disabled: !canEditCost })}
          {field("deploymentDate", "Deployment date", { type: "date" })}
        </div>
        <FormField id="impl-deps" label="Dependencies (one per line)">{(a) => <textarea {...a} className="w-full rounded-md border border-border bg-surface p-2 text-sm" rows={3} disabled={!canEdit} value={f.dependencies} onChange={(e) => setF({ ...f, dependencies: e.target.value })} />}</FormField>
        <div className="space-y-2">
          <p className="text-sm font-medium">Milestones</p>
          {milestones.length === 0 && <p className="text-sm text-muted">No milestones.</p>}
          {milestones.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <Checkbox label={m.name} disabled={!canEdit} checked={m.done} onChange={(e) => setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
              <Input size="sm" type="date" aria-label={`${m.name} due date`} className="ml-auto w-40" disabled={!canEdit} value={m.dueDate ?? ""} onChange={(e) => setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, dueDate: e.target.value || null } : x)))} />
            </div>
          ))}
          {canEdit && (
            <div className="flex gap-2">
              <Input size="sm" aria-label="New milestone" placeholder="New milestone" value={newMs} onChange={(e) => setNewMs(e.target.value)} />
              <Button size="sm" variant="secondary" disabled={!newMs.trim()} onClick={() => { setMilestones((ms) => [...ms, { name: newMs.trim(), done: false, dueDate: null }]); setNewMs(""); }}>Add</Button>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function RealizedRoi({ impl }: { impl: ImplementationDetail }) {
  const r = impl.realized;
  return (
    <Card>
      <CardHeader title="Projected vs actual" description={r ? `${r.measuredDays} measured days · ${Math.round(r.annualizedExecutions).toLocaleString("en-US")} executions / yr annualized` : "Appears once a baseline and at least one measurement exist."} />
      {impl.projected === null && impl.realized === null && impl.expectedAnnualSavings === null ? (
        <CardBody className="text-sm text-muted">Financials require workflow.roi.read.</CardBody>
      ) : r ? (
        <>
          {r.warnings.length > 0 && <CardBody className="text-sm text-warning">{r.warnings.join(" ")}</CardBody>}
          <DataTable
            caption="Projected vs actual"
            rows={r.lines}
            getRowId={(l) => l.key}
            columns={[
              { key: "l", header: "Measure", cell: (l) => <span className="font-medium">{l.label}</span> },
              { key: "p", header: "Projected", align: "right", cell: (l) => fmtUnit(l.projected, l.unit) },
              { key: "a", header: "Actual", align: "right", cell: (l) => fmtUnit(l.actual, l.unit) },
              { key: "v", header: "Variance", align: "right", cell: (l) => (l.variance == null ? "—" : <span className={cn(l.key === "paybackMonths" ? (l.variance <= 0 ? "text-success" : "text-danger") : l.variance >= 0 ? "text-success" : "text-danger")}>{fmtUnit(l.variance, l.unit)}{l.variancePct != null ? ` (${l.variancePct > 0 ? "+" : ""}${l.variancePct}%)` : ""}</span>) },
              { key: "pr", header: "Basis", cell: (l) => <ProvenanceBadge value={l.provenance} /> },
            ]}
          />
        </>
      ) : (
        <CardBody>
          <KeyValueList items={[
            { key: "p", label: "Projected annual savings", value: fmtUsd(impl.projected?.annualSavings ?? impl.expectedAnnualSavings) },
            { key: "r", label: "Projected 3-year ROI", value: fmtUnit(impl.projected?.roi3yrPct, "pct") },
            { key: "b", label: "Baseline", value: impl.baseline ? "Captured" : "Not captured" },
            { key: "m", label: "Measurements", value: String(impl.measurements.length) },
          ]} />
        </CardBody>
      )}
    </Card>
  );
}

function MetricInputs({ value, onChange, disabled }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; disabled: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {METRICS.map((m) => (
        <FormField key={m.key} id={`m-${m.key}`} label={m.label}>{(a) => <Input {...a} type="number" min={0} step="any" disabled={disabled} value={value[m.key] ?? ""} onChange={(e) => onChange({ ...value, [m.key]: e.target.value })} />}</FormField>
      ))}
    </div>
  );
}
const toMetrics = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "").map(([k, x]) => [k, Number(x)]));

function Baseline({ impl, canEdit }: { impl: ImplementationDetail; canEdit: boolean }) {
  const b = impl.baseline;
  const [periodDays, setPeriodDays] = useState(String(b?.periodDays ?? 30));
  const [metrics, setMetrics] = useState<Record<string, string>>(Object.fromEntries(Object.entries(b?.metrics ?? {}).map(([k, v]) => [k, String(v)])));
  const [provenance, setProvenance] = useState(b?.provenance ?? "fact");
  const { run, pending } = useMutation();
  return (
    <Card>
      <CardHeader title="Baseline (before deployment)" description={b ? <>Captured <LocalDate value={b.capturedAt} /> over {b.periodDays} days</> : "Totals for a representative period before the change."}
        actions={b ? <ProvenanceBadge value={b.provenance} /> : undefined} />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="b-days" label="Period (days)">{(a) => <Input {...a} type="number" min={1} disabled={!canEdit} value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} />}</FormField>
          <FormField id="b-prov" label="Provenance">{(a) => <Select {...a} disabled={!canEdit} value={provenance} onChange={(e) => setProvenance(e.target.value)} options={PROVENANCE_OPTIONS} />}</FormField>
        </div>
        <MetricInputs value={metrics} onChange={setMetrics} disabled={!canEdit} />
        {canEdit ? (
          <Button size="sm" loading={pending} onClick={() => run(() => apiFetch(`${WI_API}/implementations/${impl.id}/baseline`, { body: { periodDays: Number(periodDays), metrics: toMetrics(metrics), provenance } }), { success: "Baseline captured" })}>{b ? "Re-capture baseline" : "Capture baseline"}</Button>
        ) : (
          <p className="text-xs text-muted">{STAGES.indexOf(impl.stage) >= STAGES.indexOf("production") ? "Baselines are frozen once the implementation reaches production." : "Requires workflow.roi.manage."}</p>
        )}
      </CardBody>
    </Card>
  );
}

function Measurements({ impl, canEdit }: { impl: ImplementationDetail; canEdit: boolean }) {
  const [periodStart, setStart] = useState("");
  const [periodEnd, setEnd] = useState("");
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [provenance, setProvenance] = useState("fact");
  const [note, setNote] = useState("");
  const { run, pending } = useMutation();
  return (
    <Card>
      <CardHeader title="Post-deployment measurements" description="Totals per period. Realized ROI is annualized from these against the baseline." />
      <CardBody className="space-y-3">
        {impl.measurements.length > 0 && (
          <DataTable
            density="compact"
            caption="Measurements"
            rows={impl.measurements}
            getRowId={(m) => m.id}
            columns={[
              { key: "p", header: "Period", cell: (m) => `${m.periodStart} → ${m.periodEnd}` },
              { key: "e", header: "Executions", align: "right", cell: (m) => m.metrics.executions?.toLocaleString("en-US") ?? "—" },
              { key: "c", header: "Cost", align: "right", cell: (m) => fmtUsd(m.metrics.operating_cost) },
              { key: "h", header: "Hours", align: "right", cell: (m) => m.metrics.labor_hours?.toLocaleString("en-US") ?? "—" },
              { key: "pr", header: "Basis", cell: (m) => <ProvenanceBadge value={m.provenance} /> },
            ]}
          />
        )}
        {canEdit ? (
          <div className="space-y-3 border-t border-border pt-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField id="m-start" label="Period start">{(a) => <Input {...a} type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} />}</FormField>
              <FormField id="m-end" label="Period end">{(a) => <Input {...a} type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} />}</FormField>
              <FormField id="m-prov" label="Provenance">{(a) => <Select {...a} value={provenance} onChange={(e) => setProvenance(e.target.value)} options={PROVENANCE_OPTIONS} />}</FormField>
            </div>
            <MetricInputs value={metrics} onChange={setMetrics} disabled={false} />
            <FormField id="m-note" label="Note">{(a) => <Input {...a} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
            <Button size="sm" loading={pending} disabled={!periodStart || !periodEnd} onClick={async () => { if (await run(() => apiFetch(`${WI_API}/implementations/${impl.id}/measurements`, { body: { periodStart, periodEnd, metrics: toMetrics(metrics), provenance, note: note || undefined } }), { success: "Measurement recorded — realized ROI updated" })) { setMetrics({}); setNote(""); } }}>Record measurement</Button>
          </div>
        ) : (
          <p className="text-xs text-muted">{STAGES.indexOf(impl.stage) < STAGES.indexOf("pilot") ? "Measurements are recorded from the Pilot stage onwards." : "Requires workflow.roi.manage."}</p>
        )}
      </CardBody>
    </Card>
  );
}
