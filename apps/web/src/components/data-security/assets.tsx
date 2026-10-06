"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Database, Play } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, DataTable, EmptyState, FormField, Input, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type AssetView, type DataSecurityService } from "@eaop/module-data-security";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { DS, human, opts, SensitivityBadge, SeverityBadge, StatusPill } from "./common";

type AssetRow = AssetView & { openFindings: number; worstFinding: string | null };
type ScanRow = Awaited<ReturnType<DataSecurityService["listScans"]>>[number];
export type AssetDetail = Awaited<ReturnType<DataSecurityService["getAsset"]>>;

export function AssetInventory({ assets, scans, connectors, initial, canScan }: { assets: AssetRow[]; scans: ScanRow[]; connectors: Array<{ id: string; name: string; type: string }>; initial: { classification?: string; exposure?: string }; canScan: boolean }) {
  const router = useRouter();
  const [cls, setCls] = useState(initial.classification ?? "");
  const [exp, setExp] = useState(initial.exposure ?? "");
  const [q, setQ] = useState("");
  const [scan, setScan] = useState(false);
  const needle = q.trim().toLowerCase();
  const rows = assets.filter((a) => (!cls || a.classification === cls) && (!exp || a.aiExposureStatus === exp) && (!needle || `${a.name} ${a.location} ${a.owner ?? ""} ${a.sourceSystem}`.toLowerCase().includes(needle)));
  const columns: Array<DataTableColumn<AssetRow>> = [
    { key: "n", header: "Asset", sortable: true, sortValue: (a) => a.name, cell: (a) => <span><span className="font-medium">{a.name}</span><span className="block truncate text-xs text-muted">{a.sourceSystem} · {a.location || a.type}</span></span> },
    { key: "c", header: "Classification", sortable: true, sortValue: (a) => ["public", "internal", "confidential", "restricted"].indexOf(a.classification), cell: (a) => <SensitivityBadge value={a.classification} locked={a.classificationLocked} /> },
    { key: "cat", header: "Categories", hideOnMobile: true, cell: (a) => <span className="text-xs">{a.categories.map(human).join(", ") || "—"}</span> },
    { key: "s", header: "Sharing", hideOnMobile: true, cell: (a) => human(a.sharingScope) },
    { key: "e", header: "AI exposure", cell: (a) => <StatusPill status={a.aiExposureStatus} /> },
    { key: "f", header: "Findings", sortable: true, sortValue: (a) => a.openFindings, cell: (a) => (a.openFindings ? <span className="flex items-center gap-1">{a.openFindings}<SeverityBadge value={a.worstFinding} /></span> : "—") },
    { key: "o", header: "Owner", hideOnMobile: true, cell: (a) => a.owner ?? <span className="text-warning">none</span> },
    { key: "m", header: "Modified", hideOnMobile: true, cell: (a) => <LocalDate value={a.lastModifiedAt} dateOnly /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input aria-label="Search assets" className="max-w-xs" placeholder="Search name, location, owner…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Classification" className="w-44" value={cls} onChange={(e) => setCls(e.target.value)} options={[{ value: "", label: "Any classification" }, ...opts(["restricted", "confidential", "internal", "public"])]} />
        <Select aria-label="AI exposure" className="w-44" value={exp} onChange={(e) => setExp(e.target.value)} options={[{ value: "", label: "Any exposure" }, ...opts(["observed", "potential", "none"])]} />
        <span className="flex-1" />
        {canScan && <Button leftIcon={<Play className="size-4" />} onClick={() => setScan(true)}>Run discovery scan</Button>}
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(a) => a.id} onRowClick={(a) => router.push(`${DS}/assets/${a.id}`)} rowLabel={(a) => `Open ${a.name}`} caption="Data assets" defaultSort={{ key: "c", direction: "desc" }}
        emptyState={<EmptyState icon={<Database className="size-6" />} title={assets.length ? "No assets match" : "No assets discovered yet"} description={assets.length ? "Change the filters." : "Run a discovery scan through a shared connector, or push inventory from your own collectors with POST /api/v1/m/data-security/assets/ingest."} />} />
      <Card>
        <CardHeader title="Recent scans" />
        <CardBody className="space-y-1 text-sm">
          {scans.length === 0 && <p className="text-muted">No scans yet.</p>}
          {scans.slice(0, 8).map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2">
              <StatusPill status={s.status} />
              <span className="flex-1">{s.source === "api" ? `Ingest (${String((s.params as { sourceSystem?: string }).sourceSystem ?? "api")})` : `Connector scan (${String((s.params as { connectorType?: string }).connectorType ?? "")})`} · {s.assetsSeen} asset(s), {s.assetsClassified} classified, {s.findingsOpened} new finding(s){s.errorMessage ? ` — ${s.errorMessage}` : ""}</span>
              <span className="text-xs text-muted"><LocalDate value={s.createdAt} /></span>
            </div>
          ))}
        </CardBody>
      </Card>
      {scan && <ScanModal connectors={connectors} onClose={() => setScan(false)} />}
    </div>
  );
}

