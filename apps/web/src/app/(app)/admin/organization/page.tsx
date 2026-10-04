import { PageHeader } from "@eaop/design-system";
import { OrganizationSettings } from "@/components/admin/settings";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Organization" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "org.read")) return <Forbidden permission="org.read" />;
  const p = await getPlatform();
  const [org, domains, settings] = await Promise.all([p.organizations.get(viewer.ctx), p.organizations.listDomains(viewer.ctx), p.organizations.settings(viewer.ctx)]);
  return (
    <div className="space-y-6">
      <PageHeader title="Organization" description="Profile, domains and usage limits." />
      <OrganizationSettings org={org} domains={domains} usageLimits={settings.usageLimits} canManage={can(viewer, "org.manage")} />
    </div>
  );
}
