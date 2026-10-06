"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Upload } from "lucide-react";
import { Button, Card, CardBody, CardHeader, DataTable, FormField, Input, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type DocumentView, type KnowledgeService } from "@eaop/module-knowledge-verification";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { AuthorityBadge, ClassificationBadge, FreshnessBadge, human, KV, opts, StatusPill } from "./common";

type DocDetail = Awaited<ReturnType<KnowledgeService["getDocument"]>>;
type SourceOpt = { id: string; name: string; kind: string };
const AUTHORITIES = ["authoritative", "preferred", "secondary", "deprecated"] as const;
const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.html,.htm,.json";

export function DocumentList({ docs, sources, canIngest, initialSource }: { docs: DocumentView[]; sources: SourceOpt[]; canIngest: boolean; initialSource?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [source, setSource] = useState(initialSource ?? "");
  const [fresh, setFresh] = useState("");
  const [upload, setUpload] = useState(false);
  const rows = useMemo(() => docs.filter((d) => (!source || d.sourceId === source) && (!fresh || d.freshness === fresh || (fresh === "failed" && d.ingestionStatus === "failed")) && (!q || d.title.toLowerCase().includes(q.toLowerCase()))), [docs, source, fresh, q]);
  const columns: Array<DataTableColumn<DocumentView>> = [
    { key: "t", header: "Document", cell: (d) => <span><span className="font-medium">{d.title}</span><span className="block text-xs text-muted">{d.sourceName} · {d.format.toUpperCase()} · v{d.version}</span></span> },
    { key: "a", header: "Authority", cell: (d) => <AuthorityBadge value={d.authority} inherited={d.authorityInherited} /> },
    { key: "f", header: "Freshness", cell: (d) => (d.ingestionStatus === "failed" ? <StatusPill status="failed" /> : d.status !== "active" ? <StatusPill status={d.status} /> : <FreshnessBadge value={d.freshness} />) },
    { key: "c", header: "Classification", hideOnMobile: true, cell: (d) => <ClassificationBadge value={d.classification} /> },
    { key: "o", header: "Owner", hideOnMobile: true, cell: (d) => d.owner ?? <span className="text-warning">none</span> },
    { key: "u", header: "Updated", hideOnMobile: true, cell: (d) => <LocalDate value={d.updatedAt} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search titles" placeholder="Search titles" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Source" className="w-52" value={source} onChange={(e) => setSource(e.target.value)} options={[{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s.id, label: s.name }))]} />
        <Select aria-label="Freshness" className="w-44" value={fresh} onChange={(e) => setFresh(e.target.value)} options={[{ value: "", label: "Any freshness" }, ...opts(["fresh", "stale", "expired", "failed"])]} />
        <span className="flex-1" />
        {canIngest && <Button leftIcon={<Upload className="size-4" />} disabled={!sources.length} onClick={() => setUpload(true)}>Add document</Button>}
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(d) => d.id} onRowClick={(d) => router.push(`${KV}/documents/${d.id}`)} rowLabel={(d) => `Open ${d.title}`} caption="Knowledge documents"
        emptyState={<p className="p-6 text-center text-sm text-muted">{docs.length ? "No documents match the filters." : "No documents you can access yet."}</p>} />
      {upload && <UploadDocument sources={sources} defaultSource={source} onClose={() => setUpload(false)} />}
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

function UploadDocument({ sources, defaultSource, onClose }: { sources: SourceOpt[]; defaultSource: string; onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ sourceId: defaultSource || sources[0]?.id || "", title: "", text: "", authority: "", classification: "", effectiveDate: "", expirationDate: "", owner: "" });
  const tooBig = !!file && file.size > 20 * 1024 * 1024;
  const go = async () => {
    const body: Record<string, unknown> = { sourceId: f.sourceId };
    if (f.title.trim()) body.title = f.title.trim();
    if (file) Object.assign(body, { filename: file.name, mimeType: file.type || undefined, contentBase64: await readBase64(file) });
    else body.text = f.text;
    if (f.authority) body.authority = f.authority;
    if (f.classification) body.classification = f.classification;
    if (f.effectiveDate) body.effectiveDate = f.effectiveDate;
    if (f.expirationDate) body.expirationDate = f.expirationDate;
    if (f.owner) body.owner = f.owner;
    const r = await run(() => apiFetch<{ document: DocumentView; failed: boolean; error: string | null }>(`${KV}/documents`, { body }), { refresh: false });
    if (r) router.push(`${KV}/documents/${r.document.id}`);
  };
  return (
    <Modal open onClose={onClose} title="Add a document" size="lg"
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.sourceId || tooBig || (!file && f.text.trim().length < 1) || (!file && !f.title.trim())} onClick={go}>Ingest</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="up-src" label="Source" required>{(x) => <Select {...x} value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })} options={sources.map((s) => ({ value: s.id, label: s.name }))} />}</FormField>
        <FormField id="up-title" label="Title" hint={file ? "Defaults to the document's own title, then the file name" : undefined}>{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
        <FormField id="up-file" label="File" hint="PDF, DOCX, PPTX, XLSX, CSV, TXT, HTML or JSON, up to 20 MB. Scanned PDFs need OCR first." error={tooBig ? "File is larger than 20 MB." : undefined} className="sm:col-span-2">
          {(x) => <input {...x} type="file" accept={ACCEPT} className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </FormField>
        {!file && <FormField id="up-text" label="…or paste text" className="sm:col-span-2">{(x) => <Textarea {...x} rows={5} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />}</FormField>}
        <FormField id="up-auth" label="Authority" hint="Leave empty to inherit from the source">{(x) => <Select {...x} value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })} options={[{ value: "", label: "Inherit" }, ...opts(AUTHORITIES)]} />}</FormField>
        <FormField id="up-class" label="Classification">{(x) => <Select {...x} value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })} options={[{ value: "", label: "Source default" }, ...opts(CLASSIFICATIONS)]} />}</FormField>
        <FormField id="up-eff" label="Effective date">{(x) => <Input {...x} type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />}</FormField>
        <FormField id="up-exp" label="Expires">{(x) => <Input {...x} type="date" value={f.expirationDate} onChange={(e) => setF({ ...f, expirationDate: e.target.value })} />}</FormField>
        <FormField id="up-owner" label="Owner email" hint="An organization member who keeps it current" className="sm:col-span-2">{(x) => <Input {...x} type="email" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} />}</FormField>
      </div>
      <p className="mt-3 text-xs text-muted">Access follows the source&apos;s default permissions. Uploading a file with the same name (or text with the same title) to the same source creates a new version.</p>
    </Modal>
  );
}

