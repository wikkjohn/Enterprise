"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { AlertTriangle, Search, UserRoundCheck } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Textarea } from "@eaop/design-system";
import { type AnswerView } from "@eaop/module-knowledge-verification";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { AuthorityBadge, ConfidenceBadge, FreshnessBadge, human, KV, VerificationBadge } from "./common";

/** Render "[S1]" markers in an answer as anchors to the citation list. */
function withMarkers(text: string) {
  return text.split(/(\[S\d+\])/g).map((part, i) => {
    const m = /^\[(S\d+)\]$/.exec(part);
    return m ? <a key={i} href={`#cite-${m[1]}`} className="mx-0.5 rounded bg-accent-subtle px-1 text-xs font-medium text-accent hover:underline">{m[1]}</a> : <Fragment key={i}>{part}</Fragment>;
  });
}

export function AnswerDisplay({ a, canSeeVerification }: { a: AnswerView; canSeeVerification: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const cited = a.citations.filter((c) => c.cited);
  const sources = showAll || cited.length === 0 ? a.citations : cited;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={a.question ?? "Question (text not retained)"}
          description={<span>Asked by {a.askedBy} · <LocalDate value={a.createdAt} /></span>}
          actions={<ConfidenceBadge value={a.confidence.level} />}
        />
        <CardBody className="space-y-3">
          {a.hiddenReason ? (
            <p className="text-sm text-muted">{a.hiddenReason}</p>
          ) : a.response ? (
            <p className="whitespace-pre-wrap text-sm leading-6">{withMarkers(a.response)}</p>
          ) : (
            <p className="text-sm text-muted">The answer text was not retained (organization prompt-retention setting).</p>
          )}
          {a.modeNote && <p className="text-xs text-muted">{a.modeNote}</p>}
          {a.uncertainty && a.confidence.level !== "high" && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle p-2 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />{a.uncertainty}</p>
          )}
          {a.verificationFailed && <p className="text-sm text-danger">Some statements could not be verified against your sources. Treat them with caution.</p>}
          {a.escalation && (
            <p className="flex items-start gap-2 text-sm"><UserRoundCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />Sent to a {a.escalation.categories.join(" / ")} expert for review. You will be notified when they answer.</p>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Sources" description={a.citations.length ? `${cited.length} cited of ${a.citations.length} retrieved — only documents you are permitted to read are used.` : "No accessible document matched."}
            actions={cited.length > 0 && cited.length < a.citations.length ? <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Cited only" : "Show all"}</Button> : undefined} />
          <CardBody className="space-y-3">
            {sources.map((c) => (
              <div key={c.marker} id={`cite-${c.marker}`} className="space-y-1 border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-accent-subtle px-1 text-xs font-medium text-accent">{c.marker}</span>
                  {c.documentId ? <Link className="font-medium hover:underline" href={`${KV}/documents/${c.documentId}`}>{c.title}</Link> : <span className="font-medium">{c.title}</span>}
                  <AuthorityBadge value={c.authority} />
                  <FreshnessBadge value={c.freshness} />
                </div>
                <p className="text-xs text-muted">{c.sourceName ?? "—"} · v{c.version}{c.documentDate ? <> · dated <LocalDate value={c.documentDate} dateOnly /></> : null}</p>
                {c.excerpt && <p className="line-clamp-4 text-xs text-muted">{c.excerpt.replace(/^#+\s+/gm, "")}</p>}
              </div>
            ))}
            {a.citations.length === 0 && <p className="text-sm text-muted">Nothing you can access answers this question. It has been recorded as a knowledge gap.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Why this confidence" description={a.confidence.summary} />
          <CardBody className="space-y-2">
            {a.confidence.factors.map((f) => (
              <div key={f.factor} className="flex items-start justify-between gap-3 text-sm">
                <span><span className="font-medium">{f.label}</span><span className="block text-xs text-muted">{f.detail}</span></span>
                <span className={f.effect === "lowers" ? "shrink-0 text-xs text-warning" : f.effect === "raises" ? "shrink-0 text-xs text-success" : "shrink-0 text-xs text-muted"}>{f.value}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      {canSeeVerification && a.claims.length > 0 && (
        <Card>
          <CardHeader title="Claim verification" description="Each statement in the answer is checked against the retrieved sources. Nothing is marked verified unless a source states it." />
          <CardBody className="space-y-2">
            {a.claims.map((c, i) => (
              <div key={i} className="flex flex-col gap-1 border-b border-border pb-2 text-sm last:border-0 sm:flex-row sm:items-start sm:gap-3">
                <span className="shrink-0"><VerificationBadge value={c.status} /></span>
                <span className="min-w-0 flex-1">{c.text ?? <span className="text-muted">(statement not retained)</span>}{c.important && <span className="ml-1 text-xs text-muted">· key claim</span>}<span className="block text-xs text-muted">{c.explanation}</span></span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export function AskPanel({ recent, canSeeVerification }: { recent: Array<{ id: string; question: string | null; confidence: string | null; status: string; createdAt: string }>; canSeeVerification: boolean }) {
  const { run, pending } = useMutation();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AnswerView | null>(null);
  const ask = async () => {
    const r = await run(() => apiFetch<AnswerView>(`${KV}/ask`, { body: { question } }), { refresh: false });
    if (r) setAnswer(r);
  };
  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-3">
          <Textarea aria-label="Your question" rows={3} placeholder="e.g. How much can I expense for meals when travelling?" value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && question.trim().length >= 3) void ask(); }} />
          <div className="flex flex-wrap items-center gap-3">
            <Button leftIcon={<Search className="size-4" />} loading={pending} disabled={question.trim().length < 3} onClick={ask}>Ask</Button>
            <span className="text-xs text-muted">Answers use only approved documents you are permitted to read, with citations. Ctrl/⌘ + Enter to ask.</span>
          </div>
        </CardBody>
      </Card>
      {answer && <AnswerDisplay a={answer} canSeeVerification={canSeeVerification} />}
      {!answer && recent.length > 0 && (
        <Card>
          <CardHeader title="Your recent questions" />
          <CardBody className="space-y-1">
            {recent.slice(0, 8).map((q) => (
              <Link key={q.id} href={`${KV}/history/${q.id}`} className="flex items-center justify-between gap-3 rounded-md p-1.5 text-sm hover:bg-surface-hover">
                <span className="truncate">{q.question ?? "(question not retained)"}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted">{human(q.status)} · <ConfidenceBadge value={q.confidence} /></span>
              </Link>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
