import { PageHeader } from "@eaop/design-system";
import { SecuritySettings } from "@/components/admin/settings";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Security" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "org.security.read")) return <Forbidden permission="org.security.read" />;
  const p = await getPlatform();
  const [settings, idps] = await Promise.all([p.organizations.settings(viewer.ctx), p.sso.list(viewer.ctx)]);
  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="Authentication policy, data retention and single sign-on." />
      <SecuritySettings security={settings.security} retention={settings.dataRetention} idps={idps} canManage={can(viewer, "org.security.manage")} />
    </div>
  );
}
