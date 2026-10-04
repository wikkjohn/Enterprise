import { PageHeader } from "@eaop/design-system";
import { ProvidersAdmin } from "@/components/admin/ai";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI providers" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "ai.provider.read")) return <Forbidden permission="ai.provider.read" />;
  const providers = await (await getPlatform()).ai.listProviders(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="AI providers" description="Every module calls models through this shared provider layer. Routing respects data classification and organization policies." />
      <ProvidersAdmin providers={providers} canManage={can(viewer, "ai.provider.manage")} />
    </div>
  );
}