export function DocumentDetailView({ d, canManage, canSetAccess, members }: { d: DocDetail; canManage: boolean; canSetAccess: boolean; members: Array<{ userId: string; name: string }> }) {
  const { run, pending } = useMutation();
  const date = (v: string | null) => (v ? v.slice(0, 10) : "");
  const [f, setF] = useState({ authority: d.authorityInherited ? "" : d.authority, classification: d.classification, ownerUserId: d.ownerUserId ?? "", effectiveDate: date(d.effectiveDate), expirationDate: date(d.expirationDate), reviewDueAt: date(d.reviewDueAt), status: d.status === "archived" ? "archived" : "active" });
  const [access, setAccess] = useState({ mode: d.permissions?.mode === "explicit" ? "explicit" : "source_default", principals: (d.permissions?.principals ?? []).join("\n") });
  const save = () => run(() => apiFetch(`${KV}/documents/${d.id}`, { method: "PATCH", body: {
    authority: f.authority || null, classification: f.classification, ownerUserId: f.ownerUserId || null, effectiveDate: f.effectiveDate || null, expirationDate: f.expirationDate || null, reviewDueAt: f.reviewDueAt || null,
    ...(d.status !== "superseded" ? { status: f.status } : {}),
  } }), { success: "Document updated" });
  const saveAccess = () => run(() => apiFetch(`${KV}/documents/${d.id}/permissions`, { method: "PUT", body: { mode: access.mode, principals: access.principals.split(/[\s,]+/).filter(Boolean) } }), { success: "Access updated" });
  const ownerOpts = [{ value: "", label: "No owner" }, ...members.map((m) => ({ value: m.userId, label: m.name }))];
  if (d.ownerUserId && !members.some((m) => m.userId === d.ownerUserId)) ownerOpts.push({ value: d.ownerUserId, label: d.owner ?? "Current owner" });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <AuthorityBadge value={d.authority} inherited={d.authorityInherited} />
        <StatusPill status={d.status} />
        {d.ingestionStatus !== "indexed" && <StatusPill status={d.ingestionStatus} />}
        {d.status === "active" && <FreshnessBadge value={d.freshness} />}
        <ClassificationBadge value={d.classification} />
        <span className="text-sm text-muted">{d.sourceName} · {d.format.toUpperCase()} · v{d.version} · cited {d.citedCount}×</span>
        <span className="flex-1" />
        {canManage && d.status === "active" && <ActionButton size="sm" variant="secondary" path={`${KV}/documents/${d.id}/review`} body={{}} success="Marked reviewed">Mark reviewed — still accurate</ActionButton>}
      </div>
      {d.supersededBy && <p className="text-sm text-warning">Superseded by <Link className="underline" href={`${KV}/documents/${d.supersededBy.id}`}>{d.supersededBy.title}</Link>. It is no longer used in answers.</p>}
      {d.ingestionError && <p className="text-sm text-danger">Ingestion failed: {d.ingestionError}</p>}
      {d.ingestionWarnings.length > 0 && <p className="text-sm text-warning">{d.ingestionWarnings.join(" ")}</p>}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Metadata" />
          <CardBody>
            {canManage ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField id="dm-auth" label="Authority">{(x) => <Select {...x} value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })} options={[{ value: "", label: `Inherit from source` }, ...opts(AUTHORITIES)]} />}</FormField>
                <FormField id="dm-class" label="Classification">{(x) => <Select {...x} value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value as typeof f.classification })} options={opts(CLASSIFICATIONS)} />}</FormField>
                <FormField id="dm-owner" label="Owner">{(x) => <Select {...x} value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} options={ownerOpts} />}</FormField>
                <FormField id="dm-eff" label="Effective date">{(x) => <Input {...x} type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />}</FormField>
                <FormField id="dm-exp" label="Expires">{(x) => <Input {...x} type="date" value={f.expirationDate} onChange={(e) => setF({ ...f, expirationDate: e.target.value })} />}</FormField>
                <FormField id="dm-due" label="Review due">{(x) => <Input {...x} type="date" value={f.reviewDueAt} onChange={(e) => setF({ ...f, reviewDueAt: e.target.value })} />}</FormField>
                {d.status !== "superseded" && <FormField id="dm-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={opts(["active", "archived"])} />}</FormField>}
                <div className="flex items-end sm:col-span-3"><Button loading={pending} onClick={save}>Save metadata</Button></div>
              </div>
            ) : (
              <KeyValueList columns={2} items={[
                { key: "o", label: "Owner", value: d.owner ?? "—" }, { key: "dep", label: "Department", value: d.department ?? "—" },
                { key: "e", label: "Effective", value: <LocalDate value={d.effectiveDate} dateOnly /> }, { key: "x", label: "Expires", value: <LocalDate value={d.expirationDate} dateOnly /> },
                { key: "r", label: "Review due", value: <LocalDate value={d.reviewDueAt} dateOnly /> }, { key: "m", label: "Last modified", value: <LocalDate value={d.lastModifiedAt} /> },
              ]} />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Access" description={d.permissions?.mode === "explicit" ? "Set explicitly on this document." : d.permissions?.mode === "source_acl" ? "Mapped from the source system's permissions." : "Inherited from the source default."} />
          <CardBody className="space-y-2 text-sm">
            <ul className="space-y-0.5">{(d.permissions?.principals ?? []).map((p) => <li key={p} className="font-mono text-xs">{p}</li>)}</ul>
            {(d.permissions?.principals ?? []).length === 0 && <p className="text-warning">Nobody can retrieve this document (no mapped principals).</p>}
            {(d.permissions?.unmapped ?? []).length > 0 && <p className="text-xs text-muted">{d.permissions!.unmapped.length} source entr{d.permissions!.unmapped.length === 1 ? "y" : "ies"} could not be mapped to members and grant nothing: {d.permissions!.unmapped.map((u) => u.email ?? u.name ?? u.id ?? u.type).join(", ")}.</p>}
            {canSetAccess && (
              <div className="space-y-2 border-t border-border pt-2">
                <Select aria-label="Access mode" value={access.mode} onChange={(e) => setAccess({ ...access, mode: e.target.value })} options={[{ value: "source_default", label: "Use source default" }, { value: "explicit", label: "Explicit principals" }]} />
                {access.mode === "explicit" && <Textarea aria-label="Principals" rows={3} placeholder={"org:*\nrole:analyst\ndept:finance\nuser:<id>"} value={access.principals} onChange={(e) => setAccess({ ...access, principals: e.target.value })} />}
                <Button size="sm" variant="secondary" loading={pending} onClick={saveAccess}>Save access</Button>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {d.conflicts.length > 0 && (
        <Card>
          <CardHeader title="Duplicates and conflicts" />
          <CardBody className="space-y-2 text-sm">
            {d.conflicts.map((c) => (
              <div key={c.id} className="flex flex-wrap items-start gap-2 border-b border-border pb-2 last:border-0">
                <StatusPill status={c.kind} /><StatusPill status={c.status} />
                <span className="min-w-0 flex-1">with <Link className="font-medium hover:underline" href={`${KV}/documents/${c.otherDocumentId}`}>{c.otherTitle}</Link><span className="block text-xs text-muted">{c.detail}</span></span>
                {c.status === "open" && <Link className="text-xs text-accent hover:underline" href={`${KV}/reviews?tab=conflicts&focus=${c.id}`}>Review →</Link>}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Versions" description="Each content change is a new version; only the current version is used in answers." />
          <CardBody className="space-y-2 text-sm">
            {d.versions.map((v) => (
              <div key={v.version} className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2 last:border-0">
                <span><span className="font-medium">v{v.version}</span> · {v.changeSummary}<span className="block text-xs text-muted">{v.chunkCount} chunks · {v.ingestedBy} · <span className="font-mono">{v.contentHash.slice(0, 12)}</span></span></span>
                <span className="text-xs text-muted"><LocalDate value={v.createdAt} /></span>
              </div>
            ))}
            {d.versions.length === 0 && <p className="text-muted">No indexed version.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Review history" />
          <CardBody className="space-y-2 text-sm">
            {d.reviews.map((r) => <div key={r.id} className="flex items-center justify-between gap-2"><span>{r.title}</span><span className="flex items-center gap-2 text-xs text-muted"><StatusPill status={r.status} /><LocalDate value={r.createdAt} dateOnly /></span></div>)}
            {d.reviews.length === 0 && <p className="text-muted">No reviews.</p>}
            {d.lastReviewedAt && <p className="text-xs text-muted">Last reviewed <LocalDate value={d.lastReviewedAt} /></p>}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Indexed content" description={`${d.chunkCount} chunk(s) in the current version${d.chunks.length < d.chunkCount ? `; first ${d.chunks.length} shown` : ""}.`} />
        <CardBody className="space-y-3">
          {d.chunks.map((c) => (
            <div key={c.id} className="text-sm">
              <p className="text-xs text-muted">#{c.ordinal + 1}{c.heading ? ` · ${c.heading}` : ""} · chars {c.start}–{c.end}</p>
              <p className="whitespace-pre-wrap">{c.text}{c.text.length >= 600 ? "…" : ""}</p>
            </div>
          ))}
        </CardBody>
      </Card>
      <p className="text-xs text-muted">External ID {d.externalId}{d.sourceUrl ? <> · <a className="underline" href={d.sourceUrl} target="_blank" rel="noreferrer">open in source</a></> : null} · {human(d.format)}</p>
    </div>
  );
}
