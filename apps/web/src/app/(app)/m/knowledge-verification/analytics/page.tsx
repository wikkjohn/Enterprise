import { PageHeader } from "@eaop/design-system";
import { KnowledgeAnalytics } from "@/components/knowledge/insights";
import { Forbidden } from "@/components/forbidden";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "knowledge.verification.read")) return <Forbidden permission="knowledge.verification.read" />;
  const a = await kv(await getPlatform()).analytics(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Knowledge analytics" description="What people ask, how well the knowledge layer answers, and where knowledge is missing or out of date. Last 30 days." />
      <KnowledgeAnalytics a={a} />
    </div>
  );
}
