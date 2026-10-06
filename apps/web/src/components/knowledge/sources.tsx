"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, DataTable, FormField, Input, Modal, Select, type DataTableColumn } from "@eaop/design-system";
import { type SourceView } from "@eaop/module-knowledge-verification";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { AuthorityBadge, ClassificationBadge, KV, opts, StatusPill } from "./common";

type Source = SourceView & { documents: number; failed: number };
type Connector = { id: string; name: string; type: string };
const AUTHORITIES = ["authoritative", "preferred", "secondary", "deprecated"] as const;

export function SourceList({ sources, connectors, members, canManage, canIngest }: { sources: Source[]; connectors: Connector[]; members: Array<{ userId: string; name: string }>; canManage: boolean; canIngest: boolean }) {
  const [edit, setEdit] = useState<Source | "new" | null>(null);
  const columns: Array<DataTableColumn<Source>> = [
    { key: "n", header: "Source", cell: (s) => <span><Link className="font-medium hover:underline" href={`${KV}/documents?sourceId=${s.id}`}>{s.name}</Link><span className="block text-xs text-muted">{s.kind === "connector" ? `Connector · ${connectors.find((c) => c.id === s.connectorId)?.name ?? "unknown"}` : s.kind}{s.department ? ` · ${s.department}` : ""}</span></span> },
    { key: "a", header: "Authority", cell: (s) => <AuthorityBadge value={s.authority} /> },
    { key: "d", header: "Documents", cell: (s) => <span>{s.documents}{s.failed ? <span className="ml-1 text-xs text-danger">({s.failed} failed)</span> : null}</span> },
    { key: "c", header: "Default class.", hideOnMobile: true, cell: (s) => <ClassificationBadge value={s.classification} /> },
    { key: "acc", header: "Default access", hideOnMobile: true, cell: (s) => <span className="font-mono text-xs">{s.defaultPrincipals.join(", ") || "nobody"}</span> },
    { key: "sy", header: "Last sync", hideOnMobile: true, cell: (s) => (s.kind === "connector" ? <span><StatusPill status={s.lastSyncStatus} /><span className="block text-xs text-muted">{s.lastSyncAt ? <LocalDate value={s.lastSyncAt} /> : "never"}{s.lastSyncMessage ? ` · ${s.lastSyncMessage}` : ""}</span></span> : "—") },
    { key: "x", header: "", cell: (s) => (
      <span className="flex justify-end gap-2">
        {canIngest && s.kind === "connector" && <ActionButton size="sm" variant="secondary" path={`${KV}/sources/${s.id}/sync`} body={{}} success="Sync queued">Sync</ActionButton>}
        {canManage && <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>Edit</Button>}
      </span>
    ) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">Sources set the default authority, classification and access for their documents. Connector sources pull documents through the shared connector layer — no separate credentials.</p>
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit("new")}>New source</Button>}
      </div>
      <DataTable columns={columns} rows={sources} getRowId={(s) => s.id} caption="Knowledge sources" emptyState={<p className="p-6 text-center text-sm text-muted">No sources yet.{canManage ? " Create one to start adding documents." : ""}</p>} />
      {edit && <SourceForm source={edit === "new" ? null : edit} connectors={connectors} members={members} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SourceForm({ source, connectors, members, onClose }: { source: Source | null; connectors: Connector[]; members: Array<{ userId: string; name: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({
    name: source?.name ?? "", kind: source?.kind ?? "upload", connectorId: source?.connectorId ?? connectors[0]?.id ?? "", path: source?.path ?? "", authority: source?.authority ?? "secondary",
    classification: source?.classification ?? "internal", department: source?.department ?? "", ownerUserId: source?.ownerUserId ?? "", defaultPrincipals: (source?.defaultPrincipals ?? ["org:*"]).join(", "),
    staleDays: source?.staleDays ? String(source.staleDays) : "", status: source?.status ?? "active",
  });
  const go = async () => {
    const body: Record<string, unknown> = {
      name: f.name, authority: f.authority, classification: f.classification, department: f.department || null, ownerUserId: f.ownerUserId || null,
      defaultPrincipals: f.defaultPrincipals.split(/[\s,]+/).filter(Boolean), staleDays: f.staleDays ? Number(f.staleDays) : null,
    };
    if (f.kind === "connector") body.path = f.path || undefined;
    if (source) body.status = f.status;
    else Object.assign(body, { kind: f.kind, connectorId: f.kind === "connector" ? f.connectorId : undefined });
    if (await run(() => apiFetch(source ? `${KV}/sources/${source.id}` : `${KV}/sources`, { method: source ? "PATCH" : "POST", body }), { success: source ? "Source updated" : "Source created" })) onClose();
  };
  const selected = connectors.find((c) => c.id === f.connectorId);
  return (
    <Modal open onClose={onClose} title={source ? `Edit ${source.name}` : "New knowledge source"} size="lg"
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name.trim() || (f.kind === "connector" && !f.connectorId)} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="sf-name" label="Name" required>{(x) => <Input {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
        <FormField id="sf-kind" label="Kind" hint={source ? "Cannot be changed" : undefined}>{(x) => <Select {...x} disabled={!!source} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })} options={[{ value: "upload", label: "Uploads" }, { value: "api", label: "Pushed via API" }, { value: "connector", label: "Connector" }]} />}</FormField>
        {f.kind === "connector" && (
          <>
            <FormField id="sf-conn" label="Connector" hint={connectors.length ? "Configured under Administration → Connectors" : "No connectors configured yet"}>{(x) => <Select {...x} disabled={!!source} value={f.connectorId} onChange={(e) => setF({ ...f, connectorId: e.target.value })} options={connectors.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))} />}</FormField>
            {selected?.type === "rest_api" && <FormField id="sf-path" label="Documents endpoint path" hint="GET returning { documents: [...] }">{(x) => <Input {...x} placeholder="/knowledge/documents" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} />}</FormField>}
          </>
        )}
        <FormField id="sf-auth" label="Authority" hint="Used in ranking and confidence">{(x) => <Select {...x} value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value as typeof f.authority })} options={opts(AUTHORITIES)} />}</FormField>
        <FormField id="sf-class" label="Default classification">{(x) => <Select {...x} value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value as typeof f.classification })} options={opts(["public", "internal", "confidential", "restricted"])} />}</FormField>
        <FormField id="sf-dept" label="Department">{(x) => <Input {...x} value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />}</FormField>
        <FormField id="sf-owner" label="Owner">{(x) => <Select {...x} value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} options={[{ value: "", label: "None" }, ...members.map((m) => ({ value: m.userId, label: m.name }))]} />}</FormField>
        <FormField id="sf-acc" label="Default access" hint="org:*, role:<key>, dept:<name>, user:<id> — documents without their own ACL inherit this" className="sm:col-span-2">{(x) => <Input {...x} className="font-mono" value={f.defaultPrincipals} onChange={(e) => setF({ ...f, defaultPrincipals: e.target.value })} />}</FormField>
        <FormField id="sf-stale" label="Stale after (days)" hint="Empty = organization default">{(x) => <Input {...x} type="number" min={7} max={3650} value={f.staleDays} onChange={(e) => setF({ ...f, staleDays: e.target.value })} />}</FormField>
        {source && <FormField id="sf-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["active", "paused"])} />}</FormField>}
      </div>
    </Modal>
  );
}
