"use client";

import Link from "next/link";
import { BarChart, Card, CardBody, CardHeader, DataTable, EmptyState, StatCard, type DataTableColumn } from "@eaop/design-system";
import { type DashboardView } from "@eaop/module-workflow-intelligence";
import { countTick, fmtNum, fmtPct, fmtUsd, QUADRANT, WI } from "./common";

type PvA = DashboardView["projectedVsActual"][number];

export function WorkflowDashboard({ data }: { data: DashboardView }) {
  const t = data.totals;
  const fin = data.canSeeFinancials;
  const suffix = data.dataClass === "sample" ? "?data=sample" : "";
  if (t.workflows === 0) {
    return (
      <EmptyState
        title={data.dataClass === "sample" ? "No sample workflows loaded" : "No workflows in the inventory yet"}
        description="Add workflows manually, import a CSV, or discover them through a connector. You can also load sample workflows to explore — they stay separate from production data."
        action={<Link className="text-accent underline" href={`${WI}/workflows${suffix}`}>Go to the inventory</Link>}
      />
    );
  }
  const hidden = "Requires workflow.roi.read";
  const columns: Array<DataTableColumn<PvA>> = [
    { key: "wf", header: "Implementation", cell: (r) => <Link className="font-medium hover:underline" href={`${WI}/implementations/${r.implementationId}${suffix}`}>{r.workflowName}</Link> },
    { key: "stage", header: "Stage", cell: (r) => <span className="capitalize">{r.stage}</span> },
    { key: "p", header: "Projected savings / yr", align: "right", cell: (r) => fmtUsd(r.projected) },
    { key: "a", header: "Actual savings / yr", align: "right", cell: (r) => fmtUsd(r.actual) },
    { key: "v", header: "Variance", align: "right", cell: (r) => (r.projected != null && r.actual != null ? <span className={r.actual >= r.projected ? "text-success" : "text-danger"}>{fmtUsd(r.actual - r.projected)}</span> : "—") },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Workflows" value={fmtNum(t.workflows)} hint={`${fmtNum(t.analyzed)} analyzed`} />
        <StatCard label="High-value opportunities" value={fmtNum(t.highValueOpportunities)} hint={data.formulas.highValueOpportunities} />
        <StatCard label="AI-ready workflows" value={fmtNum(t.aiReady)} hint={data.formulas.aiReady} />
        <StatCard label="Active implementations" value={fmtNum(t.activeImplementations)} hint={data.formulas.activeImplementations} />
        <StatCard label="Estimated annual savings" value={fin ? fmtUsd(t.estimatedAnnualSavings, true) : "—"} hint={fin ? data.formulas.estimatedAnnualSavings : hidden} />
        <StatCard label="Potential annual revenue" value={fin ? fmtUsd(t.potentialRevenue, true) : "—"} hint={fin ? "Σ revenue-uplift assumptions of non-rejected opportunities." : hidden} />
        <StatCard label="Recoverable labor hours / yr" value={fmtNum(t.laborHoursRecoverable)} hint={data.formulas.laborHoursRecoverable} />
        <StatCard label="Implementation investment" value={fin ? fmtUsd(t.implementationInvestment, true) : "—"} hint={fin ? data.formulas.implementationInvestment : hidden} />
        <StatCard label="Projected ROI (3 yr)" value={fin ? fmtPct(t.projectedRoi3yrPct) : "—"} hint={fin ? data.formulas.projectedRoi3yrPct : hidden} />
        <StatCard label="Realized ROI (annualized)" value={fin ? fmtPct(t.realizedRoiPct) : "—"} hint={fin ? data.formulas.realizedRoiPct : hidden} />
        <StatCard label="Realized savings / yr" value={fin ? fmtUsd(t.realizedAnnualSavings, true) : "—"} hint={fin ? "Annualized from post-deployment measurements." : hidden} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Opportunities by department" description={fin ? "Projected annual savings per department." : "Workflows per department."} />
          <CardBody>
            <BarChart
              ariaLabel={fin ? "Projected annual savings by department" : "Workflows by department"}
              data={data.byDepartment.map((d) => ({ label: d.label, value: fin ? (d.savings ?? 0) : d.workflows }))}
              valueFormatter={fin ? (v) => fmtUsd(v) : (v) => fmtNum(v)}
              valueLabel={fin ? "Savings / yr" : "Workflows"}
              tickFormatter={fin ? undefined : countTick}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Portfolio quadrants" description="Value vs. complexity placement of analyzed workflows." />
          <CardBody>
            <BarChart ariaLabel="Opportunities by quadrant" data={data.quadrants.map((q) => ({ label: QUADRANT[q.label]?.label ?? q.label, value: q.value }))} valueLabel="Workflows" tickFormatter={countTick} color="var(--color-chart-3)" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Automation readiness" description="Latest Automation Readiness score band." />
          <CardBody><BarChart ariaLabel="Workflows by automation readiness" data={data.byReadiness} valueLabel="Workflows" tickFormatter={countTick} color="var(--color-chart-1)" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Risk" description="Latest Risk score band." />
          <CardBody><BarChart ariaLabel="Workflows by risk" data={data.byRisk} valueLabel="Workflows" tickFormatter={countTick} color="var(--color-chart-2)" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Integration complexity" description="Latest Integration Complexity score band." />
          <CardBody><BarChart ariaLabel="Workflows by integration complexity" data={data.byComplexity} valueLabel="Workflows" tickFormatter={countTick} color="var(--color-chart-4)" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Projected vs actual savings" description="Per implementation, from the latest analysis and post-deployment measurements." />
          <CardBody>
            {fin && data.projectedVsActual.some((r) => r.actual != null) ? (
              <BarChart
                ariaLabel="Actual minus projected annual savings per implementation"
                data={data.projectedVsActual.filter((r) => r.actual != null).map((r) => ({ label: r.workflowName, value: (r.actual ?? 0) - (r.projected ?? 0) }))}
                valueFormatter={(v) => fmtUsd(v)}
                valueLabel="Variance / yr"
                color="var(--color-chart-5)"
              />
            ) : (
              <p className="text-sm text-muted">{fin ? "No implementation has post-deployment measurements yet." : hidden}</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Implementations" description="Projected vs actual annual savings and variance." />
        <DataTable columns={columns} rows={data.projectedVsActual} getRowId={(r) => r.implementationId} caption="Implementations: projected vs actual" emptyState={<p className="p-6 text-center text-sm text-muted">No implementations yet. Approve an opportunity and start tracking it from the portfolio.</p>} />
      </Card>
    </div>
  );
}
