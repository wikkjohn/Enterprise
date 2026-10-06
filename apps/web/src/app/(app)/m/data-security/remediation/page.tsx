import { PageHeader } from "@eaop/design-system";
import { RemediationList } from "@/components/data-security/remediation";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Remediation" };

export default async function RemediationPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const items = await ds(platform).listRemediation(viewer.ctx);
  const members = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [{ userId: viewer.user.id, name: viewer.user.name }];
  return (
    <div className="space-y-6">
      <PageHeader title="Remediation" description="Recommended fixes for findings and incidents. Owner, classification and AI-destination changes are applied by the platform; permission changes in source systems are never automated." />
      <RemediationList items={items} focus={focus} canManage={can(viewer, "data_security.remediation.manage")} members={members} />
    </div>
  );
}
