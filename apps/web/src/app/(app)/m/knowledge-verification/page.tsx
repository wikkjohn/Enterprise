import { PageHeader } from "@eaop/design-system";
import { AskPanel } from "@/components/knowledge/answer";
import { Forbidden } from "@/components/forbidden";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Ask" };

export default async function AskPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "knowledge.search")) return <Forbidden permission="knowledge.search" />;
  const recent = await kv(await getPlatform()).listQueries(viewer.ctx, { mine: true });
  return (
    <div className="space-y-6">
      <PageHeader title="Ask" description="Answers come only from approved documents you are permitted to read. Every statement is checked against its sources, and the confidence explains itself." />
      <AskPanel recent={recent} canSeeVerification />
    </div>
  );
}
