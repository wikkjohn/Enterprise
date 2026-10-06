"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Card, CardBody, CardHeader, FormField, Input, Modal, Select, TabPanel, Tabs, Textarea } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { human, OPS, opts, StatusPill } from "./common";

type Item = Awaited<ReturnType<AiOpsService["listCoe"]>>[number];
type Template = Awaited<ReturnType<AiOpsService["listTemplates"]>>[number];
type Settings = Awaited<ReturnType<AiOpsService["getSettings"]>>;
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function CoeView({ items, templates, approvedTools, approvedModels, pendingRequests, canAdmin }: {
  items: Item[]; templates: Template[]; approvedTools: Array<{ id: string; name: string; status: string }>; approvedModels: string[]; pendingRequests: number; canAdmin: boolean;
}) {
  const [tab, setTab] = useState("library");
  const [editItem, setEditItem] = useState<Item | "new" | null>(null);
  const [editTpl, setEditTpl] = useState<Template | "new" | null>(null);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardBody><p className="text-sm text-muted">Approved tools</p><p className="text-2xl font-semibold">{approvedTools.length}</p><Link className="text-xs text-accent hover:underline" href={`${OPS}/tools`}>Inventory</Link></CardBody></Card>
        <Card><CardBody><p className="text-sm text-muted">Models allowed by policy</p><p className="text-2xl font-semibold">{approvedModels.length}</p><Link className="text-xs text-accent hover:underline" href={`${OPS}/models`}>Model policies</Link></CardBody></Card>
        <Card><CardBody><p className="text-sm text-muted">Implementation templates</p><p className="text-2xl font-semibold">{templates.filter((t) => t.status === "published").length}</p><span className="text-xs text-muted">published</span></CardBody></Card>
        <Card><CardBody><p className="text-sm text-muted">Requests in review</p><p className="text-2xl font-semibold">{pendingRequests}</p><Link className="text-xs text-accent hover:underline" href={`${OPS}/requests`}>Requests</Link></CardBody></Card>
      </div>
      <Tabs ariaLabel="Center of Excellence" idPrefix="coe" value={tab} onChange={setTab} items={[{ value: "library", label: "Standards & guidance" }, { value: "templates", label: "Implementation library" }]} />
      <TabPanel idPrefix="coe" value="library" selected={tab}>
        <div className="space-y-3">
          <div className="flex justify-end">{canAdmin && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditItem("new")}>New item</Button>}</div>
          {items.length === 0 && <p className="text-sm text-muted">No standards, policies or guidance published yet.</p>}
          {(["standard", "policy", "guidance", "best_practice"] as const).map((k) => {
            const list = items.filter((i) => i.kind === k);
            if (!list.length) return null;
            return (
              <Card key={k}>
                <CardHeader title={`${human(k)}s`.replace("best practices", "Best practices")} />
                <CardBody className="space-y-3">
                  {list.map((i) => (
                    <details key={i.id} className="rounded-md border border-border p-3">
                      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium">{i.title}<StatusPill status={i.status} />{i.reviewOverdue && <span className="text-xs text-warning">review overdue</span>}{canAdmin && <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); setEditItem(i); }}>Edit</Button>}</summary>
                      <div className="mt-2 whitespace-pre-wrap text-sm">{i.body}</div>
                    </details>
                  ))}
                </CardBody>
              </Card>
            );
          })}
        </div>
      </TabPanel>
      <TabPanel idPrefix="coe" value="templates" selected={tab}>
        <div className="space-y-3">
          <div className="flex items-center gap-2"><p className="flex-1 text-sm text-muted">Reusable implementation patterns. Starter patterns are drafts until the Center of Excellence publishes them.</p>{canAdmin && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditTpl("new")}>New template</Button>}</div>
          <div className="grid gap-4 lg:grid-cols-2">
            {templates.map((t) => (
              <Card key={t.id}>
                <CardHeader title={t.name} description={`${human(t.category)} · ${t.riskLevel} risk`} actions={<span className="flex items-center gap-2"><StatusPill status={t.status} />{canAdmin && <Button size="sm" variant="ghost" onClick={() => setEditTpl(t)}>Edit</Button>}</span>} />
                <CardBody className="space-y-2 text-sm">
                  <p><span className="font-medium">Objective:</span> {t.businessObjective}</p>
                  <p><span className="font-medium">Systems:</span> {t.systems.join("; ") || "—"}</p>
                  <p><span className="font-medium">Data:</span> {t.data || "—"}</p>
                  <p><span className="font-medium">AI capability:</span> {t.aiCapability}</p>
                  <p><span className="font-medium">Risks:</span> {t.risks}</p>
                  <div><p className="font-medium">Implementation</p><ol className="list-decimal pl-5 text-muted">{t.implementation.map((s, i) => <li key={i}>{s}</li>)}</ol></div>
                  <div><p className="font-medium">Measurement</p><ul className="list-disc pl-5 text-muted">{t.measurement.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                  {t.workflowRefs.length > 0 && <p className="text-xs">Workflows: {t.workflowRefs.map((w) => <Link key={w} className="mr-2 text-accent hover:underline" href={`/m/workflow-intelligence/workflows/${w}`}>{w.slice(0, 8)}</Link>)}</p>}
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </TabPanel>
      {editItem && <ItemForm i={editItem === "new" ? undefined : editItem} onClose={() => setEditItem(null)} />}
      {editTpl && <TemplateForm t={editTpl === "new" ? undefined : editTpl} onClose={() => setEditTpl(null)} />}
    </div>
  );
}

function ItemForm({ i, onClose }: { i?: Item; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ kind: i?.kind ?? "standard", title: i?.title ?? "", body: i?.body ?? "", status: i?.status ?? "draft", reviewDate: i?.reviewDate ?? "" });
  const go = async () => {
    if (await run(() => apiFetch(i ? `${OPS}/coe/${i.id}` : `${OPS}/coe`, { method: i ? "PATCH" : "POST", body: { ...f, reviewDate: f.reviewDate || null } }), { success: "Saved" })) onClose();
  };
  return (
    <Modal open onClose={onClose} title={i ? `Edit ${i.title}` : "New Center of Excellence item"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.title} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="ci-kind" label="Kind">{(x) => <Select {...x} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })} options={opts(["standard", "policy", "guidance", "best_practice"])} />}</FormField>
        <FormField id="ci-title" label="Title">{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
        <FormField id="ci-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["draft", "published", "retired"])} />}</FormField>
        <FormField id="ci-review" label="Next review">{(x) => <Input {...x} type="date" value={f.reviewDate} onChange={(e) => setF({ ...f, reviewDate: e.target.value })} />}</FormField>
        <FormField id="ci-body" label="Content" className="sm:col-span-2">{(x) => <Textarea {...x} rows={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

function TemplateForm({ t, onClose }: { t?: Template; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: t?.name ?? "", category: t?.category ?? "other", businessObjective: t?.businessObjective ?? "", systems: (t?.systems ?? []).join("\n"), data: t?.data ?? "", aiCapability: t?.aiCapability ?? "", riskLevel: t?.riskLevel ?? "medium", risks: t?.risks ?? "", implementation: (t?.implementation ?? []).join("\n"), measurement: (t?.measurement ?? []).join("\n"), workflowRefs: (t?.workflowRefs ?? []).join("\n"), status: t?.status ?? "draft" });
  const go = async () => {
    const body = { ...f, systems: lines(f.systems), implementation: lines(f.implementation), measurement: lines(f.measurement), workflowRefs: lines(f.workflowRefs) };
    if (await run(() => apiFetch(t ? `${OPS}/templates/${t.id}` : `${OPS}/templates`, { method: t ? "PATCH" : "POST", body }), { success: "Template saved" })) onClose();
  };
  const ta = (k: keyof typeof f, label: string, hint?: string) => <FormField id={`tp-${k}`} label={label} hint={hint} className="sm:col-span-2">{(x) => <Textarea {...x} rows={3} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Modal open onClose={onClose} title={t ? `Edit ${t.name}` : "New implementation template"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="tp-name" label="Name">{(x) => <Input {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
        <FormField id="tp-cat" label="Category">{(x) => <Input {...x} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />}</FormField>
        <FormField id="tp-risk" label="Risk">{(x) => <Select {...x} value={f.riskLevel} onChange={(e) => setF({ ...f, riskLevel: e.target.value as typeof f.riskLevel })} options={opts(["low", "medium", "high"])} />}</FormField>
        <FormField id="tp-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["draft", "published", "retired"])} />}</FormField>
        {ta("businessObjective", "Business objective")}{ta("systems", "Systems", "One per line")}{ta("data", "Data")}{ta("aiCapability", "AI capability")}{ta("risks", "Risks")}
        {ta("implementation", "Implementation steps", "One per line")}{ta("measurement", "Measurement", "One per line")}{ta("workflowRefs", "Workflow Intelligence workflow ids", "One per line")}
      </div>
    </Modal>
  );
}

export function OpsSettingsForm({ s }: { s: Settings }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)])) as Record<keyof Settings, string>);
  const field = (k: keyof Settings, label: string, hint: string) => <FormField id={`os-${k}`} label={label} hint={hint}>{(x) => <Input {...x} type="number" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {field("fiscalYearStartMonth", "Fiscal year starts in month", "1 = January; quarterly and annual budgets follow it")}
          {field("renewalNoticeDays", "Renewal alert window (days)", "Alert this long before a contract renews (at least notice period + 14 days)")}
          {field("unusedLicenseDays", "Unused license after (days)", "No activity for this long counts as unused")}
          {field("costSpikePct", "Cost spike threshold (%)", "Week-over-baseline increase that raises a finding")}
          {field("contractUtilizationFloorPct", "Contract utilization floor (%)", "Committed contracts used less than this raise a finding")}
          {field("adoptionMinGroup", "Minimum group size for adoption", "Smaller groups are hidden (privacy)")}
        </div>
        <Button loading={pending} onClick={() => run(() => apiFetch(`${OPS}/settings`, { method: "PATCH", body: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)])) }), { success: "Settings saved" })}>Save settings</Button>
      </CardBody>
    </Card>
  );
}
