import { PageHeader } from "@eaop/design-system";
import { EnablementView } from "@/components/ai-ops/people";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Enablement" };

export default async function EnablementPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const svc = ops(await getPlatform());
  const canManage = can(viewer, "ai_ops.training.manage");
  await svc.listTemplates(viewer.ctx);
  const [useCases, tools, programs] = [await svc.listUseCases(viewer.ctx), canManage ? await svc.listTools(viewer.ctx) : [], canManage ? await svc.listPrograms(viewer.ctx) : []];
  return (
    <div className="space-y-6">
      <PageHeader title="Role-based AI enablement" description="Approved use cases per department: the problem, the approved workflow and tool, instructions, benefit, risks, required training and how success is measured." />
      <EnablementView useCases={useCases} departments={svc.departments()} tools={tools.map((t) => ({ id: t.id, name: t.name, status: t.status }))} programs={programs.map((p) => ({ id: p.id, name: p.name }))} canManage={canManage} focus={sp.focus} />
    </div>
  );
}
