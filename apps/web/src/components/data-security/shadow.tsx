"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Radio } from "lucide-react";
import { BarChart, Button, Card, CardBody, CardHeader, DataTable, EmptyState, FormField, Input, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type DataSecurityService, type ToolView } from "@eaop/module-data-security";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { DS, fmtNum, human, opts, SeverityBadge, StatusPill } from "./common";

type Tools = Awaited<ReturnType<DataSecurityService["listTools"]>>;
type ToolDetail = Awaited<ReturnType<DataSecurityService["getTool"]>>;
const STATUSES = ["approved", "experimental", "unknown", "restricted", "blocked"] as const;

export function ShadowAi({ data, canManage }: { data: Tools; canManage: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [add, setAdd] = useState(false);
  const rows = data.tools.filter((t) => t.category !== "platform" && (!status || t.status === status));
  const columns: Array<DataTableColumn<ToolView>> = [
    { key: "n", header: "Tool", cell: (t) => <span><span className="font-medium">{t.vendor} {t.name !== t.vendor ? t.name : ""}</span><span className="block text-xs text-muted">{human(t.category)} · {t.domains.slice(0, 2).join(", ")}</span></span> },
    { key: "s", header: "Status", cell: (t) => <StatusPill status={t.status} /> },
    { key: "r", header: "Risk", sortable: true, sortValue: (t) => t.riskScore, cell: (t) => <span className="flex items-center gap-1"><SeverityBadge value={t.riskLevel} /><span className="text-xs text-muted">{t.riskScore}</span></span> },
    { key: "u", header: "Users", align: "right", sortable: true, sortValue: (t) => t.userCount, cell: (t) => fmtNum(t.userCount) },
    { key: "d", header: "Departments", hideOnMobile: true, cell: (t) => <span className="text-xs">{t.departments.join(", ") || "—"}</span> },
    { key: "c", header: "Data categories", hideOnMobile: true, cell: (t) => <span className="text-xs">{t.dataCategories.map(human).join(", ") || "—"}</span> },
    { key: "l", header: "Last seen", hideOnMobile: true, cell: (t) => <LocalDate value={t.lastSeenAt} /> },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <Radio className={`size-4 ${data.telemetry.connected ? "text-success" : "text-warning"}`} aria-hidden />
          {data.telemetry.connected
            ? <span>Receiving AI usage telemetry from {data.telemetry.sources.join(", ")}; last event <LocalDate value={data.telemetry.lastEventAt} />.</span>
            : <span className="text-warning">No telemetry source connected in the last 30 days. Without proxy, CASB, SSO or browser telemetry this page only shows tools seen by AI DLP checks or added by hand — it cannot see other employee AI use.</span>}
          <span className="text-muted">Recognises {data.catalogSize} public AI services by domain; send events to <code>POST /api/v1/m/data-security/shadow-ai/telemetry</code>.</span>
        </CardBody>
      </Card>
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "Any status" }, ...opts(STATUSES)]} />
        <span className="flex-1" />
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setAdd(true)}>Add tool</Button>}
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(t) => t.id} onRowClick={(t) => router.push(`${DS}/shadow-ai/${t.id}`)} rowLabel={(t) => `Open ${t.name}`} caption="AI tools" defaultSort={{ key: "r", direction: "desc" }}
        emptyState={<EmptyState icon={<Radio className="size-6" />} title="No AI tools recorded" description="Tools appear here from telemetry, from DLP checks against external AI destinations, or when added by hand." />} />
      {add && <AddTool onClose={() => setAdd(false)} />}
    </div>
  );
}

