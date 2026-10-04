"use client";

import { BarChart, Card, CardBody, CardHeader, LineChart, StatCard } from "@eaop/design-system";

type Row = { key: string | null; metric: string; unit: string; quantity: number };

export function UsageDashboard({ byDay, byModel, byModule, totals }: { byDay: Row[]; byModel: Row[]; byModule: Row[]; totals: Row[] }) {
  const total = (m: string) => totals.find((t) => t.metric === m)?.quantity ?? 0;
  const days = [...new Set(byDay.map((r) => r.key ?? ""))].sort();
  const series = (metric: string) => days.map((d) => ({ x: d, y: byDay.find((r) => r.key === d && r.metric === metric)?.quantity ?? 0 }));
  const costByModel = byModel.filter((r) => r.metric === "ai.cost").map((r) => ({ label: r.key ?? "unknown", value: r.quantity })).sort((a, b) => b.value - a.value);
  const runsByModule = byModule.filter((r) => r.metric === "ai.runs").map((r) => ({ label: r.key ?? "unknown", value: r.quantity })).sort((a, b) => b.value - a.value);
  const usd = (v: number) => `$${v.toFixed(2)}`;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="AI runs" value={total("ai.runs").toLocaleString()} trend={series("ai.runs").map((p) => p.y)} />
        <StatCard label="Tokens (in + out)" value={(total("ai.input_tokens") + total("ai.output_tokens")).toLocaleString()} />
        <StatCard label="Estimated AI cost" value={usd(total("ai.cost"))} trend={series("ai.cost").map((p) => p.y)} hint="Estimated from configured model prices" />
        <StatCard label="Connector actions" value={total("connector.actions").toLocaleString()} />
      </div>
      <Card>
        <CardHeader title="Daily AI activity" description="Last 30 days" />
        <CardBody>
          {days.length === 0 ? <p className="text-sm text-muted">No usage recorded yet.</p> : (
            <LineChart ariaLabel="Daily AI runs and connector actions" series={[{ id: "runs", label: "AI runs", data: series("ai.runs") }, { id: "conn", label: "Connector actions", data: series("connector.actions") }]} />
          )}
        </CardBody>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Estimated cost by model" />
          <CardBody>{costByModel.length ? <BarChart ariaLabel="Estimated AI cost by model" data={costByModel} valueFormatter={usd} /> : <p className="text-sm text-muted">No AI cost recorded.</p>}</CardBody>
        </Card>
        <Card>
          <CardHeader title="AI runs by module" />
          <CardBody>{runsByModule.length ? <BarChart ariaLabel="AI runs by module" data={runsByModule} /> : <p className="text-sm text-muted">No AI runs recorded.</p>}</CardBody>
        </Card>
      </div>
    </div>
  );
}