function ScanModal({ connectors, onClose }: { connectors: Array<{ id: string; name: string; type: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const [path, setPath] = useState("");
  const type = connectors.find((c) => c.id === connectorId)?.type;
  const go = async () => {
    if (await run(() => apiFetch(`${DS}/scans`, { body: { connectorId, ...(path ? { path } : {}) } }), { success: "Scan queued — results appear when the worker finishes" })) onClose();
  };
  return (
    <Modal open onClose={onClose} title="Run a discovery scan" description="Discovery runs through the shared connector (its credentials, rate limits and audit). Content samples are classified in memory and never stored." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!connectorId} onClick={go}>Start scan</Button></div>}>
      <div className="grid gap-3 text-sm">
        <FormField id="scan-conn" label="Connector">{(f) => <Select {...f} value={connectorId} onChange={(e) => setConnectorId(e.target.value)} options={connectors.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))} placeholder="No connectors visible" />}</FormField>
        {type === "rest_api" && <FormField id="scan-path" label="Inventory endpoint path" hint='Must return { "assets": [...] } in the ingestion format'>{(f) => <Input {...f} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/inventory/assets" />}</FormField>}
        {type && type !== "sandbox" && type !== "rest_api" && <p className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning">The {type} connector has no discovery adapter yet; this scan will fail with instructions. Push its inventory through the ingestion API instead.</p>}
        {type === "sandbox" && <p className="text-muted">The sandbox connector returns SIMULATED files with synthetic sensitive values.</p>}
      </div>
    </Modal>
  );
}

export function AssetDetailView({ a, canClassify, canRemediate }: { a: AssetDetail; canClassify: boolean; canRemediate: boolean }) {
  const [reclass, setReclass] = useState(false);
  const { run } = useMutation();
  const perms = a.permissions as { scope?: string; publicLink?: boolean; principals?: Array<{ type: string; name?: string; email?: string; role?: string; memberCount?: number; inherited?: boolean; status?: string }> };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SensitivityBadge value={a.classification} locked={a.classificationLocked} />
        <Badge>{a.sourceSystem}</Badge>
        <Badge>{human(a.sharingScope)}</Badge>
        <span className="text-sm text-muted">AI exposure</span><StatusPill status={a.aiExposureStatus} />
        <span className="flex-1" />
        {canClassify && <Button variant="secondary" onClick={() => setReclass(true)}>Change classification</Button>}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Asset" />
          <CardBody>
            <KeyValueList columns={2} items={[
              { key: "loc", label: "Location", value: a.location || "—" },
              { key: "type", label: "Type", value: a.type },
              { key: "owner", label: "Owner", value: a.owner ?? <span className="text-warning">No owner</span> },
              { key: "dept", label: "Department", value: a.department ?? "—" },
              { key: "mod", label: "Last modified", value: <LocalDate value={a.lastModifiedAt} /> },
              { key: "acc", label: "Last accessed", value: <LocalDate value={a.lastAccessedAt} /> },
              { key: "ret", label: "Retention category", value: a.retentionCategory ?? "—" },
              { key: "disc", label: "Discovered via", value: a.discoveredVia },
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Permissions" description={`Scope: ${human(perms.scope ?? "private")}${perms.publicLink ? " · public link" : ""}`} />
          <CardBody className="space-y-1 text-sm">
            {(perms.principals ?? []).length === 0 && <p className="text-muted">No principals reported.</p>}
            {(perms.principals ?? []).map((p, i) => <div key={i} className="flex justify-between gap-2"><span className="truncate">{p.email ?? p.name ?? p.type}</span><span className="text-xs text-muted">{[p.type, p.role, p.memberCount ? `${p.memberCount} members` : null, p.inherited ? "inherited" : null, p.status && p.status !== "active" ? p.status : null].filter(Boolean).join(" · ")}</span></div>)}
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Classifications" description="Counts, confidence and the basis for each detection. Matched values are never stored." />
        <CardBody className="space-y-2">
          {a.classifications.length === 0 && <p className="text-sm text-muted">Nothing sensitive detected (or no content sample was provided).</p>}
          {a.classifications.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 border-b border-border py-1.5 text-sm last:border-0">
              <span className="w-48 font-medium">{c.label}</span>
              <SensitivityBadge value={c.sensitivity} />
              <Badge>{c.confidence} · {c.method}</Badge>
              <span className="text-xs text-muted">{c.matchCount} match(es)</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted" title={c.basis}>{c.basis}</span>
              <StatusPill status={c.reviewStatus} />
              {canClassify && c.reviewStatus === "unreviewed" && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch(`${DS}/classifications/${c.id}/review`, { body: { status: "confirmed" } }), { success: "Confirmed" })}>Confirm</Button>
                  <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch(`${DS}/classifications/${c.id}/review`, { body: { status: "rejected" } }), { success: "Rejected as a false positive" })}>Reject</Button>
                </span>
              )}
            </div>
          ))}
        </CardBody>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Permission findings" />
          <CardBody className="space-y-2 text-sm">
            {a.accessFindings.length === 0 && <p className="text-muted">None.</p>}
            {a.accessFindings.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-2">
                <span className="min-w-0"><span className="font-medium">{human(f.kind)}</span>{f.principal ? ` — ${f.principal}` : ""}<span className="block text-xs text-muted">{f.detail}</span></span>
                <span className="flex shrink-0 items-center gap-1"><SeverityBadge value={f.severity} /><StatusPill status={f.status} />
                  {canRemediate && f.status === "open" && <ActionButton size="sm" variant="ghost" path={`${DS}/findings/access/${f.id}`} body={{ status: "accepted", note: "Risk accepted" }} success="Risk accepted" confirm={{ title: "Accept this risk?", message: "The finding stays visible as accepted. A later scan re-opens it only if it was resolved.", tone: "default", confirmLabel: "Accept risk" }}>Accept</ActionButton>}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="AI exposure" description="Inferred from sharing, or observed from DLP traffic that referenced this asset." />
          <CardBody className="space-y-2 text-sm">
            {a.exposureFindings.length === 0 && <p className="text-muted">No AI exposure found.</p>}
            {a.exposureFindings.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-2">
                <span className="min-w-0"><span className="font-medium">{human(f.type)}</span>{f.destination ? ` — ${f.destination}` : ""} <Badge>{f.basis}</Badge><span className="block text-xs text-muted">{f.detail}</span></span>
                <span className="flex shrink-0 items-center gap-1"><SeverityBadge value={f.severity} /><StatusPill status={f.status} /></span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Remediation" actions={<Link className="text-sm text-accent hover:underline" href={`${DS}/remediation`}>All remediation →</Link>} />
          <CardBody className="space-y-1 text-sm">
            {a.remediation.length === 0 && <p className="text-muted">None recommended.</p>}
            {a.remediation.map((r) => <div key={r.id} className="flex items-center justify-between gap-2"><span>{r.title} <span className="text-xs text-muted">({r.execution})</span></span><StatusPill status={r.status} /></div>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Versions" />
          <CardBody className="space-y-1 text-sm">
            {a.versions.map((v) => <div key={v.version} className="flex gap-3"><span className="w-10 font-mono text-xs text-muted">v{v.version}</span><span className="flex-1">{v.changeNote}</span><span className="text-xs text-muted"><LocalDate value={v.createdAt} /></span></div>)}
          </CardBody>
        </Card>
      </div>
      {reclass && <Reclassify a={a} onClose={() => setReclass(false)} />}
    </div>
  );
}

function Reclassify({ a, onClose }: { a: AssetDetail; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [value, setValue] = useState(a.classification);
  const [note, setNote] = useState("");
  const go = async () => { if (await run(() => apiFetch(`${DS}/assets/${a.id}/classification`, { body: { classification: value, lock: true, note: note || undefined } }), { success: "Classification changed and locked" })) onClose(); };
  return (
    <Modal open onClose={onClose} title="Change classification" description="A manual classification is locked: scans keep detecting categories but no longer change the level." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3">
        <FormField id="rc-level" label="Classification">{(f) => <Select {...f} value={value} onChange={(e) => setValue(e.target.value as typeof value)} options={opts(["public", "internal", "confidential", "restricted"])} />}</FormField>
        <FormField id="rc-note" label="Reason">{(f) => <Textarea {...f} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
      </div>
    </Modal>
  );
}
