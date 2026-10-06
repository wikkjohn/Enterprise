"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, ScanSearch, XCircle } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, FormField, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type DlpEventView } from "@eaop/module-data-security";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { DecisionBadge, DS, fmtNum, human, opts, StatusPill } from "./common";

export function DlpEvents({ events, focus, initial, canDecide, viewerId }: { events: DlpEventView[]; focus?: string; initial: { decision?: string; approval?: string }; canDecide: boolean; viewerId: string }) {
  const router = useRouter();
  const [decision, setDecision] = useState(initial.decision ?? "");
  const [approval, setApproval] = useState(initial.approval ?? "");
  const [open, setOpen] = useState<DlpEventView | null>(events.find((e) => e.id === focus) ?? null);
  const rows = events.filter((e) => (!decision || e.decision === decision) && (!approval || e.approvalStatus === approval));
  const columns: Array<DataTableColumn<DlpEventView>> = [
    { key: "d", header: "Decision", cell: (e) => <DecisionBadge value={e.decision} /> },
    { key: "w", header: "Who → where", cell: (e) => <span><span className="font-medium">{e.actor.label}</span><span className="block text-xs text-muted">→ {e.destination} ({e.destinationTrust}){e.moduleId ? ` · ${e.moduleId}` : ""}</span></span> },
    { key: "c", header: "Detected", hideOnMobile: true, cell: (e) => <span className="text-xs">{e.categories.map(human).join(", ") || "nothing sensitive"}</span> },
    { key: "a", header: "Approval", cell: (e) => <StatusPill status={e.approvalStatus} /> },
    { key: "n", header: "Size", align: "right", hideOnMobile: true, cell: (e) => `${fmtNum(e.contentChars)} chars` },
    { key: "t", header: "When", hideOnMobile: true, cell: (e) => <LocalDate value={e.createdAt} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Decision" className="w-48" value={decision} onChange={(e) => setDecision(e.target.value)} options={[{ value: "", label: "Any decision" }, { value: "BLOCK", label: "block" }, { value: "REDACT", label: "redact" }, { value: "REQUIRE_APPROVAL", label: "require approval" }, { value: "ALLOW", label: "allow" }]} />
        <Select aria-label="Approval" className="w-48" value={approval} onChange={(e) => setApproval(e.target.value)} options={[{ value: "", label: "Any approval state" }, ...opts(["pending", "approved", "rejected", "used", "expired"])]} />
        {(decision || approval) && <Button variant="ghost" onClick={() => { setDecision(""); setApproval(""); router.replace(`${DS}/dlp`); }}>Clear</Button>}
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(e) => e.id} onRowClick={setOpen} rowLabel={(e) => `Open DLP event from ${e.actor.label}`} caption="DLP events" emptyState={<p className="p-6 text-center text-sm text-muted">No DLP events.</p>} />
      {open && <DlpEventModal e={open} canDecide={canDecide && open.actor.id !== viewerId} own={open.actor.id === viewerId} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DlpEventModal({ e, canDecide, own, onClose }: { e: DlpEventView; canDecide: boolean; own: boolean; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [note, setNote] = useState("");
  const decide = async (decision: "approve" | "reject") => { if (await run(() => apiFetch(`${DS}/dlp/events/${e.id}/decision`, { body: { decision, note: note || undefined } }), { success: decision === "approve" ? "Approved — valid once for 24 hours" : "Rejected" })) onClose(); };
  return (
    <Modal open onClose={onClose} size="lg" title={<span className="flex items-center gap-2">AI transmission <DecisionBadge value={e.decision} /></span>} description={`${e.actor.label} → ${e.destination}`}>
      <div className="space-y-4 text-sm">
        <KeyValueList columns={2} items={[
          { key: "dest", label: "Destination", value: `${e.destination} (${e.destinationTrust}, ${human(e.destinationCategory)})` },
          { key: "src", label: "Source", value: e.source === "ai_gateway" ? `Platform AI${e.moduleId ? ` · ${e.moduleId}/${e.useCase}` : ""}` : "Enforcement-point API" },
          { key: "size", label: "Size", value: `${fmtNum(e.contentChars)} characters` },
          { key: "when", label: "When", value: <LocalDate value={e.createdAt} /> },
          { key: "appr", label: "Approval", value: <StatusPill status={e.approvalStatus} /> },
          { key: "inc", label: "Incident", value: e.incidentId ? <Link className="text-accent hover:underline" href={`${DS}/incidents/${e.incidentId}`}>Open incident</Link> : "—" },
        ]} />
        <div>
          <p className="mb-1 font-medium">Why</p>
          <ul className="list-disc pl-5 text-muted">{e.reasons.length ? e.reasons.map((r, i) => <li key={i}>{r}</li>) : <li>Nothing sensitive detected.</li>}</ul>
        </div>
        {e.detections.length > 0 && (
          <div>
            <p className="mb-1 font-medium">Detections</p>
            <div className="space-y-1">{e.detections.map((d) => <div key={d.category} className="flex flex-wrap gap-2"><Badge>{human(d.category)}</Badge><span>{d.count} · {d.confidence} confidence</span><span className="text-xs text-muted">{d.basis.join("; ")}</span></div>)}</div>
          </div>
        )}
        <div>
          <p className="mb-1 font-medium">Content preview</p>
          {e.redactedPreview ? <CodeBlock code={e.redactedPreview} language="text" maxHeight="180px" /> : <p className="text-muted">Not retained (organization setting). Only a fingerprint and the detection summary are stored.</p>}
        </div>
        {e.approvalStatus === "pending" && (
          own ? <p className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning">This is your own request; someone else must decide.</p>
          : canDecide ? (
            <div className="space-y-2 border-t border-border pt-3">
              <FormField id="dlp-note" label="Note">{(f) => <Textarea {...f} rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} />}</FormField>
              <p className="text-xs text-muted">Approving lets the same person send exactly this content to this destination once within 24 hours.</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" leftIcon={<XCircle className="size-4" />} loading={pending} onClick={() => decide("reject")}>Reject</Button>
                <Button leftIcon={<CheckCircle2 className="size-4" />} loading={pending} onClick={() => decide("approve")}>Approve</Button>
              </div>
            </div>
          ) : null
        )}
        {e.approvalNote && <p className="text-muted">Reviewer note: “{e.approvalNote}”</p>}
      </div>
    </Modal>
  );
}

export function DetectionTester() {
  const { run, pending } = useMutation();
  const [text, setText] = useState("Customer Jane Doe, SSN 123-45-6789, paid with card 4111 1111 1111 1111.\nDeploy key: AKIAIOSFODNN7EXAMPLE");
  const [mode, setMode] = useState("mask");
  const [out, setOut] = useState<{ redacted: string; redactedCount: number; summaries: Array<{ category: string; count: number; confidence: string; basis: string[] }> } | null>(null);
  const go = async () => {
    const r = await run(() => apiFetch<typeof out>(`${DS}/dlp/test`, { body: { content: text, mode } }), { refresh: false });
    if (r) setOut(r);
  };
  return (
    <Card>
      <CardHeader title="Try detection and redaction" description="Nothing you paste here is stored or logged." />
      <CardBody className="space-y-3">
        <Textarea aria-label="Sample content" rows={4} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Redaction mode" className="w-40" value={mode} onChange={(e) => setMode(e.target.value)} options={[{ value: "mask", label: "Mask" }, { value: "tokenize", label: "Tokenize" }, { value: "label", label: "Replacement labels" }]} />
          <Button size="sm" loading={pending} leftIcon={<ScanSearch className="size-4" />} onClick={go}>Detect</Button>
        </div>
        {out && (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">{out.summaries.length ? out.summaries.map((s) => <Badge key={s.category} tone={s.confidence === "low" ? "neutral" : "warning"}>{human(s.category)} · {s.count} · {s.confidence}</Badge>) : <span className="text-muted">Nothing detected.</span>}</div>
            <CodeBlock code={out.redacted} language="text" maxHeight="200px" />
            <p className="text-xs text-muted">{out.redactedCount} value(s) redacted. Low-confidence signals (e.g. plain email addresses) are reported but not redacted here.</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
