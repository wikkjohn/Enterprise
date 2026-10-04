import { PageHeader } from "@eaop/design-system";
import { UsageDashboard } from "@/components/admin/usage";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Usage" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "usage.read")) return <Forbidden permission="usage.read" />;
  const p = await getPlatform();
  const range = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() + 60_000) };
  const [byDay, byModel, byModule, totals] = await Promise.all([
    p.usage.summary(viewer.ctx, { ...range, groupBy: "day" }),
    p.usage.summary(viewer.ctx, { ...range, groupBy: "ai_model" }),
    p.usage.summary(viewer.ctx, { ...range, groupBy: "module" }),
    p.usage.summary(viewer.ctx, { ...range, groupBy: "metric" }),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="Usage" description="Metered usage across modules: AI runs, tokens, estimated cost, connector actions and API requests." />
      <UsageDashboard byDay={byDay} byModel={byModel} byModule={byModule} totals={totals} />
    </div>
  );
}
