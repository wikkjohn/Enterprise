"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { BarChart, Button, Card, CardBody, CardHeader, DataTable, FormField, Input, Modal, Select, TabPanel, Tabs, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { BasisBadge, CostSplit, human, OPS, opts, StatusPill, usd, usdCompact } from "./common";

type Breakdown = Awaited<ReturnType<AiOpsService["breakdown"]>>;
type Rec = Awaited<ReturnType<AiOpsService["listRecords"]>>[number];
type Budget = Awaited<ReturnType<AiOpsService["listBudgets"]>>[number];
type Forecast = Awaited<ReturnType<AiOpsService["listForecasts"]>>;
type Units = Awaited<ReturnType<AiOpsService["unitEconomicsFor"]>>;
type Value = Awaited<ReturnType<AiOpsService["listValue"]>>[number];

const DIMS = ["category", "basis", "department", "tool", "vendor", "provider", "model", "module", "agent", "workflow", "project", "month"] as const;
const CATS = ["subscription", "api", "inference", "cloud", "implementation", "consulting", "support"] as const;

export function CostsView({ breakdown, records, budgets, forecast, units, value, canManage, canSeeUsers, tools, vendors }: {
  breakdown: Breakdown; records: Rec[]; budgets: Budget[]; forecast: Forecast; units: Units; value: Value[]; canManage: boolean; canSeeUsers: boolean;
  tools: Array<{ id: string; name: string }>; vendors: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get("tab") ?? "breakdown");
  const [by, setBy] = useState(breakdown.by);
  const setQuery = (patch: Record<string, string>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) if (v) q.set(k, v); else q.delete(k);
    router.push(`${OPS}/costs?${q.toString()}`);
  };
  return (
    <div className="space-y-4">
      <Tabs ariaLabel="Cost views" idPrefix="cost" value={tab} onChange={(v) => { setTab(v); setQuery({ tab: v }); }} items={[
        { value: "breakdown", label: "Breakdown" }, { value: "records", label: "Cost records" }, { value: "budgets", label: "Budgets" }, { value: "economics", label: "Forecast & unit economics" }, { value: "value", label: "Value" },
      ]} />
      <TabPanel idPrefix="cost" value="breakdown" selected={tab}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <FormField id="cb-by" label="Group by">{(x) => <Select {...x} className="w-44" value={by} onChange={(e) => { setBy(e.target.value as typeof by); setQuery({ by: e.target.value, tab: "breakdown" }); }} options={[...DIMS, ...(canSeeUsers ? ["user" as const] : [])].map((d) => ({ value: d, label: human(d) }))} />}</FormField>
            <FormField id="cb-from" label="From">{(x) => <Input {...x} type="date" defaultValue={breakdown.from} onBlur={(e) => setQuery({ from: e.target.value })} />}</FormField>
            <FormField id="cb-to" label="To (exclusive)">{(x) => <Input {...x} type="date" defaultValue={breakdown.to} onBlur={(e) => setQuery({ to: e.target.value })} />}</FormField>
            <span className="flex-1" />
            <p className="text-sm">Total <span className="font-semibold">{usd(breakdown.totals.total)}</span> <CostSplit c={breakdown.totals} /></p>
          </div>
          <Card>
            <CardBody>
              <BarChart data={breakdown.rows.slice(0, 15).map((r) => ({ label: r.label.length > 24 ? `${r.label.slice(0, 22)}…` : human(r.label), value: r.total }))} ariaLabel={`AI spend by ${by}`} height={240} valueLabel="Spend (USD)" tickFormatter={usdCompact} valueFormatter={(v) => usd(v, 2)} />
            </CardBody>
          </Card>
          <DataTable caption={`Spend by ${by}`} rows={breakdown.rows} getRowId={(r) => r.key} columns={[
            { key: "k", header: human(by), cell: (r) => <span className={by === "model" ? "font-mono text-xs" : ""}>{by === "month" ? r.key : human(r.label)}</span> },
            { key: "m", header: "Measured", cell: (r) => usd(r.measured, 2) },
            { key: "e", header: "Estimated", cell: (r) => usd(r.estimated, 2) },
            { key: "a", header: "Allocated", cell: (r) => usd(r.allocated, 2) },
            { key: "t", header: "Total", cell: (r) => <span className="font-medium">{usd(r.total, 2)}</span> },
          ]} emptyState={<p className="p-6 text-center text-sm text-muted">No spend in this period.</p>} />
          <p className="text-xs text-muted">Measured: invoices and records entered as actuals, plus platform AI cost metered by the shared usage service. Estimated: contract run-rate for months without recorded cost, and estimates you entered. Allocated: shared costs split across departments.</p>
        </div>
      </TabPanel>
      <TabPanel idPrefix="cost" value="records" selected={tab}><RecordsTab records={records} canManage={canManage} tools={tools} vendors={vendors} /></TabPanel>
      <TabPanel idPrefix="cost" value="budgets" selected={tab}><BudgetsTab budgets={budgets} canManage={canManage} tools={tools} vendors={vendors} /></TabPanel>
      <TabPanel idPrefix="cost" value="economics" selected={tab}><EconomicsTab forecast={forecast} units={units} /></TabPanel>
      <TabPanel idPrefix="cost" value="value" selected={tab}><ValueTab value={value} canManage={canManage} tools={tools} /></TabPanel>
    </div>
  );
}

