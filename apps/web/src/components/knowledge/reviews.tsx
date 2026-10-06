"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, CardBody, FormField, Modal, Select, TabPanel, Tabs, Textarea } from "@eaop/design-system";
import { type KnowledgeService } from "@eaop/module-knowledge-verification";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { human, KV, opts, StatusPill } from "./common";

type Review = Awaited<ReturnType<KnowledgeService["listReviews"]>>[number];
type Conflict = Awaited<ReturnType<KnowledgeService["listConflicts"]>>[number];
const KIND_LABEL: Record<string, string> = { escalation: "Expert escalation", conflict: "Conflict", expired: "Expired", review_due: "Review due", stale: "Stale", no_owner: "No owner" };

export function ReviewQueues({ reviews, conflicts, members, canConflicts, canManage, initialTab, focus }: {
  reviews: Review[]; conflicts: Conflict[]; members: Array<{ userId: string; name: string }>; canConflicts: boolean; canManage: boolean; initialTab: string; focus?: string;
}) {
  const [tab, setTab] = useState(initialTab);
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<Review | null>(() => reviews.find((r) => r.id === focus) ?? null);
  const [conflict, setConflict] = useState<Conflict | null>(() => conflicts.find((c) => c.id === focus && c.status === "open") ?? null);
  const openConflicts = conflicts.filter((c) => c.status === "open");
  const shown = reviews.filter((r) => !kind || r.kind === kind);
  const counts = (k: string) => reviews.filter((r) => r.kind === k).length;
  return (
    <div className="space-y-4">
      <Tabs ariaLabel="Review queues" idPrefix="kvr" value={tab} onChange={setTab} items={[
        { value: "queue", label: "Queue", badge: reviews.length ? <Badge>{reviews.length}</Badge> : undefined },
        ...(canConflicts ? [{ value: "conflicts", label: "Conflicts", badge: openConflicts.length ? <Badge tone="danger">{openConflicts.length}</Badge> : undefined }] : []),
      ]} />
      <TabPanel idPrefix="kvr" value="queue" selected={tab}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Kind" className="w-56" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: "", label: `All (${reviews.length})` }, ...["escalation", "conflict", "expired", "review_due", "stale", "no_owner"].map((k) => ({ value: k, label: `${KIND_LABEL[k]} (${counts(k)})` }))]} />
            <span className="flex-1" />
            {canManage && <ActionButton variant="secondary" path={`${KV}/reviews/scan`} body={{}} success="Freshness scan complete">Run freshness scan</ActionButton>}
          </div>
          <Card>
            <CardBody className="space-y-1">
              {shown.length === 0 && <p className="p-4 text-center text-sm text-muted">Nothing waiting for review.</p>}
              {shown.map((r) => (
                <button key={r.id} type="button" onClick={() => (r.kind === "conflict" ? (setConflict(conflicts.find((c) => c.id === r.conflictId) ?? null), setTab("conflicts")) : setOpen(r))}
                  className="flex w-full flex-wrap items-start justify-between gap-2 rounded-md p-2 text-left text-sm hover:bg-surface-hover">
                  <span className="min-w-0 flex-1"><span className="font-medium">{r.title}</span><span className="block truncate text-xs text-muted">{KIND_LABEL[r.kind]}{r.category ? ` · ${r.category}` : ""}{r.assignee ? ` · assigned to ${r.assignee}` : ""}</span></span>
                  <span className="flex items-center gap-2 text-xs text-muted"><StatusPill status={r.status} /><LocalDate value={r.createdAt} dateOnly /></span>
                </button>
              ))}
            </CardBody>
          </Card>
        </div>
      </TabPanel>
      {canConflicts && (
        <TabPanel idPrefix="kvr" value="conflicts" selected={tab}>
          <div className="space-y-3">
            <p className="text-sm text-muted">The platform never decides which of two contradictory documents is correct. Until a reviewer decides, both stay in use and answers that cite them show lower confidence.</p>
            {conflicts.length === 0 && <p className="text-sm text-muted">No duplicates or conflicts detected.</p>}
            {conflicts.map((c) => (
              <Card key={c.id}>
                <CardBody className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><StatusPill status={c.kind} /><StatusPill status={c.status} /><span className="text-xs text-muted">similarity {c.similarity.toFixed(2)} · detected <LocalDate value={c.detectedAt} /></span>
                    <span className="flex-1" />{c.status === "open" && <Button size="sm" onClick={() => setConflict(c)}>Decide</Button>}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(["A", "B"] as const).map((k) => {
                      const d = k === "A" ? c.documentA : c.documentB;
                      return <Link key={k} href={`${KV}/documents/${d.id}`} className="rounded-md border border-border p-2 hover:bg-surface-hover"><span className="text-xs text-muted">{k}{c.newer === k.toLowerCase() ? " · newer" : ""}</span><span className="block font-medium">{d.title}</span><span className="text-xs text-muted">{d.date ? <LocalDate value={d.date} dateOnly /> : "undated"}</span></Link>;
                    })}
                  </div>
                  <p className="text-xs text-muted">{c.detail}</p>
                  {c.evidence.length > 0 && <ul className="space-y-1 text-xs">{c.evidence.slice(0, 3).map((e, i) => <li key={i} className="rounded bg-surface-hover p-1.5"><span className="font-medium">{e.reason}</span><span className="block">A: “{e.a}”</span><span className="block">B: “{e.b}”</span></li>)}</ul>}
                  {c.resolution && <p className="text-xs">Decision: {human(c.resolution)}{c.resolutionNote ? ` — ${c.resolutionNote}` : ""}</p>}
                </CardBody>
              </Card>
            ))}
          </div>
        </TabPanel>
      )}
      {open && <ReviewModal r={open} members={members} onClose={() => setOpen(null)} />}
      {conflict && <ConflictModal c={conflict} onClose={() => setConflict(null)} />}
    </div>
  );
}

