import { PageHeader } from "@eaop/design-system";
import { OptimizationView } from "@/components/ai-ops/models";
import { Forbidden } from "@/components/forbidden";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Optimization" };

export default async function OptimizationPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "ai_ops.cost.read")) return <Forbidden permission="ai_ops.cost.read" />;
  const findings = await ops(await getPlatform()).listFindings(viewer.ctx, { status: "all" });
  return (
    <div className="space-y-6">
      <PageHeader title="Cost optimization" description="Unused licenses, duplicate tools, expensive models for simple tasks, abnormal usage, cost spikes, idle tools and underused contracts." />
      <OptimizationView findings={findings} canManage={can(viewer, "ai_ops.cost.manage")} />
    </div>
  );
}
