"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { BarChart, Button, Card, CardBody, CardHeader, DataTable, FormField, Input, Select, StatCard, Switch, type DataTableColumn } from "@eaop/design-system";
import { type KnowledgeService } from "@eaop/module-knowledge-verification";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { ConfidenceBadge, fmtNum, human, KV, opts, StatusPill } from "./common";

type Analytics = Awaited<ReturnType<KnowledgeService["analytics"]>>;
type Settings = Awaited<ReturnType<KnowledgeService["getSettings"]>>;
type IndexRow = Awaited<ReturnType<KnowledgeService["listIndexes"]>>[number];
type QueryRow = Awaited<ReturnType<KnowledgeService["listQueries"]>>[number];

export function KnowledgeAnalytics({ a }: { a: Analytics }) {
  const t = a.totals;
  const stats = [
    { label: "Questions (30 d)", value: fmtNum(t.questions30d), hint: `${fmtNum(t.escalated30d)} escalated to experts`, href: `${KV}/history` },
    { label: "Active documents", value: fmtNum(t.documents), hint: `${fmtNum(t.fresh)} fresh · ${fmtNum(t.stale)} stale · ${fmtNum(t.expired)} expired (never used)`, href: `${KV}/documents` },
    { label: "Without an owner", value: fmtNum(t.noOwner), hint: "Nobody accountable for keeping them current", href: `${KV}/reviews` },
    { label: "Open conflicts", value: fmtNum(t.openConflicts), hint: `${fmtNum(t.contradictions)} contradictions`, href: `${KV}/reviews?tab=conflicts` },
  ];
  const list = (rows: Array<{ queryId: string; question: string | null; at: string; confidence?: string | null }>, empty: string) => (
    <CardBody className="space-y-1">
      {rows.length === 0 && <p className="text-sm text-muted">{empty}</p>}
      {rows.map((r) => <Link key={r.queryId} href={`${KV}/history/${r.queryId}`} className="flex items-center justify-between gap-2 rounded p-1 text-sm hover:bg-surface-hover"><span className="truncate">{r.question ?? "(not retained)"}</span><span className="flex shrink-0 items-center gap-2 text-xs text-muted">{r.confidence ? <ConfidenceBadge value={r.confidence} /> : null}<LocalDate value={r.at} dateOnly /></span></Link>)}
    </CardBody>
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => <StatCard key={s.label} label={<Link className="hover:underline" href={s.href}>{s.label}</Link>} value={s.value} hint={s.hint} />)}
      </div>
      {!a.questionTextRetained && <p className="text-sm text-muted">Question text is not retained in this organization, so top questions and knowledge gaps cannot be shown.</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card><CardHeader title="Answer confidence (30 days)" /><CardBody><BarChart data={a.confidence} ariaLabel="Answers by confidence" height={200} valueLabel="Answers" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /></CardBody></Card>
        <Card><CardHeader title="Claim verification (30 days)" /><CardBody><BarChart data={a.verification} ariaLabel="Claims by verification status" height={200} valueLabel="Claims" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /></CardBody></Card>
        <Card>
          <CardHeader title="Top questions" />
          <CardBody className="space-y-1">
            {a.topQuestions.length === 0 && <p className="text-sm text-muted">No questions yet.</p>}
            {a.topQuestions.map((q, i) => <p key={i} className="flex justify-between gap-2 text-sm"><span className="truncate">{q.question}</span><span className="text-muted">{q.count}×</span></p>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Most cited documents" />
          <CardBody className="space-y-1">
            {a.frequentlyCited.length === 0 && <p className="text-sm text-muted">No citations yet.</p>}
            {a.frequentlyCited.map((d) => <Link key={d.documentId ?? d.title} href={d.documentId ? `${KV}/documents/${d.documentId}` : "#"} className="flex justify-between gap-2 rounded p-1 text-sm hover:bg-surface-hover"><span className="truncate">{d.title}</span><span className="text-muted">{d.count}×</span></Link>)}
          </CardBody>
        </Card>
        <Card><CardHeader title="Unanswered" description="No accessible document matched." />{list(a.unanswered, "None — every question found sources.")}</Card>
        <Card><CardHeader title="Low confidence" />{list(a.lowConfidence, "None.")}</Card>
        <Card>
          <CardHeader title="Knowledge gaps" description="Terms that recur in unanswered or low-confidence questions." />
          <CardBody className="flex flex-wrap gap-2">
            {a.gaps.length === 0 && <p className="text-sm text-muted">No gaps detected.</p>}
            {a.gaps.map((g) => <span key={g.term} className="rounded-full border border-border px-2 py-0.5 text-xs">{g.term} <span className="text-muted">{g.count}</span></span>)}
          </CardBody>
        </Card>
        <Card><CardHeader title="Usage by department or module" /><CardBody>{a.byDepartment.length ? <BarChart data={a.byDepartment} ariaLabel="Questions by department" height={200} valueLabel="Questions" tickFormatter={(v) => fmtNum(v)} valueFormatter={(v) => fmtNum(v)} /> : <p className="text-sm text-muted">No usage yet.</p>}</CardBody></Card>
      </div>
    </div>
  );
}

export function QueryHistory({ rows, showAll }: { rows: QueryRow[]; showAll: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [confidence, setConfidence] = useState("");
  const shown = rows.filter((r) => (!status || r.status === status) && (!confidence || r.confidence === confidence));
  const columns: Array<DataTableColumn<QueryRow>> = [
    { key: "q", header: "Question", cell: (r) => <span><span className="font-medium">{r.question ?? <span className="text-muted">(not retained)</span>}</span>{r.categories.length ? <span className="block text-xs text-muted">{r.categories.join(", ")}</span> : null}</span> },
    { key: "s", header: "Status", cell: (r) => <StatusPill status={r.status} /> },
    { key: "c", header: "Confidence", cell: (r) => <ConfidenceBadge value={r.confidence} /> },
    ...(showAll ? [{ key: "w", header: "Asked by", hideOnMobile: true, cell: (r: QueryRow) => <span>{r.askedBy}<span className="block text-xs text-muted">{r.sourceModule === "knowledge_verification" ? r.department ?? "" : `via ${human(r.sourceModule)}`}</span></span> }] : []),
    { key: "t", header: "When", hideOnMobile: true, cell: (r) => <LocalDate value={r.createdAt} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "Any status" }, ...opts(["answered", "unanswered", "escalated"])]} />
        <Select aria-label="Confidence" className="w-44" value={confidence} onChange={(e) => setConfidence(e.target.value)} options={[{ value: "", label: "Any confidence" }, ...opts(["high", "medium", "low", "insufficient"])]} />
      </div>
      <DataTable columns={columns} rows={shown} getRowId={(r) => r.id} onRowClick={(r) => router.push(`${KV}/history/${r.id}`)} rowLabel={(r) => `Open answer to ${r.question ?? "question"}`} caption="Question history" emptyState={<p className="p-6 text-center text-sm text-muted">No questions yet.</p>} />
    </div>
  );
}

