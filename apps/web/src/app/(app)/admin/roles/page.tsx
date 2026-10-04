import { PageHeader } from "@eaop/design-system";
import { RolesAdmin } from "@/components/admin/roles";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Roles & permissions" };

export default async function RolesPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "role.read")) return <Forbidden permission="role.read" />;
  const platform = await getPlatform();
  const roles = await platform.rbac.roles.listRoles(viewer.ctx);
  const permissions = platform.rbac.registry.list().filter((p) => p.key !== "platform.admin");
  return (
    <div className="space-y-6">
      <PageHeader title="Roles & permissions" description="System roles are managed by the platform. Custom roles are specific to this organization." />
      <RolesAdmin roles={roles} permissions={permissions} canManage={can(viewer, "role.manage")} />
    </div>
  );
}
