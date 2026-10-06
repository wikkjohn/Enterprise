import { PageHeader } from "@eaop/design-system";
import { ReviewList } from "@/components/agents/governance";
import { ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Reviews" };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;
  const viewer = await requireViewer();
  const reviews = await ag(await getPlatform()).listReviews(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Agent reviews" description="Periodic attestation that each agent's purpose, permissions and systems are still valid. Scheduled on approval by risk band (critical 30 d · high 90 d · medium 180 d · low 365 d); owners are reminded 7 days ahead." />
      <ReviewList reviews={reviews} focus={focus} viewerId={viewer.user.id} canManage={can(viewer, "agent.manage")} />
    </div>
  );
}
