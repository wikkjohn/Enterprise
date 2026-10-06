import { PageHeader } from "@eaop/design-system";
import { TrainingView } from "@/components/ai-ops/people";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI training" };

export default async function TrainingPage() {
  const viewer = await requireViewer();
  const svc = ops(await getPlatform());
  const canManage = can(viewer, "ai_ops.training.manage");
  const [mine, programs, records] = [await svc.listAssignments(viewer.ctx, { mine: true }), await svc.listPrograms(viewer.ctx), canManage ? await svc.listAssignments(viewer.ctx) : null];
  return (
    <div className="space-y-6">
      <PageHeader title="AI training" description="Training built around real job workflows: programs, courses, assignments, assessments and renewals." />
      <TrainingView mine={mine} programs={programs} records={records} canManage={canManage} />
    </div>
  );
}
