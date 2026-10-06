import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { AnswerDisplay } from "@/components/knowledge/answer";
import { Forbidden } from "@/components/forbidden";
import { KV_BASE, kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Answer" };

export default async function AnswerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "knowledge.search")) return <Forbidden permission="knowledge.search" />;
  const a = await kv(await getPlatform()).getAnswer(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Answer" breadcrumbs={<Breadcrumbs items={[{ label: "History", href: `${KV_BASE}/history` }, { label: "Answer" }]} />} />
      <AnswerDisplay a={a} canSeeVerification />
    </div>
  );
}
