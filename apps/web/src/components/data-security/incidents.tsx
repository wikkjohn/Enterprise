"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Card, CardBody, CardHeader, DataTable, FormField, Input, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type DataSecurityService, type IncidentView } from "@eaop/module-data-security";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { DecisionBadge, DS, human, opts, SensitivityBadge, SeverityBadge, StatusPill } from "./common";

type IncidentDetail = Awaited<ReturnType<DataSecurityService["getIncident"]>>;

export function IncidentList({ incidents, canManage }: { incidents: IncidentView[]; canManage: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("active");
  const [create, setCreate] = useState(false);
  const rows = incidents.filter((i) => (status === "active" ? i.status !== "resolved" : !status || i.status === status));
  const columns: Array<DataTableColumn<IncidentView>> = [
    { key: "sev", header: "Severity", cell: (i) => <SeverityBadge value={i.severity} /> },
    { key: "t", header: "Incident", cell: (i) => <span><span className="font-medium">{i.title}</span><span className="block text-xs text-muted">{human(i.kind)} · {i.source}{i.eventCount > 1 ? ` · ${i.eventCount} events` : ""}</span></span> },
    { key: "s", header: "Status", cell: (i) => <StatusPill status={i.status} /> },
    { key: "o", header: "Owner", hideOnMobile: true, cell: (i) => i.ownerName ?? "—" },
    { key: "u", header: "Updated", hideOnMobile: true, cell: (i) => <LocalDate value={i.updatedAt} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "active", label: "Active (not resolved)" }, ...opts(["open", "investigating", "contained", "resolved"]), { value: "", label: "All" }]} />
        <span className="flex-1" />
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreate(true)}>Open incident</Button>}
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(i) => i.id} onRowClick={(i) => router.push(`${DS}/incidents/${i.id}`)} rowLabel={(i) => `Open incident ${i.title}`} caption="Security incidents" emptyState={<p className="p-6 text-center text-sm text-muted">No incidents.</p>} />
      {create && <CreateIncident onClose={() => setCreate(false)} />}
    </div>
  );
}

