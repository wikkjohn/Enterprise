"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, DataTable, FormField, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type RemediationView } from "@eaop/module-data-security";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { DS, human, opts, StatusPill } from "./common";

type Row = RemediationView & { assetName: string | null; toolName: string | null };

export function RemediationList({ items, focus, canManage, members }: { items: Row[]; focus?: string; canManage: boolean; members: Array<{ userId: string; name: string }> }) {
  const [status, setStatus] = useState("recommended");
  const [open, setOpen] = useState<Row | null>(items.find((r) => r.id === focus) ?? null);
  const rows = items.filter((r) => !status || r.status === status);
  const columns: Array<DataTableColumn<Row>> = [
    { key: "t", header: "Action", cell: (r) => <span><span className="font-medium">{r.title}</span><span className="block text-xs text-muted">{human(r.action)} · {r.execution === "automatic" ? "applied by the platform" : "performed in the source system, attested here"}</span></span> },
    { key: "on", header: "On", cell: (r) => (r.assetId ? <Link className="text-accent hover:underline" href={`${DS}/assets/${r.assetId}`}>{r.assetName}</Link> : r.toolId ? <Link className="text-accent hover:underline" href={`${DS}/shadow-ai/${r.toolId}`}>{r.toolName}</Link> : r.incidentId ? <Link className="text-accent hover:underline" href={`${DS}/incidents/${r.incidentId}`}>Incident</Link> : "—") },
    { key: "s", header: "Status", cell: (r) => <StatusPill status={r.status} /> },
    { key: "w", header: "Created", hideOnMobile: true, cell: (r) => <LocalDate value={r.createdAt} /> },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Status" className="max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[...opts(["recommended", "completed", "dismissed"]), { value: "", label: "All" }]} />
      <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} onRowClick={setOpen} rowLabel={(r) => `Open ${r.title}`} caption="Remediation actions" emptyState={<p className="p-6 text-center text-sm text-muted">Nothing here.</p>} />
      {open && <RemediationModal r={open} canManage={canManage} members={members} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RemediationModal({ r, canManage, members, onClose }: { r: Row; canManage: boolean; members: Array<{ userId: string; name: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [note, setNote] = useState("");
  const [owner, setOwner] = useState(members[0]?.userId ?? "");
  const [cls, setCls] = useState("confidential");
  const complete = async () => {
    const body = r.action === "assign_owner" ? { ownerUserId: owner } : r.action === "change_classification" ? { classification: cls } : { note };
    if (await run(() => apiFetch(`${DS}/remediation/${r.id}/complete`, { body }), { success: "Remediation completed" })) onClose();
  };
  const dismiss = async () => { if (await run(() => apiFetch(`${DS}/remediation/${r.id}/dismiss`, { body: { note } }), { success: "Dismissed" })) onClose(); };
  const manual = r.execution === "manual";
  return (
    <Modal open onClose={onClose} title={r.title} description={r.detail}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">{manual ? "The platform never changes permissions in your source systems. Make the change there, then describe what you did — the next scan verifies it." : "The platform applies this change directly."}</p>
        {r.result && <p>Result: {r.result}</p>}
        {canManage && r.status === "recommended" && (
          <>
            {r.action === "assign_owner" && <FormField id="rm-owner" label="Owner">{(f) => <Select {...f} value={owner} onChange={(e) => setOwner(e.target.value)} options={members.map((m) => ({ value: m.userId, label: m.name }))} placeholder="No members visible" />}</FormField>}
            {r.action === "change_classification" && <FormField id="rm-cls" label="Classification">{(f) => <Select {...f} value={cls} onChange={(e) => setCls(e.target.value)} options={opts(["public", "internal", "confidential", "restricted"])} />}</FormField>}
            <FormField id="rm-note" label={manual ? "What was done (attestation)" : "Note (needed to dismiss)"}>{(f) => <Textarea {...f} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" loading={pending} disabled={note.trim().length < 3} onClick={dismiss}>Dismiss</Button>
              <Button loading={pending} disabled={manual && note.trim().length < 5} onClick={complete}>{manual ? "Mark done" : "Apply"}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
