"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, DataTable, FormField, Input, Modal, Select, Switch, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type DataSecurityService } from "@eaop/module-data-security";
import { ActionButton, useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { DecisionBadge, DS, fmtNum, opts, SensitivityBadge } from "./common";

type Rule = Awaited<ReturnType<DataSecurityService["listRules"]>>[number];
type Settings = Awaited<ReturnType<DataSecurityService["getSettings"]>>;
const DECISIONS = ["ALLOW", "REDACT", "REQUIRE_APPROVAL", "BLOCK"];

export function ClassificationsView({ rules, settings, canManage, canPolicy }: { rules: Rule[]; settings: Settings; canManage: boolean; canPolicy: boolean }) {
  const [edit, setEdit] = useState<Rule | "new" | null>(null);
  const columns: Array<DataTableColumn<Rule>> = [
    { key: "l", header: "Classification", cell: (r) => <span><span className="font-medium">{r.label}</span> {!r.builtin && <Badge tone="info">custom</Badge>}{r.builtin && r.customized && <Badge>customized</Badge>}<span className="block text-xs text-muted">{r.builtin ? "Built-in detectors" : [r.patterns.length && `${r.patterns.length} pattern(s)`, r.keywords.length && `${r.keywords.length} keyword(s)`].filter(Boolean).join(" · ")}</span></span> },
    { key: "s", header: "Sensitivity", cell: (r) => <SensitivityBadge value={r.sensitivity} /> },
    { key: "a", header: "Approved AI", cell: (r) => <DecisionBadge value={r.actionApproved} /> },
    { key: "u", header: "Unapproved AI", cell: (r) => <DecisionBadge value={r.actionUnapproved} /> },
    { key: "c", header: "Min. confidence", hideOnMobile: true, cell: (r) => r.minConfidence },
    { key: "m", header: "Redaction", hideOnMobile: true, cell: (r) => r.redactionMode },
    { key: "e", header: "Enabled", hideOnMobile: true, cell: (r) => (r.enabled ? "yes" : "no") },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Classifications and DLP actions" description="What happens when a category is detected in content headed to AI. Organization ai_dlp policies (Administration → Policies) can only make these stricter." actions={canManage ? <Button size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setEdit("new")}>Custom classification</Button> : undefined} />
        <DataTable columns={columns} rows={rules} getRowId={(r) => r.key} onRowClick={canManage ? setEdit : undefined} rowLabel={(r) => `Edit ${r.label}`} caption="Classifications" />
      </Card>
      <SettingsCard settings={settings} canPolicy={canPolicy} />
      {edit && <RuleModal rule={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RuleModal({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const { run, pending } = useMutation();
  const builtin = rule?.builtin ?? false;
  const [f, setF] = useState({
    key: rule?.key ?? "", label: rule?.label ?? "", description: rule?.description ?? "", sensitivity: rule?.sensitivity ?? "confidential", patterns: (rule?.patterns ?? []).join("\n"), keywords: (rule?.keywords ?? []).join(", "),
    confidence: rule?.confidence ?? "medium", actionApproved: rule?.actionApproved ?? "REDACT", actionUnapproved: rule?.actionUnapproved ?? "BLOCK", minConfidence: rule?.minConfidence ?? "medium", redactionMode: rule?.redactionMode ?? "label", enabled: rule?.enabled ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, patterns: f.patterns.split("\n").map((p) => p.trim()).filter(Boolean), keywords: f.keywords.split(",").map((k) => k.trim()).filter(Boolean) };
    if (await run(() => apiFetch(`${DS}/rules`, { body }), { success: "Classification saved" })) onClose();
  };
  return (
    <Modal open onClose={onClose} size="lg" title={rule ? `Edit: ${rule.label}` : "New custom classification"} footer={
      <div className="flex justify-between gap-2">
        <span>{rule?.customized && <ActionButton variant="ghost" method="DELETE" path={`${DS}/rules/${rule.key}`} success={builtin ? "Reset to defaults" : "Deleted"} confirm={{ title: builtin ? "Reset to defaults?" : "Delete this classification?", message: builtin ? "The built-in DLP actions apply again." : "Existing classifications on assets stay until the next scan.", confirmLabel: builtin ? "Reset" : "Delete" }}>{builtin ? "Reset to defaults" : "Delete"}</ActionButton>}</span>
        <span className="flex gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></span>
      </div>
    }>
      <div className="grid gap-3 sm:grid-cols-2">
        {!builtin && (
          <>
            <FormField id="r-key" label="Key" hint="lowercase, e.g. project_codes" required>{(x) => <Input {...x} value={f.key} disabled={!!rule} onChange={set("key")} />}</FormField>
            <FormField id="r-label" label="Label" required>{(x) => <Input {...x} value={f.label} onChange={set("label")} />}</FormField>
            <FormField id="r-sens" label="Sensitivity">{(x) => <Select {...x} value={f.sensitivity} onChange={set("sensitivity")} options={opts(["public", "internal", "confidential", "restricted"])} />}</FormField>
            <FormField id="r-conf" label="Detection confidence">{(x) => <Select {...x} value={f.confidence} onChange={set("confidence")} options={opts(["low", "medium", "high"])} />}</FormField>
            <FormField id="r-pat" label="Patterns (one regular expression per line)" hint="No nested quantifiers or backreferences; max 200 characters" className="sm:col-span-2">{(x) => <Textarea {...x} rows={3} className="font-mono text-xs" value={f.patterns} onChange={set("patterns")} />}</FormField>
            <FormField id="r-kw" label="Keywords (comma-separated)" className="sm:col-span-2">{(x) => <Input {...x} value={f.keywords} onChange={set("keywords")} />}</FormField>
          </>
        )}
        <FormField id="r-aa" label="Action for approved AI">{(x) => <Select {...x} value={f.actionApproved} onChange={set("actionApproved")} options={DECISIONS.map((d) => ({ value: d, label: d.replace("_", " ").toLowerCase() }))} />}</FormField>
        <FormField id="r-au" label="Action for unapproved AI">{(x) => <Select {...x} value={f.actionUnapproved} onChange={set("actionUnapproved")} options={DECISIONS.map((d) => ({ value: d, label: d.replace("_", " ").toLowerCase() }))} />}</FormField>
        <FormField id="r-min" label="Minimum confidence to act">{(x) => <Select {...x} value={f.minConfidence} onChange={set("minConfidence")} options={opts(["low", "medium", "high"])} />}</FormField>
        <FormField id="r-mode" label="Redaction mode">{(x) => <Select {...x} value={f.redactionMode} onChange={set("redactionMode")} options={[{ value: "mask", label: "Mask (e.g. ***-**-6789)" }, { value: "tokenize", label: "Tokenize (consistent, non-reversible)" }, { value: "label", label: "Replacement label ([SSN])" }]} />}</FormField>
        <div className="flex items-center gap-2 sm:col-span-2"><Switch checked={f.enabled} onCheckedChange={(v) => setF({ ...f, enabled: v })} aria-label="Enabled" /><span className="text-sm">Enabled</span></div>
      </div>
    </Modal>
  );
}

function SettingsCard({ settings, canPolicy }: { settings: Settings; canPolicy: boolean }) {
  const { run, pending } = useMutation();
  const [s, setS] = useState({ contentRetention: settings.contentRetention, largeExportChars: String(settings.largeExportChars), abnormalBlockedPerHour: String(settings.abnormalBlockedPerHour), broadGroupSize: String(settings.broadGroupSize) });
  const save = () => void run(() => apiFetch(`${DS}/settings`, { method: "PATCH", body: { contentRetention: s.contentRetention, largeExportChars: Number(s.largeExportChars), abnormalBlockedPerHour: Number(s.abnormalBlockedPerHour), broadGroupSize: Number(s.broadGroupSize) } }), { success: "Settings saved" });
  return (
    <Card>
      <CardHeader title="Privacy and thresholds" description="Raw sensitive content is never stored. Choose whether DLP events keep a short label-redacted preview (also subject to the organization's AI prompt retention)." />
      <CardBody className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FormField id="s-ret" label="DLP content retention">{(x) => <Select {...x} disabled={!canPolicy} value={s.contentRetention} onChange={(e) => setS({ ...s, contentRetention: e.target.value as typeof s.contentRetention })} options={[{ value: "redacted_preview", label: "Label-redacted preview" }, { value: "none", label: "Fingerprint and detections only" }]} />}</FormField>
        <FormField id="s-large" label="Large export (characters)">{(x) => <Input {...x} disabled={!canPolicy} type="number" value={s.largeExportChars} onChange={(e) => setS({ ...s, largeExportChars: e.target.value })} />}</FormField>
        <FormField id="s-abn" label="Abnormal activity (blocks per hour)">{(x) => <Input {...x} disabled={!canPolicy} type="number" value={s.abnormalBlockedPerHour} onChange={(e) => setS({ ...s, abnormalBlockedPerHour: e.target.value })} />}</FormField>
        <FormField id="s-grp" label="Broad group size">{(x) => <Input {...x} disabled={!canPolicy} type="number" value={s.broadGroupSize} onChange={(e) => setS({ ...s, broadGroupSize: e.target.value })} />}</FormField>
        <p className="text-xs text-muted sm:col-span-2 xl:col-span-4">Tokenization key: {settings.tokenizationKeyConfigured ? "stored in the shared secret store" : "created on first use"} · large exports to non-approved AI need approval above {fmtNum(settings.largeExportChars)} characters.</p>
        {canPolicy && <div><Button loading={pending} onClick={save}>Save settings</Button></div>}
      </CardBody>
    </Card>
  );
}
