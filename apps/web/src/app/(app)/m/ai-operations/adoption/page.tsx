import { PageHeader } from "@eaop/design-system";
import { AdoptionView } from "@/components/ai-ops/people";
import { Forbidden } from "@/components/forbidden";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Adoption" };

export default async function AdoptionPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "ai_ops.adoption.read")) return <Forbidden permission="ai_ops.adoption.read" />;
  const a = await ops(await getPlatform()).adoption(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="AI adoption" description="Operational adoption by department and use case — not individual productivity." />
      <AdoptionView a={a} />
    </div>
  );
}
