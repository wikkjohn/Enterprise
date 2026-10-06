import { notFound } from "next/navigation";
import { Breadcrumbs, PageHeader } from "@eaop/design-system";
import { isAppError } from "@eaop/shared-types";
import { SessionPlayer } from "@/components/agents/governance";
import { Forbidden } from "@/components/forbidden";
import { AG_BASE, ag } from "@/lib/agent-governance";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Session replay" };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  if (!can(viewer, "agent.audit.read")) return <Forbidden permission="agent.audit.read" />;
  const session = await ag(await getPlatform()).getSession(viewer.ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  return (
    <div className="space-y-6">
      <PageHeader title={`Session replay — ${session.agentName}`} breadcrumbs={<Breadcrumbs items={[{ label: "Activity & replay", href: `${AG_BASE}/activity` }, { label: "Session" }]} />} />
      <SessionPlayer session={session} />
    </div>
  );
}
