import { PageHeader } from "@eaop/design-system";
import { ToolList } from "@/components/ai-ops/inventory";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI tools" };

export default async function ToolsPage() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const svc = ops(platform);
  const tools = await svc.listTools(viewer.ctx);
  const canManage = can(viewer, "ai_ops.tool.manage");
  const vendors = canManage ? (await svc.listVendors(viewer.ctx)).map((v) => ({ id: v.id, name: v.name })) : [];
  const members = canManage && can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="AI tools" description="Every AI tool in use: owner, purpose, status, licenses, cost, reviews and how it connects to the platform." />
      <ToolList tools={tools} vendors={vendors} members={members} canManage={canManage} canCost={can(viewer, "ai_ops.cost.read")} />
    </div>
  );
}
