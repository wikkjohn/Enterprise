import { PageHeader } from "@eaop/design-system";
import { CostsView } from "@/components/ai-ops/costs";
import { Forbidden } from "@/components/forbidden";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI costs" };

export default async function CostsPage({ searchParams }: { searchParams: Promise<{ by?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  if (!can(viewer, "ai_ops.cost.read")) return <Forbidden permission="ai_ops.cost.read" />;
  const svc = ops(await getPlatform());
  const canSeeUsers = can(viewer, "ai_ops.admin");
  const [breakdown, records, budgets, forecast, units, value, tools, vendors] = [
    await svc.breakdown(viewer.ctx, { by: sp.by === "user" && !canSeeUsers ? "category" : sp.by, from: sp.from, to: sp.to }), await svc.listRecords(viewer.ctx), await svc.listBudgets(viewer.ctx), await svc.listForecasts(viewer.ctx),
    await svc.unitEconomicsFor(viewer.ctx), await svc.listValue(viewer.ctx), await svc.listTools(viewer.ctx), await svc.listVendors(viewer.ctx),
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="AI costs" description="Spend by any dimension, cost records and allocation, budgets, forecasts, unit economics and value — measured, estimated and allocated kept apart." />
      <CostsView breakdown={breakdown} records={records} budgets={budgets} forecast={forecast} units={units} value={value} canManage={can(viewer, "ai_ops.cost.manage")} canSeeUsers={canSeeUsers}
        tools={tools.map((t) => ({ id: t.id, name: t.name }))} vendors={vendors.map((v) => ({ id: v.id, name: v.name }))} />
    </div>
  );
}
