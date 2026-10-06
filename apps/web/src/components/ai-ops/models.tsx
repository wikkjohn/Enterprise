"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Card, CardBody, CardHeader, DataTable, FormField, Input, Modal, Select, Textarea } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { ActionButton, useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { BasisBadge, human, num, OPS, opts, SeverityBadge, StatusPill, usd } from "./common";

type Report = Awaited<ReturnType<AiOpsService["modelReport"]>>;
type Policy = Awaited<ReturnType<AiOpsService["listPolicies"]>>[number];
type Finding = Awaited<ReturnType<AiOpsService["listFindings"]>>[number];

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function ModelsView({ report, policies, canAdmin }: { report: Report; policies: Policy[]; canAdmin: boolean }) {
  const [edit, setEdit] = useState<Policy | "new" | null>(null);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Model spend" description="Last 30 days, from the shared AI run log." actions={<BasisBadge basis="measured" />} />
          <CardBody>
            <DataTable caption="Model spend" rows={report.models} getRowId={(m) => m.model} columns={[
              { key: "m", header: "Model", cell: (m) => <span><span className="font-mono text-xs">{m.model}</span><span className="block text-xs text-muted">{m.tier}</span></span> },
              { key: "r", header: "Runs", cell: (m) => num(m.runs) },
              { key: "c", header: "Cost", cell: (m) => usd(m.cost, 2) },
              { key: "u", header: "Per run", cell: (m) => usd(m.costPerRun, 4) },
              { key: "l", header: "Median latency", hideOnMobile: true, cell: (m) => (m.p50 == null ? "—" : `${num(m.p50)} ms`) },
            ]} emptyState={<p className="p-6 text-center text-sm text-muted">No AI runs in the last 30 days.</p>} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Spend by task" description="Use cases reported by calling modules, with the policy that governs each." />
          <CardBody className="space-y-1">
            {report.useCases.length === 0 && <p className="text-sm text-muted">No runs yet.</p>}
            {report.useCases.slice(0, 15).map((u) => (
              <div key={`${u.moduleId}|${u.useCase}`} className="flex items-start justify-between gap-2 border-b border-border py-1 text-sm last:border-0">
                <span><span className="font-mono text-xs">{u.useCase}</span><span className="block text-xs text-muted">{human(u.moduleId)} · {u.models.join(", ")}</span></span>
                <span className="text-right">{usd(u.cost, 2)}<span className="block text-xs text-muted">{u.policy ?? "no policy"}</span></span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Model routing policies" description="Business rules for which models a task may use (quality tier, cost, latency, data classification, providers). Enforced policies are applied by the shared AI layer; advisory ones only report. If nothing qualifies, matching requests fail rather than fall back." actions={canAdmin ? <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit("new")}>New policy</Button> : undefined} />
        <CardBody className="space-y-3">
          {policies.length === 0 && <p className="text-sm text-muted">No policies. Example: classification tasks → economy models; legal review of confidential data → an approved premium model.</p>}
          {policies.map((p) => {
            const c = report.compliance.find((x) => x.policyId === p.id);
            return (
              <div key={p.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.name}</span><StatusPill status={p.status === "active" ? p.enforcement : "disabled"} /><span className="text-xs text-muted">priority {p.priority}</span><span className="flex-1" />{canAdmin && <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Edit</Button>}</div>
                <p className="text-xs text-muted">Tasks {p.match.useCases.join(", ") || "any"} · modules {p.match.modules.join(", ") || "any"} · data {p.match.dataClassifications.join(", ") || "any"}</p>
                <p className="text-xs">Allowed tiers {p.rules.allowedTiers.join(", ") || "any"}{p.rules.preferredTier ? ` · prefers ${p.rules.preferredTier}` : ""}{p.rules.maxCostPerMtok != null ? ` · ≤ $${p.rules.maxCostPerMtok}/Mtok` : ""}{p.rules.maxLatencyMs != null ? ` · ≤ ${p.rules.maxLatencyMs} ms` : ""}{p.rules.allowedProviders.length ? ` · providers ${p.rules.allowedProviders.join(", ")}` : ""}</p>
                <p className="text-xs">Qualifying models now: {p.allowedModels.length ? <span className="font-mono">{p.allowedModels.join(", ")}</span> : <span className={p.enforcement === "enforced" && p.status === "active" ? "text-danger" : "text-warning"}>none — {p.enforcement === "enforced" && p.status === "active" ? "matching requests fail" : "matching requests would fail if this were enforced"}</span>}</p>
                {p.regulatoryNote && <p className="text-xs text-muted">Regulatory: {p.regulatoryNote}</p>}
                {c && <p className="text-xs">Last 30 days: {num(c.compliantRuns)} of {num(c.runs)} runs complied{c.potentialSavings ? ` · ${usd(c.potentialSavings, 2)} could have been saved` : ""}{c.nonCompliant.length ? ` · non-compliant: ${c.nonCompliant.slice(0, 3).map((n) => `${n.model} (${n.reason})`).join("; ")}` : ""}</p>}
              </div>
            );
          })}
        </CardBody>
      </Card>
      {edit && <PolicyForm policy={edit === "new" ? undefined : edit} catalog={report.catalog} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PolicyForm({ policy, catalog, onClose }: { policy?: Policy; catalog: Report["catalog"]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [warning, setWarning] = useState<string | null>(null);
  const [f, setF] = useState({
    name: policy?.name ?? "", description: policy?.description ?? "", priority: String(policy?.priority ?? 100), enforcement: policy?.enforcement ?? "advisory", status: policy?.status ?? "active",
    useCases: (policy?.match.useCases ?? []).join(", "), modules: (policy?.match.modules ?? []).join(", "), dataClassifications: (policy?.match.dataClassifications ?? []).join(", "),
    allowedTiers: (policy?.rules.allowedTiers ?? []).join(", "), preferredTier: policy?.rules.preferredTier ?? "", allowedModels: (policy?.rules.allowedModels ?? []).join(", "), blockedModels: (policy?.rules.blockedModels ?? []).join(", "),
    allowedProviders: (policy?.rules.allowedProviders ?? []).join(", "), requiredCapabilities: (policy?.rules.requiredCapabilities ?? []).join(", "), maxCostPerMtok: policy?.rules.maxCostPerMtok?.toString() ?? "", maxLatencyMs: policy?.rules.maxLatencyMs?.toString() ?? "", regulatoryNote: policy?.regulatoryNote ?? "",
  });
  const go = async () => {
    const body = {
      name: f.name, description: f.description, priority: Number(f.priority) || 100, enforcement: f.enforcement, status: f.status, regulatoryNote: f.regulatoryNote || null,
      match: { useCases: csv(f.useCases), modules: csv(f.modules), dataClassifications: csv(f.dataClassifications) },
      rules: { allowedTiers: csv(f.allowedTiers), preferredTier: f.preferredTier || null, allowedModels: csv(f.allowedModels), blockedModels: csv(f.blockedModels), allowedProviders: csv(f.allowedProviders), requiredCapabilities: csv(f.requiredCapabilities), maxCostPerMtok: f.maxCostPerMtok ? Number(f.maxCostPerMtok) : null, maxLatencyMs: f.maxLatencyMs ? Number(f.maxLatencyMs) : null },
    };
    const r = await run(() => apiFetch<{ warning: string | null }>(policy ? `${OPS}/model-policies/${policy.id}` : `${OPS}/model-policies`, { method: policy ? "PATCH" : "POST", body }), { success: "Policy saved" });
    if (r?.warning) setWarning(r.warning);
    else if (r) onClose();
  };
  const inp = (k: keyof typeof f, label: string, hint?: string) => <FormField id={`pf-${k}`} label={label} hint={hint}>{(x) => <Input {...x} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Modal open onClose={onClose} title={policy ? `Edit ${policy.name}` : "New model policy"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={pending} disabled={!f.name} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-3">
        {inp("name", "Name")}
        <FormField id="pf-enf" label="Enforcement">{(x) => <Select {...x} value={f.enforcement} onChange={(e) => setF({ ...f, enforcement: e.target.value as typeof f.enforcement })} options={[{ value: "advisory", label: "Advisory (report only)" }, { value: "enforced", label: "Enforced by the AI layer" }]} />}</FormField>
        <FormField id="pf-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["active", "disabled"])} />}</FormField>
        {inp("useCases", "Tasks (use cases)", "e.g. *.classify, legal.*")}{inp("modules", "Modules", "empty = any")}{inp("dataClassifications", "Data classifications", "e.g. confidential, restricted")}
        {inp("allowedTiers", "Allowed tiers", "economy, standard, premium")}
        <FormField id="pf-pref" label="Preferred tier">{(x) => <Select {...x} value={f.preferredTier} onChange={(e) => setF({ ...f, preferredTier: e.target.value })} options={[{ value: "", label: "None" }, ...opts(["economy", "standard", "premium"])]} />}</FormField>
        {inp("priority", "Priority", "lower wins")}
        {inp("allowedModels", "Allowed models", "provider/model, comma separated")}{inp("blockedModels", "Blocked models")}{inp("allowedProviders", "Allowed providers", "residency / regulatory")}
        {inp("requiredCapabilities", "Required capabilities")}{inp("maxCostPerMtok", "Max $ per M tokens", "input + output list price")}{inp("maxLatencyMs", "Max median latency (ms)")}
        <FormField id="pf-reg" label="Regulatory note" className="sm:col-span-3">{(x) => <Textarea {...x} rows={2} value={f.regulatoryNote} onChange={(e) => setF({ ...f, regulatoryNote: e.target.value })} />}</FormField>
      </div>
      <p className="mt-2 text-xs text-muted">Models available now: {catalog.map((c) => `${c.providerKey}/${c.modelKey} (${c.tier})`).join(", ") || "none"}</p>
      {warning && <p className="mt-2 text-sm text-danger">{warning}</p>}
    </Modal>
  );
}

export function OptimizationView({ findings, canManage }: { findings: Finding[]; canManage: boolean }) {
  const { run } = useMutation();
  const [status, setStatus] = useState("open");
  const shown = findings.filter((f) => status === "all" || f.status === status);
  const total = shown.filter((f) => f.status === "open" || f.status === "accepted").reduce((a, f) => a + f.estimatedAnnualSavings, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} options={[...opts(["open", "accepted", "dismissed", "resolved"]), { value: "all", label: "All" }]} />
        <p className="flex-1 text-sm">Estimated annual savings in view: <span className="font-semibold">{usd(total)}</span> <BasisBadge basis="estimated" /></p>
        {canManage && <ActionButton variant="secondary" path={`${OPS}/optimization/scan`} body={{}} success="Scan complete">Scan now</ActionButton>}
      </div>
      <p className="text-xs text-muted">Recommendations only. Nothing is switched, revoked or cancelled automatically.</p>
      {shown.length === 0 && <p className="text-sm text-muted">No findings.</p>}
      <div className="space-y-3">
        {shown.map((f) => (
          <Card key={f.id}>
            <CardBody className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2"><SeverityBadge value={f.severity} /><span className="font-medium">{f.title}</span><StatusPill status={f.status} /><span className="flex-1" /><span className="font-semibold">{usd(f.estimatedAnnualSavings)}/yr</span></div>
              <p className="text-muted">{f.detail}</p>
              <p><span className="font-medium">Recommendation:</span> {f.recommendation}</p>
              {f.note && <p className="text-xs text-muted">Note: {f.note}</p>}
              {canManage && (
                <div className="flex gap-2 pt-1">
                  {f.status === "open" && <Button size="sm" onClick={() => run(() => apiFetch(`${OPS}/optimization/${f.id}`, { method: "PATCH", body: { status: "accepted" } }), { success: "Accepted" })}>Accept</Button>}
                  {(f.status === "open" || f.status === "accepted") && <Button size="sm" variant="secondary" onClick={() => run(() => apiFetch(`${OPS}/optimization/${f.id}`, { method: "PATCH", body: { status: "resolved", note: "Actioned." } }), { success: "Marked done" })}>Mark done</Button>}
                  {f.status === "open" && <Button size="sm" variant="ghost" onClick={() => run(() => apiFetch(`${OPS}/optimization/${f.id}`, { method: "PATCH", body: { status: "dismissed" } }), { success: "Dismissed" })}>Dismiss</Button>}
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
