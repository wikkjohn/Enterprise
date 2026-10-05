"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CheckCircle2, Rocket, XCircle } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, DataTable, FilterBar, FormField, Input, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type OpportunityView } from "@eaop/module-workflow-intelligence";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { fmtMonths, fmtNum, LocalDate, fmtPct, fmtUsd, QUADRANT, QuadrantBadge, ScoreBar, WI, WI_API } from "./common";

const STATUS_TONE = { identified: "info", approved: "success", rejected: "danger", in_implementation: "accent", delivered: "success" } as const;
const SORTS = [
  { value: "value", label: "Rank by value score" },
  { value: "savings", label: "Rank by annual savings" },
  { value: "roi", label: "Rank by 3-year ROI" },
  { value: "priority", label: "Rank by strategic priority" },
  { value: "risk", label: "Lowest risk first" },
];

export function OpportunityPortfolio({ opportunities, dataClass, focus, viewerId, perms }: { opportunities: OpportunityView[]; dataClass: string; focus?: string; viewerId: string; perms: { approve: boolean; implement: boolean } }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [quadrant, setQuadrant] = useState("");
  const [dept, setDept] = useState("");
  const [sort, setSort] = useState("value");
  const [active, setActive] = useState<OpportunityView | null>(opportunities.find((o) => o.id === focus) ?? null);
  const suffix = dataClass === "sample" ? "?data=sample" : "";
  const departments = useMemo(() => [...new Set(opportunities.map((o) => o.department).filter((d): d is string => !!d))].sort(), [opportunities]);
  const fin = opportunities.some((o) => o.estimatedAnnualSavings != null);

  const sorted = useMemo(() => {
    const key: Record<string, (o: OpportunityView) => number> = {
      value: (o) => o.valueScore,
      savings: (o) => o.estimatedAnnualSavings ?? o.valueScore,
      roi: (o) => o.roi3yrPct ?? -Infinity,
      priority: (o) => o.strategicPriority * 1000 + o.valueScore,
      risk: (o) => -o.riskScore,
    };
    const f = key[sort]!;
    return opportunities
      .filter((o) => (!q || `${o.workflowName} ${o.department ?? ""}`.toLowerCase().includes(q.toLowerCase())) && (!status || o.status === status) && (!quadrant || o.quadrant === quadrant) && (!dept || o.department === dept))
      .sort((a, b) => f(b) - f(a) || b.valueScore - a.valueScore);
  }, [opportunities, q, status, quadrant, dept, sort]);

  const columns: Array<DataTableColumn<OpportunityView & { rank: number }>> = [
    { key: "rank", header: "#", align: "right", cell: (o) => <span className="tabular-nums text-subtle">{o.rank}</span>, width: "48px" },
    { key: "wf", header: "Workflow", cell: (o) => <span className="font-medium">{o.workflowName}</span> },
    { key: "dept", header: "Department", hideOnMobile: true, cell: (o) => o.department ?? "—" },
    { key: "q", header: "Quadrant", cell: (o) => <QuadrantBadge value={o.quadrant} /> },
    { key: "v", header: "Value", cell: (o) => <ScoreBar value={o.valueScore} label="Value" /> },
    { key: "c", header: "Complexity", hideOnMobile: true, cell: (o) => <ScoreBar value={o.complexityScore} higherIsBetter={false} label="Complexity" /> },
    { key: "r", header: "Risk", hideOnMobile: true, cell: (o) => <ScoreBar value={o.riskScore} higherIsBetter={false} label="Risk" /> },
    ...(fin
      ? ([
          { key: "s", header: "Savings / yr", align: "right", cell: (o) => fmtUsd(o.estimatedAnnualSavings, true) },
          { key: "roi", header: "ROI 3 yr", align: "right", hideOnMobile: true, cell: (o) => fmtPct(o.roi3yrPct) },
          { key: "pb", header: "Payback", align: "right", hideOnMobile: true, cell: (o) => fmtMonths(o.paybackMonths) },
        ] as Array<DataTableColumn<OpportunityView & { rank: number }>>)
      : []),
    { key: "h", header: "Hours / yr", align: "right", hideOnMobile: true, cell: (o) => fmtNum(o.laborHoursRecoverable) },
    { key: "p", header: "Priority", align: "right", hideOnMobile: true, cell: (o) => `P${o.strategicPriority}` },
    { key: "st", header: "Status", cell: (o) => <Badge tone={STATUS_TONE[o.status as keyof typeof STATUS_TONE] ?? "neutral"}>{o.status.replace("_", " ")}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Value vs. complexity" description="Each dot is an analyzed workflow; size reflects recoverable labor hours, color the risk score. Click a dot to review it." />
        <CardBody><QuadrantChart opportunities={sorted} onSelect={setActive} /></CardBody>
      </Card>
      <FilterBar onSearchChange={setQ} searchPlaceholder="Search opportunities">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "Any status" }, ...Object.keys(STATUS_TONE).map((s) => ({ value: s, label: s.replace("_", " ") }))]} />
        <Select aria-label="Quadrant" value={quadrant} onChange={(e) => setQuadrant(e.target.value)} options={[{ value: "", label: "Any quadrant" }, ...Object.entries(QUADRANT).map(([k, v]) => ({ value: k, label: v.label }))]} />
        <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} options={[{ value: "", label: "All departments" }, ...departments.map((d) => ({ value: d, label: d }))]} />
        <Select aria-label="Ranking" value={sort} onChange={(e) => setSort(e.target.value)} options={SORTS} />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={sorted.map((o, i) => ({ ...o, rank: i + 1 }))}
        getRowId={(o) => o.id}
        onRowClick={(o) => setActive(o)}
        rowLabel={(o) => `Review ${o.workflowName}`}
        caption="Opportunity ranking"
        emptyState={<p className="p-6 text-center text-sm text-muted">No opportunities yet. Analyze workflows in the inventory to populate the portfolio.</p>}
      />
      {active && <OpportunityModal opp={active} perms={perms} viewerId={viewerId} suffix={suffix} onClose={() => setActive(null)} onOpenImplementation={(id) => router.push(`${WI}/implementations/${id}${suffix}`)} />}
    </div>
  );
}

