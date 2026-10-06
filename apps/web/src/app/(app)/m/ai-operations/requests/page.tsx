import { PageHeader } from "@eaop/design-system";
import { RequestList } from "@/components/ai-ops/requests";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI requests" };

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const all = can(viewer, "ai_ops.request.manage");
  const requests = await ops(await getPlatform()).listRequests(viewer.ctx, { mine: !all });
  return (
    <div className="space-y-6">
      <PageHeader title={all ? "AI requests" : "My AI requests"} description="Request a new AI tool, automation, model, agent, integration or use case. Each passes business, security, technical and financial review." />
      <RequestList requests={requests} all={all} initialStage={sp.stage} />
    </div>
  );
}
