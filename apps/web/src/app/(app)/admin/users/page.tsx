import { PageHeader } from "@eaop/design-system";
import { UsersAdmin } from "@/components/admin/users";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "user.read")) return <Forbidden permission="user.read" />;
  const platform = await getPlatform();
  const [members, invitations, roles] = await Promise.all([
    platform.organizations.listMembers(viewer.ctx),
    platform.organizations.listInvitations(viewer.ctx),
    can(viewer, "role.read") ? platform.rbac.roles.listRoles(viewer.ctx) : Promise.resolve([]),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Members of this organization, their roles and status." />
      <UsersAdmin
        members={members}
        invitations={invitations}
        roles={roles.map((r) => ({ key: r.key, name: r.name }))}
        canInvite={can(viewer, "user.invite")}
        canManage={can(viewer, "user.manage")}
        canAssign={can(viewer, "role.manage")}
        selfId={viewer.user.id}
      />
    </div>
  );
}
