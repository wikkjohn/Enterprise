import { PageHeader } from "@eaop/design-system";
import { QueryHistory } from "@/components/knowledge/insights";
import { Forbidden } from "@/components/forbidden";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "History" };

export default async function HistoryPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "knowledge.search")) return <Forbidden permission="knowledge.search" />;
  const all = can(viewer, "knowledge.verification.read");
  const rows = await kv(await getPlatform()).listQueries(viewer.ctx, { mine: !all });
  return (
    <div className="space-y-6">
      <PageHeader title={all ? "Question history" : "Your questions"} description={all ? "Every question asked in the organization, including through other modules. Answer text is shown only when you can access its sources." : "Questions you have asked."} />
      <QueryHistory rows={rows} showAll={all} />
    </div>
  );
}