function RecordsTab({ records, canManage, tools, vendors }: { records: Rec[]; canManage: boolean; tools: Array<{ id: string; name: string }>; vendors: Array<{ id: string; name: string }> }) {
  const { run } = useMutation();
  const [add, setAdd] = useState(false);
  const [alloc, setAlloc] = useState<Rec | null>(null);
  const name = (list: Array<{ id: string; name: string }>, id: string | null) => (id ? list.find((x) => x.id === id)?.name ?? "—" : "—");
  const columns: Array<DataTableColumn<Rec>> = [
    { key: "p", header: "Period", cell: (r) => <span className="text-xs">{r.periodStart}{r.periodEnd !== r.periodStart ? ` → ${r.periodEnd}` : ""}</span> },
    { key: "d", header: "Description", cell: (r) => <span>{r.description || human(r.category)}<span className="block text-xs text-muted">{human(r.category)}{r.department ? ` · ${r.department}` : ""}{r.toolId ? ` · ${name(tools, r.toolId)}` : ""}{r.vendorId ? ` · ${name(vendors, r.vendorId)}` : ""}</span></span> },
    { key: "a", header: "Amount", cell: (r) => usd(r.amountUsd, 2) },
    { key: "b", header: "Basis", cell: (r) => <BasisBadge basis={r.basis} /> },
    { key: "s", header: "Status", hideOnMobile: true, cell: (r) => <StatusPill status={r.status} /> },
    ...(canManage ? [{ key: "x", header: "", cell: (r: Rec) => (
      <span className="flex justify-end gap-1">
        {r.status === "active" && !r.parentId && r.amountUsd > 0 && <Button size="sm" variant="ghost" onClick={() => setAlloc(r)}>Allocate</Button>}
        {r.status === "allocated" && <Button size="sm" variant="ghost" onClick={() => run(() => apiFetch(`${OPS}/costs/records/${r.id}/allocation`, { method: "DELETE" }), { success: "Allocation undone" })}>Undo allocation</Button>}
        {r.status === "active" && !r.parentId && <Button size="sm" variant="ghost" onClick={() => run(() => apiFetch(`${OPS}/costs/records/${r.id}`, { method: "DELETE" }), { success: "Record voided" })}>Void</Button>}
      </span>
    ) }] : []),
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">Costs not metered by the platform: subscriptions, invoices, cloud and services. Platform AI inference is metered automatically and never needs entering. Bulk import: <span className="font-mono">POST /api/v1/m/ai-operations/costs/records</span>.</p>
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setAdd(true)}>Add cost</Button>}
      </div>
      <DataTable caption="Cost records" rows={records} getRowId={(r) => r.id} columns={columns} emptyState={<p className="p-6 text-center text-sm text-muted">No cost records.</p>} />
      {add && <AddCost tools={tools} vendors={vendors} onClose={() => setAdd(false)} />}
      {alloc && <AllocateCost r={alloc} onClose={() => setAlloc(null)} />}
    </div>
  );
}