function QuadrantChart({ opportunities, onSelect }: { opportunities: OpportunityView[]; onSelect: (o: OpportunityView) => void }) {
  const S = 360;
  const P = 36;
  const maxH = Math.max(1, ...opportunities.map((o) => o.laborHoursRecoverable));
  const x = (complexity: number) => P + (complexity / 100) * (S - 2 * P);
  const y = (value: number) => S - P - (value / 100) * (S - 2 * P);
  const color = (risk: number) => (risk >= 67 ? "var(--color-danger)" : risk >= 34 ? "var(--color-warning)" : "var(--color-success)");
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-md" role="group" aria-label="Opportunity quadrant chart: value (vertical) against complexity (horizontal)">
        <rect x={P} y={P} width={(S - 2 * P) / 2} height={(S - 2 * P) / 2} fill="var(--color-success-subtle)" />
        <rect x={S / 2} y={P} width={(S - 2 * P) / 2} height={(S - 2 * P) / 2} fill="var(--color-accent-subtle)" />
        <rect x={P} y={S / 2} width={(S - 2 * P) / 2} height={(S - 2 * P) / 2} fill="var(--color-surface-hover)" />
        <rect x={S / 2} y={S / 2} width={(S - 2 * P) / 2} height={(S - 2 * P) / 2} fill="var(--color-warning-subtle)" />
        <text x={P + 6} y={P + 16} className="fill-[var(--color-success)] text-[11px] font-semibold">Quick wins</text>
        <text x={S - P - 6} y={P + 16} textAnchor="end" className="fill-[var(--color-accent)] text-[11px] font-semibold">Strategic bets</text>
        <text x={P + 6} y={S - P - 8} className="fill-[var(--color-muted)] text-[11px] font-semibold">Fill-ins</text>
        <text x={S - P - 6} y={S - P - 8} textAnchor="end" className="fill-[var(--color-warning)] text-[11px] font-semibold">Deprioritize</text>
        <line x1={P} y1={S - P} x2={S - P} y2={S - P} stroke="var(--color-border-strong)" />
        <line x1={P} y1={P} x2={P} y2={S - P} stroke="var(--color-border-strong)" />
        <text x={S / 2} y={S - 8} textAnchor="middle" className="fill-[var(--color-muted)] text-[11px]">Complexity →</text>
        <text x={12} y={S / 2} textAnchor="middle" transform={`rotate(-90 12 ${S / 2})`} className="fill-[var(--color-muted)] text-[11px]">Value →</text>
        {opportunities.map((o) => (
          <circle
            key={o.id}
            cx={x(o.complexityScore)}
            cy={y(o.valueScore)}
            r={5 + 9 * Math.sqrt(o.laborHoursRecoverable / maxH)}
            fill={color(o.riskScore)}
            fillOpacity={0.75}
            stroke="var(--color-surface)"
            strokeWidth={1.5}
            role="button"
            tabIndex={0}
            aria-label={`${o.workflowName}: value ${o.valueScore}, complexity ${o.complexityScore}, risk ${o.riskScore}`}
            className="cursor-pointer outline-none focus:stroke-[var(--color-ring)]"
            onClick={() => onSelect(o)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(o)}
          >
            <title>{`${o.workflowName} — value ${o.valueScore}, complexity ${o.complexityScore}, risk ${o.riskScore}`}</title>
          </circle>
        ))}
      </svg>
      <div className="space-y-2 text-sm text-muted">
        <p>Value = 60% AI Opportunity + 40% Expected ROI. Complexity = 50% Integration Complexity + 30% (100 − Automation Readiness) + 20% (100 − Data Readiness). The quadrant thresholds are 50 on both axes.</p>
        <p className="flex flex-wrap gap-3">
          <span className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-success" aria-hidden />Low risk</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-warning" aria-hidden />Medium risk</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-full bg-danger" aria-hidden />High risk</span>
        </p>
      </div>
    </div>
  );
}

