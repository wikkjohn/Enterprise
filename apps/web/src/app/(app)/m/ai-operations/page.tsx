import { PageHeader } from "@eaop/design-system";
import { ExecutiveDashboard, PersonalWorkspace } from "@/components/ai-ops/dashboard";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";

export const metadata = { title: "Dashboard" };

export default async function AiOpsDashboardPage() {
  const viewer = await requireViewer();
  const d = await ops(await getPlatform()).dashboard(viewer.ctx);
  return d.mode === "executive" ? (
    <div className="space-y-6">
      <PageHeader title="AI operations" description="What AI the organization uses, what it costs, who uses it, what it is worth — and what to consolidate. Every money figure says whether it is measured, estimated or allocated." />
      <ExecutiveDashboard d={d} />
    </div>
  ) : (
    <div className="space-y-6">
      <PageHeader title="Your AI workspace" description="Approved tools, your training, your requests and the approved use cases for your work." />
      <PersonalWorkspace d={d} />
    </div>
  );
}