function AddTool({ onClose }: { onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ vendor: "", name: "", category: "chat_assistant", domains: "", status: "experimental", notes: "" });
  const go = async () => { if (await run(() => apiFetch(`${DS}/shadow-ai/tools`, { body: { ...f, domains: f.domains.split(",").map((d) => d.trim()).filter(Boolean) } }), { success: "Tool added" })) onClose(); };
  return (
    <Modal open onClose={onClose} title="Add an AI tool" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.vendor.trim() || !f.name.trim()} onClick={go}>Add</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="t-vendor" label="Vendor" required>{(x) => <Input {...x} value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} />}</FormField>
        <FormField id="t-name" label="Tool" required>{(x) => <Input {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
        <FormField id="t-cat" label="Category">{(x) => <Select {...x} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={opts(["chat_assistant", "coding_assistant", "enterprise_copilot", "model_api", "agent_platform", "image_generation", "meeting_assistant", "writing_assistant", "other"])} />}</FormField>
        <FormField id="t-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={opts(STATUSES)} />}</FormField>
        <FormField id="t-domains" label="Domains" hint="Comma-separated" className="sm:col-span-2">{(x) => <Input {...x} value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} />}</FormField>
        <FormField id="t-notes" label="Notes" className="sm:col-span-2">{(x) => <Textarea {...x} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

export function ToolDetailView({ t, canManage }: { t: ToolDetail; canManage: boolean }) {
  const { run, pending } = useMutation();
  const [status, setStatus] = useState<string>(t.status);
  const [notes, setNotes] = useState(t.notes);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Tool" />
          <CardBody>
            <KeyValueList columns={2} items={[
              { key: "s", label: "Status", value: <StatusPill status={t.status} /> },
              { key: "r", label: "Risk", value: <span className="flex items-center gap-2"><SeverityBadge value={t.riskLevel} /> {t.riskScore}/100</span> },
              { key: "c", label: "Category", value: human(t.category) },
              { key: "src", label: "Recorded from", value: t.source },
              { key: "u", label: "Users (90 d)", value: fmtNum(t.userCount) },
              { key: "dom", label: "Domains", value: t.domains.join(", ") || "—" },
              { key: "dc", label: "Data categories reported", value: t.dataCategories.map(human).join(", ") || "—" },
              { key: "dlp", label: "DLP decisions", value: Object.entries(t.dlp).map(([k, v]) => `${k.toLowerCase().replace("_", " ")} ${v}`).join(" · ") || "—" },
              { key: "f", label: "First seen", value: <LocalDate value={t.firstSeenAt} /> },
              { key: "l", label: "Last seen", value: <LocalDate value={t.lastSeenAt} /> },
            ]} />
            <ul className="mt-3 list-disc pl-5 text-xs text-muted">{t.riskFactors.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Decision" description="Blocked: DLP blocks all content to it. Restricted: sensitive content needs approval. Unknown/experimental: unapproved-destination rules apply." />
          <CardBody className="space-y-3">
            <Select aria-label="Status" value={status} disabled={!canManage} onChange={(e) => setStatus(e.target.value)} options={opts(STATUSES)} />
            <Textarea aria-label="Notes" rows={3} value={notes} disabled={!canManage} onChange={(e) => setNotes(e.target.value)} />
            {canManage && <Button loading={pending} disabled={status === t.status && notes === t.notes} onClick={() => void run(() => apiFetch(`${DS}/shadow-ai/tools/${t.id}/status`, { body: { status, notes } }), { success: "Tool status saved" })}>Save</Button>}
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Usage (30 days)" />
          <CardBody>{t.daily.length ? <BarChart data={t.daily.map((d) => ({ label: d.day.slice(5), value: d.events }))} ariaLabel="Daily usage events" height={200} valueLabel="Events" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /> : <p className="text-sm text-muted">No telemetry in the last 30 days.</p>}</CardBody>
        </Card>
        <Card>
          <CardHeader title="By department" />
          <CardBody className="space-y-1 text-sm">
            {t.byDepartment.length === 0 && <p className="text-muted">No usage recorded.</p>}
            {t.byDepartment.map((d) => <div key={d.department} className="flex justify-between"><span>{d.department}</span><span className="text-muted">{d.users} user(s) · {fmtNum(d.events)} event(s)</span></div>)}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