function CreateIncident({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [f, setF] = useState({ severity: "medium", title: "", description: "" });
  const go = async () => {
    const r = await run(() => apiFetch<{ id: string }>(`${DS}/incidents`, { body: { ...f, kind: "manual" } }), { success: "Incident opened", refresh: false });
    if (r) router.push(`${DS}/incidents/${r.id}`);
  };
  return (
    <Modal open onClose={onClose} title="Open an incident" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={f.title.trim().length < 3} onClick={go}>Open</Button></div>}>
      <div className="grid gap-3">
        <FormField id="ni-sev" label="Severity">{(x) => <Select {...x} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} options={opts(["low", "medium", "high", "critical"])} />}</FormField>
        <FormField id="ni-title" label="Title" required>{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
        <FormField id="ni-desc" label="Description">{(x) => <Textarea {...x} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

export function IncidentDetailView({ i, canManage, canRemediate, members }: { i: IncidentDetail; canManage: boolean; canRemediate: boolean; members: Array<{ userId: string; name: string }> }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ status: i.status, severity: i.severity, ownerUserId: i.ownerUserId ?? "", rootCause: i.rootCause ?? "", resolution: i.resolution ?? "", remediation: i.remediation ?? "", note: "" });
  const save = async () => {
    const body: Record<string, unknown> = { note: f.note || undefined };
    if (f.status !== i.status) body.status = f.status;
    if (f.severity !== i.severity) body.severity = f.severity;
    if ((f.ownerUserId || null) !== i.ownerUserId) body.ownerUserId = f.ownerUserId || null;
    if (f.rootCause !== (i.rootCause ?? "")) body.rootCause = f.rootCause;
    if (f.resolution !== (i.resolution ?? "")) body.resolution = f.resolution;
    if (f.remediation !== (i.remediation ?? "")) body.remediation = f.remediation;
    if (await run(() => apiFetch(`${DS}/incidents/${i.id}`, { method: "PATCH", body }), { success: "Incident updated" })) setF({ ...f, note: "" });
  };
  const ownerOpts = [{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.userId, label: m.name }))];
  if (i.ownerUserId && !members.some((m) => m.userId === i.ownerUserId)) ownerOpts.push({ value: i.ownerUserId, label: i.ownerName ?? "Current owner" });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2"><SeverityBadge value={i.severity} /><StatusPill status={i.status} /><span className="text-sm text-muted">{human(i.kind)} · source {i.source} · opened <LocalDate value={i.createdAt} /></span></div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Timeline" />
          <CardBody className="space-y-2">
            {i.timeline.map((t) => (
              <div key={t.id} className="flex gap-3 border-b border-border pb-2 text-sm last:border-0">
                <span className="w-40 shrink-0 text-xs text-muted"><LocalDate value={t.at} /></span>
                <span className="w-28 shrink-0 text-xs font-medium">{human(t.kind)}</span>
                <span className="min-w-0 flex-1">{t.message}<span className="block text-xs text-muted">{t.actor}</span></span>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Affected" />
          <CardBody className="space-y-2 text-sm">
            <p className="font-medium">Users</p>
            <p className="text-muted">{i.affectedUsers.join(", ") || "—"}</p>
            <p className="font-medium">Assets</p>
            {i.assets.length === 0 && <p className="text-muted">—</p>}
            {i.assets.map((a) => <Link key={a.id} className="flex items-center justify-between gap-2 hover:underline" href={`${DS}/assets/${a.id}`}><span>{a.name}</span><SensitivityBadge value={a.classification} /></Link>)}
          </CardBody>
        </Card>
      </div>
      {i.dlpEvents.length > 0 && (
        <Card>
          <CardHeader title="Related DLP events" />
          <CardBody className="space-y-1 text-sm">
            {i.dlpEvents.map((e) => <Link key={e.id} href={`${DS}/dlp?focus=${e.id}`} className="flex flex-wrap items-center gap-2 hover:underline"><DecisionBadge value={e.decision} /><span className="flex-1">{e.actor.label} → {e.destination} · {e.categories.map(human).join(", ") || "—"}</span><span className="text-xs text-muted"><LocalDate value={e.createdAt} /></span></Link>)}
          </CardBody>
        </Card>
      )}
      {i.remediationActions.length > 0 && (
        <Card>
          <CardHeader title="Remediation" />
          <CardBody className="space-y-1 text-sm">
            {i.remediationActions.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2">
                <span className="flex-1">{r.title} <span className="text-xs text-muted">({r.execution})</span>{r.result ? <span className="block text-xs text-muted">{r.result}</span> : null}</span>
                <StatusPill status={r.status} />
                {canRemediate && r.status === "recommended" && r.execution === "automatic" && <ActionButton size="sm" path={`${DS}/remediation/${r.id}/complete`} body={{}} success="Applied">Apply</ActionButton>}
                {canRemediate && r.status === "recommended" && r.execution === "manual" && <Link className="text-xs text-accent hover:underline" href={`${DS}/remediation?focus=${r.id}`}>Attest →</Link>}
              </div>
            ))}
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader title="Investigation" />
        <CardBody>
          {canManage ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField id="ii-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["open", "investigating", "contained", "resolved"])} />}</FormField>
              <FormField id="ii-sev" label="Severity">{(x) => <Select {...x} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as typeof f.severity })} options={opts(["low", "medium", "high", "critical"])} />}</FormField>
              <FormField id="ii-owner" label="Owner">{(x) => <Select {...x} value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} options={ownerOpts} />}</FormField>
              <FormField id="ii-root" label="Root cause" className="sm:col-span-3">{(x) => <Textarea {...x} rows={2} value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} />}</FormField>
              <FormField id="ii-rem" label="Remediation" className="sm:col-span-3">{(x) => <Textarea {...x} rows={2} value={f.remediation} onChange={(e) => setF({ ...f, remediation: e.target.value })} />}</FormField>
              <FormField id="ii-res" label="Resolution" hint="Required to resolve" className="sm:col-span-3">{(x) => <Textarea {...x} rows={2} value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} />}</FormField>
              <FormField id="ii-note" label="Add a note to the timeline" className="sm:col-span-3">{(x) => <Textarea {...x} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</FormField>
              <div className="sm:col-span-3"><Button loading={pending} onClick={save}>Save</Button></div>
            </div>
          ) : (
            <KeyValueList items={[{ key: "rc", label: "Root cause", value: i.rootCause ?? "—" }, { key: "rm", label: "Remediation", value: i.remediation ?? "—" }, { key: "rs", label: "Resolution", value: i.resolution ?? "—" }]} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
