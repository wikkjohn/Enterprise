"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Download } from "lucide-react";
import { Button, CodeBlock, DataTable, Drawer, FormField, Input, KeyValueList, Select, StatusBadge, buttonClasses } from "@eaop/design-system";
import { type AuditEventView } from "@eaop/audit";

const FILTERS = ["q", "action", "module", "actorId", "resourceType", "resourceId", "outcome", "from", "to"] as const;

export function AuditLog({ events, nextCursor, canExport }: { events: AuditEventView[]; nextCursor?: string; canExport: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [form, setForm] = useState<Record<string, string>>(Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ""])));
  const [open, setOpen] = useState<AuditEventView | null>(null);
  const qs = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...form, ...extra })) if (v) p.set(k, v);
    return p.toString();
  };
  return (
    <div className="space-y-4">
      <form className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); router.push(`/admin/audit?${qs()}`); }}>
        <FormField id="a-q" label="Search">{(a) => <Input {...a} size="sm" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="Action, actor or resource" />}</FormField>
        <FormField id="a-action" label="Action">{(a) => <Input {...a} size="sm" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} placeholder="connector.created" />}</FormField>
        <FormField id="a-module" label="Module">{(a) => <Input {...a} size="sm" value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })} placeholder="core" />}</FormField>
        <FormField id="a-outcome" label="Outcome">{(a) => <Select {...a} size="sm" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} options={[{ value: "", label: "Any" }, { value: "success", label: "Success" }, { value: "failure", label: "Failure" }, { value: "denied", label: "Denied" }]} />}</FormField>
        <FormField id="a-res" label="Resource id">{(a) => <Input {...a} size="sm" value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })} />}</FormField>
        <FormField id="a-actor" label="Actor id">{(a) => <Input {...a} size="sm" value={form.actorId} onChange={(e) => setForm({ ...form, actorId: e.target.value })} />}</FormField>
        <FormField id="a-from" label="From">{(a) => <Input {...a} size="sm" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</FormField>
        <FormField id="a-to" label="To">{(a) => <Input {...a} size="sm" type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</FormField>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" size="sm">Apply filters</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setForm({}); router.push("/admin/audit"); }}>Reset</Button>
          {canExport && <a className={buttonClasses({ variant: "secondary", size: "sm" }) + " ml-auto"} href={`/api/v1/audit/export?${qs()}`}><Download className="size-4" aria-hidden /> Export CSV</a>}
        </div>
      </form>
      <DataTable
        caption="Audit events"
        rows={events}
        getRowId={(e) => e.id}
        onRowClick={setOpen}
        rowLabel={(e) => `Open ${e.action}`}
        emptyState={<p className="p-6 text-center text-sm text-muted">No audit events match these filters.</p>}
        columns={[
          { key: "time", header: "Time", cell: (e) => <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleString()}</time> },
          { key: "actor", header: "Actor", cell: (e) => <div><div>{e.actorLabel}</div><div className="text-xs text-muted">{e.actorType}</div></div> },
          { key: "action", header: "Action", cell: (e) => <code className="font-mono text-xs">{e.action}</code> },
          { key: "resource", header: "Resource", hideOnMobile: true, cell: (e) => (e.resourceType ? <span className="text-xs">{e.resourceType}:{e.resourceId?.slice(0, 8)}</span> : "—") },
          { key: "outcome", header: "Outcome", cell: (e) => <StatusBadge status={e.outcome === "success" ? "succeeded" : e.outcome === "denied" ? "blocked" : "failed"} label={e.outcome} /> },
        ]}
      />
      {nextCursor && <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => router.push(`/admin/audit?${qs({ cursor: nextCursor })}`)}>Older events</Button></div>}
      {open && (
        <Drawer open onClose={() => setOpen(null)} title={open.action} description={new Date(open.occurredAt).toLocaleString()} width="lg">
          <div className="space-y-4">
            <KeyValueList columns={2} items={[
              { key: "actor", label: "Actor", value: `${open.actorLabel} (${open.actorType})` },
              { key: "module", label: "Module", value: open.module },
              { key: "res", label: "Resource", value: open.resourceType ? `${open.resourceType} ${open.resourceId}` : "—" },
              { key: "out", label: "Outcome", value: open.outcome },
              { key: "ip", label: "IP address", value: open.ip ?? "—" },
              { key: "ua", label: "User agent", value: <span className="break-all text-xs">{open.userAgent ?? "—"}</span> },
              { key: "corr", label: "Correlation id", value: <code className="font-mono text-xs">{open.correlationId}</code> },
            ]} />
            {open.before !== null && <div><h3 className="mb-1 text-sm font-semibold">Before</h3><CodeBlock code={JSON.stringify(open.before, null, 2)} language="json" maxHeight="240px" /></div>}
            {open.after !== null && <div><h3 className="mb-1 text-sm font-semibold">After</h3><CodeBlock code={JSON.stringify(open.after, null, 2)} language="json" maxHeight="240px" /></div>}
            <div><h3 className="mb-1 text-sm font-semibold">Metadata</h3><CodeBlock code={JSON.stringify(open.metadata, null, 2)} language="json" maxHeight="240px" /></div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
