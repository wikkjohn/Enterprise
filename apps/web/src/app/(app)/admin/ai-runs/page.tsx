import { Suspense } from "react";
import { PageHeader } from "@eaop/design-system";
import { RunsTable } from "@/components/admin/ai";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI runs" };

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string; moduleId?: string }> }) {
  const viewer = await requireViewer();
  if (!can(viewer, "ai.run.read")) return <Forbidden permission="ai.run.read" />;
  const sp = await searchParams;
  const page = await (await getPlatform()).ai.listRuns(viewer.ctx, { status: sp.status, cursor: sp.cursor, moduleId: sp.moduleId, limit: 50 });
  return (
    <div className="space-y-6">
      <PageHeader title="AI runs" description="Every model call: who, which model, policy decision, tokens, latency and estimated cost. Prompt content is kept only per your retention setting." />
      <Suspense>
        <RunsTable runs={page.data} nextCursor={page.nextCursor} />
      </Suspense>
    </div>
  );
}
