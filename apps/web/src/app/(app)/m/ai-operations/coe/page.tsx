import { PageHeader } from "@eaop/design-system";
import { CoeView } from "@/components/ai-ops/coe";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Center of Excellence" };

export default async function CoePage() {
  const viewer = await requireViewer();
  const svc = ops(await getPlatform());
  const [items, templates, tools, policies, requests] = [await svc.listCoe(viewer.ctx), await svc.listTemplates(viewer.ctx), await svc.listTools(viewer.ctx), await svc.listPolicies(viewer.ctx).catch(() => []), await svc.listRequests(viewer.ctx, { stage: "open" })];
  const approvedModels = [...new Set(policies.filter((p) => p.status === "active").flatMap((p) => p.allowedModels))];
  return (
    <div className="space-y-6">
      <PageHeader title="AI Center of Excellence" description="Standards, policies, approved tools and models, implementation patterns, training and guidance in one place." />
      <CoeView items={items} templates={templates} approvedTools={tools.filter((t) => t.status === "strategic" || t.status === "approved").map((t) => ({ id: t.id, name: t.name, status: t.status }))} approvedModels={approvedModels}
        pendingRequests={requests.filter((r) => !["approved", "implementation", "measurement"].includes(r.stage)).length} canAdmin={can(viewer, "ai_ops.admin")} />
    </div>
  );
}
