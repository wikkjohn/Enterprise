import { PageHeader } from "@eaop/design-system";
import { ReviewQueues } from "@/components/knowledge/reviews";
import { Forbidden } from "@/components/forbidden";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Review queues" };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ tab?: string; focus?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const canConflicts = can(viewer, "knowledge.conflict.review");
  const canManage = can(viewer, "knowledge.manage");
  if (!canConflicts && !canManage) return <Forbidden permission="knowledge.conflict.review" />;
  const platform = await getPlatform();
  const svc = kv(platform);
  const reviews = await svc.listReviews(viewer.ctx);
  const conflicts = canConflicts ? await svc.listConflicts(viewer.ctx) : [];
  const members = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [{ userId: viewer.user.id, name: viewer.user.name }];
  return (
    <div className="space-y-6">
      <PageHeader title="Review queues" description="Expert escalations, conflicting documents, and documents that are stale, expired or have no owner." />
      <ReviewQueues reviews={reviews} conflicts={conflicts} members={members} canConflicts={canConflicts} canManage={canManage} initialTab={sp.tab === "conflicts" && canConflicts ? "conflicts" : "queue"} focus={sp.focus} />
    </div>
  );
}