function ReviewModal({ r, members, onClose }: { r: Review; members: Array<{ userId: string; name: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ status: r.status, assigneeUserId: r.assigneeUserId ?? "", resolution: r.resolution ?? "" });
  const save = async () => {
    const body: Record<string, unknown> = { status: f.status, assigneeUserId: f.assigneeUserId || null };
    if (f.resolution) body.resolution = f.resolution;
    if (await run(() => apiFetch(`${KV}/reviews/${r.id}`, { method: "PATCH", body }), { success: "Review updated" })) onClose();
  };
  return (
    <Modal open onClose={onClose} title={r.title} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={pending} onClick={save}>Save</Button></div>}>
      <div className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap text-muted">{r.detail}</p>
        <p className="flex flex-wrap gap-3 text-xs">
          {r.documentId && <Link className="text-accent hover:underline" href={`${KV}/documents/${r.documentId}`}>Open document{r.documentTitle ? `: ${r.documentTitle}` : ""} →</Link>}
          {r.queryId && <Link className="text-accent hover:underline" href={`${KV}/history/${r.queryId}`}>Open the question and answer →</Link>}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="rv-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["open", "in_progress", "resolved", "dismissed"])} />}</FormField>
          <FormField id="rv-assignee" label="Assignee">{(x) => <Select {...x} value={f.assigneeUserId} onChange={(e) => setF({ ...f, assigneeUserId: e.target.value })} options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.userId, label: m.name }))]} />}</FormField>
          <FormField id="rv-res" label={r.kind === "escalation" ? "Expert answer" : "Resolution note"} hint={r.kind === "escalation" ? "Sent to the person who asked when you resolve" : undefined} className="sm:col-span-2">
            {(x) => <Textarea {...x} rows={4} value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} />}
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

function ConflictModal({ c, onClose }: { c: Conflict; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [resolution, setResolution] = useState("both_valid");
  const [note, setNote] = useState("");
  const go = async () => {
    if (await run(() => apiFetch(`${KV}/conflicts/${c.id}/resolve`, { body: { resolution, note: note || undefined } }), { success: "Conflict resolved" })) onClose();
  };
  return (
    <Modal open onClose={onClose} title={`${human(c.kind)}: decide`} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={go}>Record decision</Button></div>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">{c.detail}</p>
        <FormField id="cf-res" label="Decision">{(x) => <Select {...x} value={resolution} onChange={(e) => setResolution(e.target.value)} options={[
          { value: "keep_a", label: `Keep A — “${c.documentA.title}” (B is superseded)` },
          { value: "keep_b", label: `Keep B — “${c.documentB.title}” (A is superseded)` },
          { value: "both_valid", label: "Both are valid (different scope)" },
          { value: "not_a_conflict", label: "Not a conflict (dismiss)" },
        ]} />}</FormField>
        <FormField id="cf-note" label="Note">{(x) => <Textarea {...x} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
        <p className="text-xs text-muted">A superseded document stops being used in answers immediately. The decision is audited.</p>
      </div>
    </Modal>
  );
}