function OpportunityModal({ opp, perms, viewerId, suffix, onClose, onOpenImplementation }: { opp: OpportunityView; perms: { approve: boolean; implement: boolean }; viewerId: string; suffix: string; onClose: () => void; onOpenImplementation: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState(String(opp.strategicPriority));
  const [owner, setOwner] = useState("");
  const { run, pending } = useMutation();
  const decide = async (decision: "approve" | "reject") => {
    if (await run(() => apiFetch(`${WI_API}/opportunities/${opp.id}/decision`, { body: { decision, note: note || undefined, strategicPriority: Number(priority) } }), { success: `Opportunity ${decision === "approve" ? "approved" : "rejected"}` })) onClose();
  };
  const start = async () => {
    const impl = await run(() => apiFetch<{ id: string }>(`${WI_API}/opportunities/${opp.id}/implementation`, { body: { owner: owner || undefined } }), { success: "Implementation tracking started", refresh: false });
    if (impl) onOpenImplementation(impl.id);
  };
  const ownAnalysis = opp.createdBy === viewerId;
  const canDecide = perms.approve && (opp.status === "identified" || opp.status === "rejected");
  return (
    <Modal open onClose={onClose} size="lg" title={opp.workflowName} description={`${QUADRANT[opp.quadrant]?.label ?? opp.quadrant} · status ${opp.status.replace("_", " ")}`}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Value" value={String(opp.valueScore)} />
          <Metric label="Complexity" value={String(opp.complexityScore)} />
          <Metric label="Risk" value={String(opp.riskScore)} />
          <Metric label="Hours / yr" value={fmtNum(opp.laborHoursRecoverable)} />
          {opp.estimatedAnnualSavings != null && (
            <>
              <Metric label="Savings / yr" value={fmtUsd(opp.estimatedAnnualSavings)} />
              <Metric label="Revenue / yr" value={fmtUsd(opp.potentialRevenue)} />
              <Metric label="Implementation" value={fmtUsd(opp.implementationCost)} />
              <Metric label="ROI 3 yr / payback" value={`${fmtPct(opp.roi3yrPct)} · ${fmtMonths(opp.paybackMonths)}`} />
            </>
          )}
        </div>
        <p><Link className="text-accent hover:underline" href={`${WI}/workflows/${opp.workflowId}${suffix}`}>Open workflow, scores and ROI basis →</Link></p>
        {opp.decidedAt && <p className="text-muted">Decided <LocalDate value={opp.decidedAt} />{opp.decisionNote ? ` — “${opp.decisionNote}”` : ""}</p>}
        {canDecide && (
          <div className="space-y-3 border-t border-border pt-3">
            {ownAnalysis && <p className="text-warning">Separation of duties: you produced this analysis, so someone else must approve it.</p>}
            <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
              <FormField id="dec-note" label="Decision note">{(a) => <Textarea {...a} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</FormField>
              <FormField id="dec-prio" label="Strategic priority">{(a) => <Select {...a} value={priority} onChange={(e) => setPriority(e.target.value)} options={[5, 4, 3, 2, 1].map((p) => ({ value: String(p), label: `P${p}${p === 5 ? " (highest)" : p === 1 ? " (lowest)" : ""}` }))} />}</FormField>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" leftIcon={<XCircle className="size-4" />} loading={pending} onClick={() => decide("reject")}>Reject</Button>
              <Button leftIcon={<CheckCircle2 className="size-4" />} loading={pending} disabled={ownAnalysis} onClick={() => decide("approve")}>Approve</Button>
            </div>
          </div>
        )}
        {opp.implementationId ? (
          <Button variant="secondary" onClick={() => onOpenImplementation(opp.implementationId!)}>Open implementation</Button>
        ) : perms.implement && (opp.status === "identified" || opp.status === "approved") ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <FormField id="impl-owner" label="Implementation owner" className="min-w-56 flex-1">{(a) => <Input {...a} value={owner} onChange={(e) => setOwner(e.target.value)} />}</FormField>
            <Button leftIcon={<Rocket className="size-4" />} loading={pending} onClick={start}>Start tracking</Button>
            {opp.status === "identified" && <p className="w-full text-xs text-muted">Starts at Proposed. It cannot move to Approved until the opportunity is approved.</p>}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-xs text-subtle">{label}</p>
      <p className="tabular-nums font-medium">{value}</p>
    </div>
  );
}
