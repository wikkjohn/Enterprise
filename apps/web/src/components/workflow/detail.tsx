"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, BrainCircuit, CheckCircle2, Gauge, Pencil, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import {
  Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, Drawer, EmptyState, FormField, Input, KeyValueList, Modal, Select, TabPanel, Tabs,
  type DataTableColumn,
} from "@eaop/design-system";
import { type RecommendationView, type RoiOutput, type Score, type StoredScores, type WorkflowDetail } from "@eaop/module-workflow-intelligence";
import { ActionButton, useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { fmtNum, fmtUnit, fmtUsd, LocalDate, ProvenanceBadge, PROVENANCE_OPTIONS, QuadrantBadge, ScoreBar, STEP_TYPE_META, WI, WI_API } from "./common";
import { GraphEditor } from "./graph-editor";
import { fromForm, toForm, WorkflowFields } from "./inventory";

export interface DetailPerms {
  update: boolean;
  delete: boolean;
  analyze: boolean;
  approve: boolean;
  roiManage: boolean;
  aiUse: boolean;
  aiRunRead: boolean;
}

type Version = { version: number; changeNote: string | null; createdBy: string | null; createdAt: string; stepCount: number };

export function WorkflowDetailView({ detail, versions, perms }: { detail: WorkflowDetail; versions: Version[]; perms: DetailPerms }) {
  const [tab, setTab] = useState("overview");
  const w = detail.workflow;
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "model", label: `Process model (${detail.steps.length})` },
    { value: "scores", label: "Scores" },
    { value: "roi", label: "ROI" },
    { value: "redesign", label: `AI redesign${detail.recommendations.length ? ` (${detail.recommendations.length})` : ""}` },
    { value: "versions", label: `Versions (${versions.length})` },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {perms.analyze && (
          <ActionButton path={`${WI_API}/workflows/${w.id}/analyze`} success="Analysis complete — scores, ROI and opportunity updated" leftIcon={<Gauge className="size-4" />}>
            {detail.scores ? "Re-analyze" : "Analyze"}
          </ActionButton>
        )}
        {detail.scores?.stale && <Badge tone="warning">Scores are from v{detail.scores.workflowVersion} — re-analyze</Badge>}
        {detail.opportunity && (
          <Link href={`${WI}/opportunities${w.dataClass === "sample" ? "?data=sample&" : "?"}focus=${detail.opportunity.id}`} className="text-sm text-accent hover:underline">
            Opportunity: {detail.opportunity.status.replace("_", " ")}
          </Link>
        )}
        {detail.implementation && (
          <Link href={`${WI}/implementations/${detail.implementation.id}${w.dataClass === "sample" ? "?data=sample" : ""}`} className="text-sm text-accent hover:underline">
            Implementation: {detail.implementation.stage}
          </Link>
        )}
      </div>
      <Tabs ariaLabel="Workflow sections" value={tab} onChange={setTab} items={tabs} idPrefix="wf" />
      <TabPanel value="overview" selected={tab} idPrefix="wf"><Overview detail={detail} perms={perms} /></TabPanel>
      <TabPanel value="model" selected={tab} idPrefix="wf">
        <GraphEditor key={w.currentVersion} workflowId={w.id} initialSteps={detail.steps} initialEdges={detail.edges} readOnly={!perms.update} />
      </TabPanel>
      <TabPanel value="scores" selected={tab} idPrefix="wf"><Scores detail={detail} perms={perms} /></TabPanel>
      <TabPanel value="roi" selected={tab} idPrefix="wf"><Roi detail={detail} perms={perms} /></TabPanel>
      <TabPanel value="redesign" selected={tab} idPrefix="wf"><Redesign detail={detail} perms={perms} /></TabPanel>
      <TabPanel value="versions" selected={tab} idPrefix="wf"><Versions workflowId={w.id} versions={versions} /></TabPanel>
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function Overview({ detail, perms }: { detail: WorkflowDetail; perms: DetailPerms }) {
  const router = useRouter();
  const w = detail.workflow;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(toForm(w));
  const { run, pending } = useMutation();
  const list = (xs: string[]) => (xs.length ? <span className="flex flex-wrap gap-1">{xs.map((x) => <Badge key={x}>{x}</Badge>)}</span> : "—");
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader
          title="Workflow"
          actions={
            <div className="flex gap-2">
              {perms.update && <ActionButton size="sm" variant="secondary" method="PATCH" path={`${WI_API}/workflows/${w.id}`} body={{ markReviewed: true }} success="Marked as reviewed">Mark reviewed</ActionButton>}
              {perms.update && <Button size="sm" variant="secondary" leftIcon={<Pencil className="size-4" />} onClick={() => { setForm(toForm(w)); setEditing(true); }}>Edit</Button>}
            </div>
          }
        />
        <CardBody>
          <KeyValueList
            columns={2}
            items={[
              { key: "dept", label: "Department", value: w.department ?? "—" },
              { key: "status", label: "Status", value: <span className="capitalize">{w.status.replace("_", " ")}</span> },
              { key: "owner", label: "Process owner", value: w.ownerName ?? "—" },
              { key: "sponsor", label: "Business sponsor", value: w.businessSponsor ?? "—" },
              { key: "freq", label: "Frequency", value: <span className="capitalize">{w.frequency.replace("_", " ")}</span> },
              { key: "vol", label: "Annual volume", value: fmtNum(w.annualVolume) },
              { key: "sys", label: "Systems", value: list(w.systems) },
              { key: "roles", label: "Roles", value: list(w.roles) },
              { key: "risk", label: "Risk category", value: <span className="capitalize">{w.riskCategory}</span> },
              { key: "reg", label: "Regulatory category", value: w.regulatoryCategory ?? "—" },
              { key: "src", label: "Source", value: `${w.source}${w.sourceRef ? ` · ${w.sourceRef}` : ""}` },
              { key: "dates", label: "Created / last reviewed", value: <><LocalDate value={w.createdAt} dateOnly /> / {w.lastReviewedAt ? <LocalDate value={w.lastReviewedAt} dateOnly /> : "never"}</> },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="At a glance" />
        <CardBody className="space-y-3 text-sm">
          {detail.scores ? (
            <>
              <div className="flex items-center justify-between"><span>AI Opportunity</span><ScoreBar value={detail.scores.scores.aiOpportunity.value} /></div>
              <div className="flex items-center justify-between"><span>Automation Readiness</span><ScoreBar value={detail.scores.scores.automationReadiness.value} /></div>
              <div className="flex items-center justify-between"><span>Risk</span><ScoreBar value={detail.scores.scores.risk.value} higherIsBetter={false} /></div>
              <div className="flex items-center justify-between"><span>Quadrant</span><QuadrantBadge value={detail.scores.position.quadrant} /></div>
              {detail.scores.aiReady && <Badge tone="success" icon={<CheckCircle2 />}>AI-ready</Badge>}
            </>
          ) : (
            <p className="text-muted">Not analyzed yet. Model the steps, rate the factors, then run Analyze.</p>
          )}
          {detail.roi && (
            <div className="space-y-1 border-t border-border pt-3">
              <div className="flex justify-between"><span>Projected savings</span><span className="tabular-nums">{fmtUsd(detail.roi.outputs.annualSavings.value)}/yr</span></div>
              <div className="flex justify-between"><span>3-year ROI</span><span className="tabular-nums">{fmtUnit(detail.roi.outputs.roi3yrPct.value, "pct")}</span></div>
              <div className="flex justify-between"><span>Payback</span><span className="tabular-nums">{fmtUnit(detail.roi.outputs.paybackMonths.value, "months")}</span></div>
            </div>
          )}
          {perms.delete && (
            <div className="border-t border-border pt-3">
              <DeleteWorkflow id={w.id} name={w.name} onDeleted={() => router.push(`${WI}/workflows${w.dataClass === "sample" ? "?data=sample" : ""}`)} />
            </div>
          )}
        </CardBody>
      </Card>
      {editing && (
        <Drawer open onClose={() => setEditing(false)} width="lg" title="Edit workflow" description="Saving attribute changes creates a new version."
          footer={<><Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button><Button loading={pending} disabled={!form.name.trim()} onClick={async () => { if (await run(() => apiFetch(`${WI_API}/workflows/${w.id}`, { method: "PATCH", body: fromForm(form) }), { success: "Workflow updated" })) setEditing(false); }}>Save</Button></>}>
          <WorkflowFields value={form} onChange={setForm} />
        </Drawer>
      )}
    </div>
  );
}

function DeleteWorkflow({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const { run, pending } = useMutation();
  return (
    <>
      <Button size="sm" variant="danger" leftIcon={<Trash2 className="size-4" />} onClick={() => setOpen(true)}>Delete workflow</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete "${name}"?`} description="Its model, versions, scores, ROI history, opportunity and implementation tracking are deleted. The audit log keeps a record."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={pending} onClick={async () => { if (await run(() => apiFetch(`${WI_API}/workflows/${id}`, { method: "DELETE" }), { success: "Workflow deleted", refresh: false })) onDeleted(); }}>Delete</Button></>} />
    </>
  );
}

// ── Scores ──────────────────────────────────────────────────────────────────

const RATED: Array<{ key: string; label: string; scale: string }> = [
  { key: "repetitiveness", label: "Repetitiveness", scale: "1 = every case differs · 5 = identical, repeatable" },
  { key: "decision_complexity", label: "Decision complexity", scale: "1 = simple rules · 5 = ambiguous, many criteria" },
  { key: "human_judgment", label: "Human judgment required", scale: "1 = none · 5 = expert judgment every case" },
  { key: "data_availability", label: "Data availability", scale: "1 = paper / in heads · 5 = all digital" },
  { key: "data_quality", label: "Data quality", scale: "1 = inconsistent · 5 = clean, structured" },
  { key: "integration_availability", label: "Integration availability", scale: "1 = no APIs · 5 = APIs for every system" },
  { key: "error_tolerance", label: "Error tolerance", scale: "1 = any error severe · 5 = cheap to correct" },
  { key: "security_sensitivity", label: "Security sensitivity", scale: "1 = public · 5 = restricted" },
  { key: "regulatory_exposure", label: "Regulatory exposure", scale: "1 = unregulated · 5 = heavily regulated" },
];

function Scores({ detail, perms }: { detail: WorkflowDetail; perms: DetailPerms }) {
  const s = detail.scores;
  return (
    <div className="space-y-4">
      <FactorRatings detail={detail} canEdit={perms.update} />
      {!s ? (
        <EmptyState icon={<Gauge className="size-6" />} title="Not analyzed" description="Analyze computes six transparent scores from 15 dimensions. Every number shows its inputs, weights and provenance." />
      ) : (
        <ScoreBreakdown scores={s} />
      )}
    </div>
  );
}

function FactorRatings({ detail, canEdit }: { detail: WorkflowDetail; canEdit: boolean }) {
  const [factors, setFactors] = useState<Record<string, { value: number; provenance: string; note?: string }>>(detail.metrics.factors as Record<string, { value: number; provenance: string; note?: string }>);
  const [employees, setEmployees] = useState(detail.metrics.employeesInvolved?.toString() ?? "");
  const { run, pending } = useMutation();
  const save = () =>
    run(() => apiFetch(`${WI_API}/workflows/${detail.workflow.id}/metrics`, { method: "PUT", body: { employeesInvolved: employees ? Number(employees) : null, factors } }), { success: "Factor ratings saved — re-analyze to update scores" });
  return (
    <Card>
      <CardHeader title="Factor ratings" description="Nine dimensions are rated by people (1–5) with provenance; six more are derived from the process model and ROI. Unrated factors are scored as a neutral 3 and flagged as assumptions."
        actions={canEdit ? <Button size="sm" loading={pending} onClick={save}>Save ratings</Button> : undefined} />
      <CardBody className="space-y-3">
        <FormField id="emp" label="Employees involved" className="max-w-xs">{(a) => <Input {...a} type="number" min={0} disabled={!canEdit} value={employees} onChange={(e) => setEmployees(e.target.value)} />}</FormField>
        <div className="divide-y divide-border">
          {RATED.map((r) => {
            const f = factors[r.key];
            return (
              <div key={r.key} className="grid items-center gap-2 py-2 sm:grid-cols-[1.4fr_110px_150px_1.4fr]">
                <div>
                  <p className="text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-subtle">{r.scale}</p>
                </div>
                <Select size="sm" aria-label={`${r.label} rating`} disabled={!canEdit} value={f ? String(f.value) : ""}
                  onChange={(e) => setFactors((x) => { const n = { ...x }; if (!e.target.value) delete n[r.key]; else n[r.key] = { value: Number(e.target.value), provenance: f?.provenance ?? "assumption", note: f?.note }; return n; })}
                  options={[{ value: "", label: "Not rated" }, ...[1, 2, 3, 4, 5].map((v) => ({ value: String(v), label: String(v) }))]} />
                <Select size="sm" aria-label={`${r.label} provenance`} disabled={!canEdit || !f} value={f?.provenance ?? "assumption"} onChange={(e) => setFactors((x) => ({ ...x, [r.key]: { ...x[r.key]!, provenance: e.target.value } }))} options={PROVENANCE_OPTIONS} />
                <Input size="sm" aria-label={`${r.label} evidence`} placeholder="Evidence / note" disabled={!canEdit || !f} value={f?.note ?? ""} onChange={(e) => setFactors((x) => ({ ...x, [r.key]: { ...x[r.key]!, note: e.target.value || undefined } }))} />
              </div>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

function ScoreBreakdown({ scores }: { scores: StoredScores }) {
  const columns: Array<DataTableColumn<Score["components"][number]>> = [
    { key: "c", header: "Component", cell: (c) => <span className="font-medium">{c.label}{c.inverse ? <span className="text-subtle"> (inverse)</span> : null}</span> },
    { key: "r", header: "Rating", align: "right", cell: (c) => (c.rating == null ? "—" : `${c.rating}/5`) },
    { key: "w", header: "Weight", align: "right", cell: (c) => `${Math.round(c.weight * 100)}%` },
    { key: "pts", header: "Points", align: "right", cell: (c) => c.contribution.toFixed(1) },
    { key: "p", header: "Provenance", cell: (c) => <ProvenanceBadge value={c.provenance} /> },
    { key: "d", header: "Basis", cell: (c) => <span className="text-xs text-muted">{c.detail}</span>, hideOnMobile: true },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Portfolio position" description={<>Scoring model {scores.modelVersion} · computed <LocalDate value={scores.computedAt} /> on v{scores.workflowVersion}</>} actions={<QuadrantBadge value={scores.position.quadrant} />} />
        <CardBody className="text-sm text-muted">{scores.position.explanation}</CardBody>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        {Object.values(scores.scores).map((s) => (
          <Card key={s.key}>
            <CardHeader
              title={<span className="flex items-center gap-2">{s.label} <span className="tabular-nums text-fg">{s.value}</span><span className="text-xs font-normal text-subtle">/ 100 · {s.band}{s.higherIsBetter ? "" : " (lower is better)"}</span></span>}
              actions={<ProvenanceBadge value={s.provenance} />}
            />
            <CardBody className="space-y-3">
              <p className="text-sm text-muted">{s.explanation}</p>
              <DataTable columns={columns} rows={s.components} getRowId={(c) => `${s.key}-${c.dimension}`} caption={`${s.label} components`} density="compact" />
            </CardBody>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title="All 15 dimensions" />
        <DataTable
          density="compact"
          caption="Scoring dimensions"
          rows={scores.dimensions}
          getRowId={(d) => d.key}
          columns={[
            { key: "l", header: "Dimension", cell: (d) => <span className="font-medium">{d.label}</span> },
            { key: "r", header: "Rating", align: "right", cell: (d) => `${d.rating}/5` },
            { key: "p", header: "Provenance", cell: (d) => <span className="flex gap-1"><ProvenanceBadge value={d.provenance} />{d.defaulted && <Badge tone="warning">default</Badge>}</span> },
            { key: "d", header: "Basis", cell: (d) => <span className="text-xs text-muted">{d.detail}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

// ── ROI ─────────────────────────────────────────────────────────────────────

type CostRow = { category: string; period: string; amount: string; provenance: string; description: string };

function Roi({ detail, perms }: { detail: WorkflowDetail; perms: DetailPerms }) {
  const roi = detail.roi;
  const [assumptions, setAssumptions] = useState(detail.assumptions.map((a) => ({ ...a, value: String(a.value) })));
  const [costs, setCosts] = useState<CostRow[]>(detail.costs.map((c) => ({ ...c, amount: String(c.amount) })));
  const a = useMutation();
  const c = useMutation();
  if (!detail.canSeeFinancials || !roi) {
    return <EmptyState title="Financials hidden" description='Costs, savings and ROI require the "workflow.roi.read" permission.' />;
  }
  const outputs: RoiOutput[] = Object.values(roi.outputs);
  return (
    <div className="space-y-4">
      {roi.warnings.length > 0 && (
        <div role="status" className="space-y-1 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning">
          {roi.warnings.map((w) => <p key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{w}</p>)}
        </div>
      )}
      <Card>
        <CardHeader title="Projected ROI (live)" description={`Model ${roi.modelVersion}. Recomputed from the current inputs on every view; Analyze stores a snapshot. Each figure carries the weakest provenance of its inputs.`} />
        <DataTable
          caption="ROI outputs"
          rows={outputs}
          getRowId={(o) => o.key}
          columns={[
            { key: "l", header: "Measure", cell: (o) => <span className="font-medium">{o.label}</span> },
            { key: "v", header: "Value", align: "right", cell: (o) => <span className="tabular-nums">{fmtUnit(o.value, o.unit)}</span> },
            { key: "p", header: "Provenance", cell: (o) => <ProvenanceBadge value={o.provenance} /> },
            { key: "f", header: "Formula", hideOnMobile: true, cell: (o) => <span className="text-xs text-muted">{o.formula}{o.note ? ` — ${o.note}` : ""}</span> },
          ]}
        />
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Assumptions" description="Every assumption is editable and tagged. Defaults are platform starting points, not facts."
            actions={perms.roiManage ? <Button size="sm" loading={a.pending} onClick={() => a.run(() => apiFetch(`${WI_API}/workflows/${detail.workflow.id}/assumptions`, { method: "PUT", body: { assumptions: assumptions.map((x) => ({ key: x.key, value: Number(x.value), provenance: x.provenance, rationale: x.rationale })) } }), { success: "Assumptions saved" })}>Save</Button> : undefined} />
          <CardBody className="divide-y divide-border">
            {assumptions.map((x, i) => (
              <div key={x.key} className="grid gap-2 py-2 sm:grid-cols-[1.2fr_100px_140px]">
                <div>
                  <p className="text-sm font-medium">{x.label} {x.defaulted && <Badge tone="warning">default</Badge>}</p>
                  <p className="text-xs text-subtle">{x.description} Range {x.min}–{x.max}.</p>
                </div>
                <Input size="sm" type="number" aria-label={x.label} min={x.min} max={x.max} step="any" disabled={!perms.roiManage} value={x.value} onChange={(e) => setAssumptions((as) => as.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
                <Select size="sm" aria-label={`${x.label} provenance`} disabled={!perms.roiManage} value={x.provenance} onChange={(e) => setAssumptions((as) => as.map((y, j) => (j === i ? { ...y, provenance: e.target.value } : y)))} options={PROVENANCE_OPTIONS} />
                <Input size="sm" className="sm:col-span-3" aria-label={`${x.label} rationale`} placeholder="Rationale / source" disabled={!perms.roiManage} value={x.rationale} onChange={(e) => setAssumptions((as) => as.map((y, j) => (j === i ? { ...y, rationale: e.target.value } : y)))} />
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Costs" description="Implementation (one-time), recurring (annual) and per-execution costs."
            actions={perms.roiManage ? <div className="flex gap-2"><Button size="sm" variant="secondary" leftIcon={<Plus className="size-4" />} onClick={() => setCosts((cs) => [...cs, { category: "implementation", period: "one_time", amount: "0", provenance: "assumption", description: "" }])}>Add</Button><Button size="sm" loading={c.pending} onClick={() => c.run(() => apiFetch(`${WI_API}/workflows/${detail.workflow.id}/costs`, { method: "PUT", body: { costs: costs.map((x) => ({ ...x, amount: Number(x.amount) })) } }), { success: "Costs saved" })}>Save</Button></div> : undefined} />
          <CardBody className="space-y-2">
            {costs.length === 0 && <p className="text-sm text-muted">No costs recorded. Without an implementation cost, ROI and payback are undefined.</p>}
            {costs.map((x, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-2">
                <Select size="sm" aria-label="Category" disabled={!perms.roiManage} value={x.category} onChange={(e) => setCosts((cs) => cs.map((y, j) => (j === i ? { ...y, category: e.target.value } : y)))} options={["implementation", "integration", "software", "ai_inference", "support", "other"].map((v) => ({ value: v, label: v.replace("_", " ") }))} />
                <Select size="sm" aria-label="Period" disabled={!perms.roiManage} value={x.period} onChange={(e) => setCosts((cs) => cs.map((y, j) => (j === i ? { ...y, period: e.target.value } : y)))} options={[{ value: "one_time", label: "One-time" }, { value: "annual", label: "Annual" }, { value: "per_execution", label: "Per execution" }]} />
                <Input size="sm" type="number" min={0} step="any" aria-label="Amount (USD)" disabled={!perms.roiManage} value={x.amount} onChange={(e) => setCosts((cs) => cs.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
                <Select size="sm" aria-label="Provenance" disabled={!perms.roiManage} value={x.provenance} onChange={(e) => setCosts((cs) => cs.map((y, j) => (j === i ? { ...y, provenance: e.target.value } : y)))} options={PROVENANCE_OPTIONS} />
                <Input size="sm" className="sm:col-span-2" aria-label="Description" placeholder="Description" disabled={!perms.roiManage} value={x.description} onChange={(e) => setCosts((cs) => cs.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} />
                {perms.roiManage && <Button size="sm" variant="ghost" className="justify-self-start" leftIcon={<Trash2 className="size-4" />} onClick={() => setCosts((cs) => cs.filter((_, j) => j !== i))}>Remove</Button>}
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Labor by step" description="Human step hours now vs. projected, and where each reduction comes from." />
        <DataTable
          density="compact"
          caption="Labor hours by step"
          rows={roi.stepBreakdown}
          getRowId={(s) => s.key}
          emptyState={<p className="p-4 text-sm text-muted">No human steps modeled.</p>}
          columns={[
            { key: "n", header: "Step", cell: (s) => s.name },
            { key: "c", header: "Current h/yr", align: "right", cell: (s) => fmtNum(s.currentHours) },
            { key: "f", header: "Future h/yr", align: "right", cell: (s) => fmtNum(s.futureHours) },
            { key: "r", header: "Reduction", align: "right", cell: (s) => `${Math.round(s.reduction * 100)}%` },
            { key: "s", header: "Basis", cell: (s) => <span className="text-xs text-muted">{s.reductionSource}</span> },
          ]}
        />
      </Card>
    </div>
  );
}

// ── AI redesign ─────────────────────────────────────────────────────────────

function Redesign({ detail, perms }: { detail: WorkflowDetail; perms: DetailPerms }) {
  const canRun = perms.analyze && perms.aiUse;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="AI redesign"
          description="Proposals are generated through the platform's shared AI layer (routing, policy, budgets and the AI run log). A guard restores any human approval the model tries to remove. Proposals are recommendations — nothing changes until a person accepts one."
          actions={canRun ? <ActionButton path={`${WI_API}/workflows/${detail.workflow.id}/redesign`} success="Redesign proposal generated" leftIcon={<BrainCircuit className="size-4" />} disabled={!detail.steps.length}>Generate redesign</ActionButton> : undefined}
        />
        {!canRun && <CardBody className="text-sm text-muted">Generating a redesign requires workflow.analyze and ai.use.</CardBody>}
      </Card>
      {detail.recommendations.length === 0 ? (
        <EmptyState icon={<BrainCircuit className="size-6" />} title="No proposals yet" description={detail.steps.length ? "Generate a redesign to see a proposed future state." : "Model the current process first — the redesign works from its steps."} />
      ) : (
        detail.recommendations.map((r) => <Recommendation key={r.id} rec={r} detail={detail} perms={perms} />)
      )}
    </div>
  );
}

function Recommendation({ rec, detail, perms }: { rec: RecommendationView; detail: WorkflowDetail; perms: DetailPerms }) {
  const p = rec.proposal;
  const [note, setNote] = useState("");
  const { run, pending } = useMutation();
  const review = (decision: "accept" | "reject") => run(() => apiFetch(`${WI_API}/recommendations/${rec.id}/review`, { body: { decision, note: note || undefined } }), { success: `Proposal ${decision === "accept" ? "accepted" : "rejected"}` });
  const tone = rec.status === "accepted" ? "success" : rec.status === "rejected" ? "danger" : "info";
  return (
    <Card>
      <CardHeader
        title={<span className="flex flex-wrap items-center gap-2">Proposal from v{rec.workflowVersion} <Badge tone={tone}>{rec.status}</Badge><ProvenanceBadge value="ai_estimate" /><Badge>confidence: {p.confidence}</Badge></span>}
        description={<><LocalDate value={rec.createdAt} />{` · ${rec.ai.provider ?? "?"} / ${rec.ai.model ?? "?"} · template ${rec.promptTemplateId}@${rec.promptTemplateVersion}${rec.ai.inputTokens != null ? ` · ${rec.ai.inputTokens}+${rec.ai.outputTokens} tokens` : ""}`}</>}
        actions={perms.aiRunRead && rec.ai.runId ? <Link className="text-sm text-accent hover:underline" href="/admin/ai-runs?moduleId=workflow_intelligence">AI run log</Link> : undefined}
      />
      <CardBody className="space-y-4">
        <p className="text-sm">{p.summary}</p>
        {rec.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning" role="status">
            {rec.warnings.map((w) => <p key={w} className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />{w}</p>)}
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <StepList title="Current state" steps={detail.steps.map((s) => ({ key: s.key, type: s.type, name: s.name, note: s.requiresApproval ? "human control" : undefined }))} />
          <StepList title="Proposed future state" steps={p.futureSteps.map((s) => ({ key: s.key, type: s.type, name: s.name, note: [s.change, s.requiresApproval ? "human control" : null].filter(Boolean).join(" · "), rationale: s.rationale }))} />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <MiniList title="AI steps" items={p.aiSteps.map((k) => p.futureSteps.find((s) => s.key === k)?.name ?? k)} />
          <MiniList title="Human approvals kept" items={p.humanApprovals.map((k) => p.futureSteps.find((s) => s.key === k)?.name ?? k)} />
          <MiniList title="Removed steps" items={p.removedSteps.map((r) => `${detail.steps.find((s) => s.key === r.key)?.name ?? r.key} — ${r.reason}`)} />
          <MiniList title="Exception paths" items={p.exceptionPaths.map((e) => `${e.trigger} → ${e.handling}`)} />
          <MiniList title="Integration requirements" items={p.requirements.integration} />
          <MiniList title="Data requirements" items={p.requirements.data} />
          <MiniList title="Security requirements" items={p.requirements.security} />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Estimated reduction <ProvenanceBadge value="ai_estimate" /></p>
            <p>Time: <strong>{p.estimates.timeReductionPct}%</strong> · Cost: <strong>{p.estimates.costReductionPct}%</strong></p>
            {p.estimates.rationale && <p className="text-xs text-muted">{p.estimates.rationale}</p>}
          </div>
        </div>
        {rec.status === "proposed" && perms.approve ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <FormField id={`note-${rec.id}`} label="Review note" className="min-w-64 flex-1">{(a) => <Input {...a} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
            <Button variant="secondary" leftIcon={<XCircle className="size-4" />} loading={pending} onClick={() => review("reject")}>Reject</Button>
            <Button leftIcon={<CheckCircle2 className="size-4" />} loading={pending} onClick={() => review("accept")}>Accept as plan</Button>
          </div>
        ) : rec.reviewedAt ? (
          <p className="border-t border-border pt-3 text-sm text-muted">Reviewed <LocalDate value={rec.reviewedAt} />{rec.reviewNote ? ` — “${rec.reviewNote}”` : ""}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function StepList({ title, steps }: { title: string; steps: Array<{ key: string; type: string; name: string; note?: string; rationale?: string }> }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{title}</p>
      <ol className="space-y-1">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
            <span className="mt-1 inline-block size-2.5 shrink-0 rounded-sm" style={{ background: STEP_TYPE_META[s.type]?.color }} aria-hidden />
            <span className="min-w-0">
              <span className="font-medium">{s.name}</span> <span className="text-xs text-subtle">{STEP_TYPE_META[s.type]?.label}{s.note ? ` · ${s.note}` : ""}</span>
              {s.rationale && <span className="block text-xs text-muted">{s.rationale}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MiniList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{title}</p>
      {items.length ? <ul className="list-disc space-y-0.5 pl-5 text-muted">{items.map((i) => <li key={i}>{i}</li>)}</ul> : <p className="text-subtle">None</p>}
    </div>
  );
}

// ── Versions ────────────────────────────────────────────────────────────────

function Versions({ workflowId, versions }: { workflowId: string; versions: Version[] }) {
  const [open, setOpen] = useState<{ version: number; snapshot: unknown } | null>(null);
  const { run } = useMutation();
  return (
    <Card>
      <CardHeader title="Version history" description="Every model or attribute change creates an immutable snapshot. Scores record which version they were computed on." />
      <DataTable
        caption="Workflow versions"
        rows={versions}
        getRowId={(v) => String(v.version)}
        onRowClick={async (v) => { const r = await run(() => apiFetch<{ version: number; snapshot: unknown }>(`${WI_API}/workflows/${workflowId}/versions/${v.version}`), { refresh: false }); if (r) setOpen(r); }}
        rowLabel={(v) => `View version ${v.version}`}
        columns={[
          { key: "v", header: "Version", cell: (v) => <span className="font-medium">v{v.version}</span> },
          { key: "n", header: "Change", cell: (v) => v.changeNote ?? "—" },
          { key: "s", header: "Steps", align: "right", cell: (v) => v.stepCount },
          { key: "d", header: "When", cell: (v) => <LocalDate value={v.createdAt} /> },
        ]}
      />
      {open && (
        <Modal open onClose={() => setOpen(null)} size="lg" title={`Version ${open.version} snapshot`}>
          <CodeBlock code={JSON.stringify(open.snapshot, null, 2)} language="json" maxHeight="60vh" />
        </Modal>
      )}
    </Card>
  );
}