function AddCost({ tools, vendors, onClose }: { tools: Array<{ id: string; name: string }>; vendors: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const t = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ periodStart: `${t.slice(0, 7)}-01`, periodEnd: t, amountUsd: "", category: "subscription", basis: "measured", description: "", toolId: "", vendorId: "", department: "", project: "", externalRef: "" });
  const go = async () => {
    const body = { ...f, amountUsd: Number(f.amountUsd), toolId: f.toolId || null, vendorId: f.vendorId || null, department: f.department || null, project: f.project || null, externalRef: f.externalRef || null };
    if (await run(() => apiFetch(`${OPS}/costs/records`, { body }), { success: "Cost recorded" })) onClose();
  };
  const inp = (k: keyof typeof f, label: string, type = "text") => <FormField id={`ac-${k}`} label={label}>{(x) => <Input {...x} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Modal open onClose={onClose} title="Add a cost" size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.amountUsd} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-3">
        {inp("periodStart", "From", "date")}{inp("periodEnd", "To (inclusive)", "date")}{inp("amountUsd", "Amount (USD)", "number")}
        <FormField id="ac-cat" label="Category">{(x) => <Select {...x} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={opts(CATS)} />}</FormField>
        <FormField id="ac-basis" label="Basis">{(x) => <Select {...x} value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} options={[{ value: "measured", label: "Measured (actual)" }, { value: "estimated", label: "Estimated" }]} />}</FormField>
        {inp("externalRef", "Invoice / reference")}
        <FormField id="ac-tool" label="Tool">{(x) => <Select {...x} value={f.toolId} onChange={(e) => setF({ ...f, toolId: e.target.value })} options={[{ value: "", label: "—" }, ...tools.map((v) => ({ value: v.id, label: v.name }))]} />}</FormField>
        <FormField id="ac-vendor" label="Vendor">{(x) => <Select {...x} value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })} options={[{ value: "", label: "—" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]} />}</FormField>
        {inp("department", "Department")}
        {inp("project", "Project")}
        <FormField id="ac-desc" label="Description" className="sm:col-span-2">{(x) => <Input {...x} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
      </div>
      <p className="mt-2 text-xs text-muted">Multi-month amounts are spread by day across the period.</p>
    </Modal>
  );
}