type Cat = Settings["escalationCategories"][number];

export function KnowledgeSettings({ s, indexes, members }: { s: Settings; indexes: IndexRow[]; members: Array<{ userId: string; name: string }> }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ staleDays: String(s.staleDays), reviewIntervalDays: String(s.reviewIntervalDays), storeQuestions: s.storeQuestions });
  const [cats, setCats] = useState<Array<Cat & { kw: string }>>(s.escalationCategories.map((c) => ({ ...c, kw: c.keywords.join(", ") })));
  const save = () => run(() => apiFetch(`${KV}/settings`, { method: "PATCH", body: {
    staleDays: Number(f.staleDays), reviewIntervalDays: Number(f.reviewIntervalDays), storeQuestions: f.storeQuestions,
    escalationCategories: cats.map((c) => ({ key: c.key, label: c.label, keywords: c.kw.split(",").map((k) => k.trim()).filter(Boolean), escalateWhen: c.escalateWhen, expertUserIds: c.expertUserIds })),
  } }), { success: "Settings saved" });
  const reset = () => run(() => apiFetch(`${KV}/settings`, { method: "PATCH", body: { escalationCategories: null } }), { success: "Categories reset to defaults" }).then((r) => { if (r) window.location.reload(); });
  const upd = (i: number, patch: Partial<Cat & { kw: string }>) => setCats(cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Freshness and retention" />
        <CardBody className="grid gap-3 sm:grid-cols-3">
          <FormField id="ks-stale" label="Stale after (days)" hint="Not modified or reviewed for this long">{(x) => <Input {...x} type="number" min={7} max={3650} value={f.staleDays} onChange={(e) => setF({ ...f, staleDays: e.target.value })} />}</FormField>
          <FormField id="ks-int" label="Review interval (days)" hint="Next review date after “mark reviewed”">{(x) => <Input {...x} type="number" min={7} max={3650} value={f.reviewIntervalDays} onChange={(e) => setF({ ...f, reviewIntervalDays: e.target.value })} />}</FormField>
          <div className="pt-6"><Switch checked={f.storeQuestions} onCheckedChange={(v) => setF({ ...f, storeQuestions: v })} label="Store question text" description="Needed for top questions and gaps. Also off when the organization's AI prompt retention is “none”." /></div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Expert escalation" description="Questions matching a category go to its experts — always, or only when confidence is low. Without experts, everyone with knowledge.conflict.review is notified."
          actions={s.customizedCategories ? <Button size="sm" variant="ghost" onClick={reset}>Reset to defaults</Button> : undefined} />
        <CardBody className="space-y-3">
          {cats.map((c, i) => (
            <div key={i} className="grid gap-2 border-b border-border pb-3 last:border-0 sm:grid-cols-12">
              <FormField id={`kc-label-${i}`} label="Label" className="sm:col-span-2">{(x) => <Input {...x} value={c.label} onChange={(e) => upd(i, { label: e.target.value, key: c.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") })} />}</FormField>
              <FormField id={`kc-kw-${i}`} label="Keywords (comma separated)" className="sm:col-span-3">{(x) => <Input {...x} value={c.kw} onChange={(e) => upd(i, { kw: e.target.value })} />}</FormField>
              <FormField id={`kc-when-${i}`} label="Escalate" className="sm:col-span-3">{(x) => <Select {...x} value={c.escalateWhen} onChange={(e) => upd(i, { escalateWhen: e.target.value as Cat["escalateWhen"] })} options={[{ value: "low_confidence", label: "When low confidence" }, { value: "always", label: "Always" }]} />}</FormField>
              <FormField id={`kc-exp-${i}`} label="Expert" className="sm:col-span-3">{(x) => <Select {...x} value={c.expertUserIds[0] ?? ""} onChange={(e) => upd(i, { expertUserIds: e.target.value ? [e.target.value] : [] })} options={[{ value: "", label: "Reviewers (no named expert)" }, ...members.map((m) => ({ value: m.userId, label: m.name }))]} />}</FormField>
              <div className="flex items-end sm:col-span-1"><Button size="sm" variant="ghost" aria-label={`Remove ${c.label}`} onClick={() => setCats(cats.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button></div>
            </div>
          ))}
          <Button size="sm" variant="secondary" leftIcon={<Plus className="size-4" />} onClick={() => setCats([...cats, { key: "", label: "", keywords: [], kw: "", escalateWhen: "low_confidence", expertUserIds: [] }])}>Add category</Button>
        </CardBody>
      </Card>
      <Button loading={pending} onClick={save}>Save settings</Button>
      <Card>
        <CardHeader title="Search index" description="Retrieval runs through a pluggable index provider; every provider must filter by permissions, and results are re-checked against the database ACL." />
        <CardBody className="space-y-2 text-sm">
          {indexes.map((x) => (
            <div key={x.id} className="flex flex-wrap items-start justify-between gap-2">
              <span><span className="font-medium">{x.name}</span> · <span className="font-mono text-xs">{x.provider}</span>{x.isDefault ? " · default" : ""}<span className="block text-xs text-muted">{x.description}</span></span>
              <span className="text-xs text-muted">{fmtNum(x.documentCount)} documents · {fmtNum(x.chunkCount)} chunks · built <LocalDate value={x.lastBuiltAt} /></span>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
