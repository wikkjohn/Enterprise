import { PageHeader } from "@eaop/design-system";
import { ModulesAdmin } from "@/components/admin/modules";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Modules" };

export default async function ModulesPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "module.read")) return <Forbidden permission="module.read" />;
  const platform = await getPlatform();
  const [modules, flags] = await Promise.all([platform.modules.list(viewer.ctx), platform.modules.listFlags(viewer.ctx)]);
  return (
    <div className="space-y-6">
      <PageHeader title="Modules" description="Applications built on the shared core. Enable them per organization." />
      <ModulesAdmin modules={modules} flags={flags} canManage={can(viewer, "module.manage")} />
    </div>
  );
}
