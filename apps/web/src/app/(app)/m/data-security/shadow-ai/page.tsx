import { PageHeader } from "@eaop/design-system";
import { ShadowAi } from "@/components/data-security/shadow";
import { Forbidden } from "@/components/forbidden";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Shadow AI" };

export default async function ShadowAiPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "data_security.shadow_ai.read")) return <Forbidden permission="data_security.shadow_ai.read" />;
  const data = await ds(await getPlatform()).listTools(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Shadow AI" description="AI tools and services in use, from telemetry integrations and DLP checks — with who uses them, which data they see, and whether they are approved." />
      <ShadowAi data={data} canManage={can(viewer, "data_security.policy.manage")} />
    </div>
  );
}
