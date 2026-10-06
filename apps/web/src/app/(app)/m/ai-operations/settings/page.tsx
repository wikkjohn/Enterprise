import { PageHeader } from "@eaop/design-system";
import { OpsSettingsForm } from "@/components/ai-ops/coe";
import { Forbidden } from "@/components/forbidden";
import { ops } from "@/lib/ai-operations";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Settings" };

export default async function OpsSettingsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "ai_ops.admin")) return <Forbidden permission="ai_ops.admin" />;
  const s = await ops(await getPlatform()).getSettings(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="AI Operations settings" description="Fiscal year, alert windows, optimization thresholds and the privacy floor for adoption reporting." />
      <OpsSettingsForm s={s} />
    </div>
  );
}