function AllocateCost({ r, onClose }: { r: Rec; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [method, setMethod] = useState("headcount");
  const [weights, setWeights] = useState("Sales: 1\nFinance: 1");
  const go = async () => {
    const body: Record<string, unknown> = { method };
    if (method === "custom") body.weights = Object.fromEntries(weights.split("\n").map((l) => l.split(":").map((x) => x.trim())).filter((x) => x[0] && x[1]).map(([k, v]) => [k!, Number(v)]));
    if (await run(() => apiFetch(`${OPS}/costs/records/${r.id}/allocation`, { body }), { success: "Cost allocated" })) onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Allocate ${usd(r.amountUsd, 2)}`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={go}>Allocate</Button></div>}>
      <div className="space-y-3">
        <FormField id="al-method" label="Split by">{(x) => <Select {...x} value={method} onChange={(e) => setMethod(e.target.value)} options={[{ value: "headcount", label: "Headcount per department" }, { value: "seats", label: "Licensed seats per department" }, { value: "ai_usage", label: "Metered AI spend per department (same period)" }, { value: "custom", label: "Custom weights" }]} />}</FormField>
        {method === "custom" && <FormField id="al-w" label="Weights" hint="One per line — Department: weight">{(x) => <Textarea {...x} rows={4} value={weights} onChange={(e) => setWeights(e.target.value)} />}</FormField>}
        <p className="text-xs text-muted">The original record stays for the audit trail but no longer counts; the department shares carry the basis “allocated” and sum to the cent.</p>
      </div>
    </Modal>
  );
}

function BudgetsTab({ budgets, canManage, tools, vendors }: { budgets: Budget[]; canManage: boolean; tools: Array<{ id: string; name: string }>; vendors: Array<{ id: string; name: string }> }) {
  const [edit, setEdit] = useState<Budget | "new" | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">{canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit("new")}>New budget</Button>}</div>
      {budgets.length === 0 && <p className="text-sm text-muted">No budgets yet.</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {budgets.map((b) => (
          <Card key={b.id}>
            <CardBody className="space-y-2">
              <div className="flex items-start justify-between gap-2"><span><span className="font-medium">{b.name}</span><span className="block text-xs text-muted">{human(b.scope)}{b.scopeValue ? `: ${b.scope === "tool" ? tools.find((t) => t.id === b.scopeValue)?.name ?? b.scopeValue : b.scope === "vendor" ? vendors.find((v) => v.id === b.scopeValue)?.name ?? b.scopeValue : b.scopeValue}` : ""} · {b.periodLabel}</span></span><StatusPill status={b.status} /></div>
              <div className="h-2 rounded bg-surface-hover"><div className={b.pctSpent >= 100 ? "h-2 rounded bg-danger" : b.crossed.length ? "h-2 rounded bg-warning" : "h-2 rounded bg-accent"} style={{ width: `${Math.min(100, b.pctSpent)}%` }} /></div>
              <p className="text-sm">{usd(b.spent)} of {usd(b.amount)} ({b.pctSpent}%) · run-rate {usd(b.projected)} ({b.projectedPct}%)</p>
              <CostSplit c={b.byBasis} />
              <p className="text-xs text-muted">Alerts at {b.thresholds.join("%, ")}%</p>
              {canManage && <Button size="sm" variant="ghost" onClick={() => setEdit(b)}>Edit</Button>}
            </CardBody>
          </Card>
        ))}
      </div>
      {edit && <BudgetForm budget={edit === "new" ? undefined : edit} tools={tools} vendors={vendors} onClose={() => setEdit(null)} />}
    </div>
  );
}

function BudgetForm({ budget, tools, vendors, onClose }: { budget?: Budget; tools: Array<{ id: string; name: string }>; vendors: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: budget?.name ?? "", scope: budget?.scope ?? "organization", scopeValue: budget?.scopeValue ?? "", period: budget?.period ?? "monthly", amountUsd: String(budget?.amount ?? ""), thresholds: (budget?.thresholds ?? [80, 100]).join(", ") });
  const go = async () => {
    const body = { name: f.name, scope: f.scope, scopeValue: f.scope === "organization" ? null : f.scopeValue, period: f.period, amountUsd: Number(f.amountUsd), thresholds: f.thresholds.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) };
    if (await run(() => apiFetch(budget ? `${OPS}/budgets/${budget.id}` : `${OPS}/budgets`, { method: budget ? "PATCH" : "POST", body }), { success: "Budget saved" })) onClose();
  };
  const valueField = f.scope === "tool" || f.scope === "vendor"
    ? <Select id="bf-v" aria-label="Scope value" value={f.scopeValue} onChange={(e) => setF({ ...f, scopeValue: e.target.value })} options={[{ value: "", label: "Choose…" }, ...(f.scope === "tool" ? tools : vendors).map((x) => ({ value: x.id, label: x.name }))]} />
    : f.scope === "category" ? <Select id="bf-v" aria-label="Scope value" value={f.scopeValue} onChange={(e) => setF({ ...f, scopeValue: e.target.value })} options={[{ value: "", label: "Choose…" }, ...opts(CATS)]} />
      : <Input id="bf-v" aria-label="Scope value" placeholder={f.scope === "model" ? "model key" : f.scope} value={f.scopeValue} onChange={(e) => setF({ ...f, scopeValue: e.target.value })} />;
  return (
    <Modal open onClose={onClose} title={budget ? `Edit ${budget.name}` : "New budget"} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name || !f.amountUsd || (f.scope !== "organization" && !f.scopeValue)} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="bf-name" label="Name">{(x) => <Input {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
        <FormField id="bf-period" label="Period">{(x) => <Select {...x} value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as typeof f.period })} options={opts(["monthly", "quarterly", "annual"])} />}</FormField>
        <FormField id="bf-scope" label="Scope">{(x) => <Select {...x} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as typeof f.scope, scopeValue: "" })} options={opts(["organization", "department", "tool", "vendor", "provider", "model", "category", "project"])} />}</FormField>
        {f.scope !== "organization" ? <div className="flex flex-col gap-1.5"><span className="text-sm font-medium">Applies to</span>{valueField}</div> : <span />}
        <FormField id="bf-amt" label="Amount (USD)">{(x) => <Input {...x} type="number" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} />}</FormField>
        <FormField id="bf-th" label="Alert at (% of budget)">{(x) => <Input {...x} value={f.thresholds} onChange={(e) => setF({ ...f, thresholds: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

function EconomicsTab({ forecast, units }: { forecast: Forecast; units: Units }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Spend forecast" description={forecast[0]?.note ?? "Not enough history yet."} actions={<BasisBadge basis="estimated" />} />
        <CardBody className="grid gap-3 sm:grid-cols-3">
          {forecast.map((f) => <div key={f.month} className="rounded-md border border-border p-3"><p className="text-sm text-muted">{f.month}</p><p className="text-xl font-semibold">{usd(f.forecastUsd)}</p><p className="text-xs text-muted">range {usd(f.lowUsd)} – {usd(f.highUsd)}</p></div>)}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Unit economics" description={units.window.note} />
        <CardBody>
          <DataTable caption="Unit economics" rows={units.metrics} getRowId={(m) => m.key} columns={[
            { key: "l", header: "Metric", cell: (m) => <span><span className="font-medium">{m.label}</span><span className="block text-xs text-muted">per {m.unit} · {m.denominatorNote}</span></span> },
            { key: "d", header: "Units", cell: (m) => (m.denominator == null ? "—" : m.denominator.toLocaleString("en-US")) },
            { key: "m", header: "Measured", cell: (m) => usd(m.perUnit?.measured ?? null, 2) },
            { key: "e", header: "Estimated", cell: (m) => usd(m.perUnit?.estimated ?? null, 2) },
            { key: "a", header: "Allocated", cell: (m) => usd(m.perUnit?.allocated ?? null, 2) },
            { key: "t", header: "Total", cell: (m) => <span className="font-medium">{usd(m.total, 2)}</span> },
          ]} />
        </CardBody>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Cost per model run" description="Last 30 days" />
          <CardBody className="space-y-1">
            {units.perModel.length === 0 && <p className="text-sm text-muted">No metered runs.</p>}
            {units.perModel.map((m) => <div key={m.key} className="flex items-center justify-between gap-2 text-sm"><span className="font-mono text-xs">{m.label}</span><span>{usd(m.total, 4)} <span className="text-xs text-muted">× {m.denominator?.toLocaleString("en-US")} runs</span></span></div>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Cost per department member" description="Last 30 days" />
          <CardBody className="space-y-1">
            {units.perDepartment.map((m) => <div key={m.key} className="flex items-center justify-between gap-2 text-sm"><span>{m.label}</span><span>{usd(m.total, 2)} <span className="text-xs text-muted">({usd(m.cost.measured + m.cost.estimated + m.cost.allocated)} total)</span></span></div>)}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function ValueTab({ value, canManage, tools }: { value: Value[]; canManage: boolean; tools: Array<{ id: string; name: string }> }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ kind: "realized", title: "", annualValueUsd: "", description: "", department: "", toolId: "" });
  const realized = value.filter((v) => v.kind === "realized").reduce((a, v) => a + v.annualValueUsd, 0);
  const projected = value.filter((v) => v.kind === "projected").reduce((a, v) => a + v.annualValueUsd, 0);
  const go = async () => {
    if (await run(() => apiFetch(`${OPS}/value`, { body: { ...f, annualValueUsd: Number(f.annualValueUsd), department: f.department || null, toolId: f.toolId || null } }), { success: "Value recorded" })) setF({ ...f, title: "", annualValueUsd: "", description: "" });
  };
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Value ledger" description={`${usd(realized)} realized per year (measured) · ${usd(projected)} projected (estimated). Workflow Intelligence ROI measurements arrive automatically; the latest one per implementation counts.`} />
        <CardBody className="space-y-2">
          {value.length === 0 && <p className="text-sm text-muted">No value recorded yet.</p>}
          {value.map((v) => <div key={v.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2 text-sm last:border-0"><span><span className="font-medium">{v.title}</span><span className="block text-xs text-muted">{human(v.sourceModule)}{v.department ? ` · ${v.department}` : ""} · {v.recordedAt.slice(0, 10)}</span></span><span className="flex items-center gap-2">{usd(v.annualValueUsd)}/yr<BasisBadge basis={v.basis} /></span></div>)}
        </CardBody>
      </Card>
      {canManage && (
        <Card>
          <CardHeader title="Record value" />
          <CardBody className="space-y-3">
            <FormField id="vl-kind" label="Kind">{(x) => <Select {...x} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={[{ value: "realized", label: "Realized (measured)" }, { value: "projected", label: "Projected (estimated)" }]} />}</FormField>
            <FormField id="vl-title" label="Title">{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
            <FormField id="vl-amt" label="Annual value (USD)">{(x) => <Input {...x} type="number" value={f.annualValueUsd} onChange={(e) => setF({ ...f, annualValueUsd: e.target.value })} />}</FormField>
            <FormField id="vl-tool" label="Tool">{(x) => <Select {...x} value={f.toolId} onChange={(e) => setF({ ...f, toolId: e.target.value })} options={[{ value: "", label: "—" }, ...tools.map((t) => ({ value: t.id, label: t.name }))]} />}</FormField>
            <FormField id="vl-dept" label="Department">{(x) => <Input {...x} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />}</FormField>
            <FormField id="vl-desc" label="How it was measured">{(x) => <Textarea {...x} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
            <Button loading={pending} disabled={!f.title || !f.annualValueUsd} onClick={go}>Record</Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
