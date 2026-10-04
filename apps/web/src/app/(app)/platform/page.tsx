import { randomUUID } from "node:crypto";
import { PageHeader } from "@eaop/design-system";
import { Forbidden } from "@/components/forbidden";
import { PlatformOrganizations } from "@/components/platform-admin";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";

export const metadata = { title: "Platform" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!viewer.user.isPlatformAdmin) return <Forbidden permission="platform.admin" />;
  const orgs = await (await getPlatform()).organizations.listAll({ actor: viewer.ctx.actor, correlationId: randomUUID() });
  return (
    <div className="space-y-6">
      <PageHeader title="Platform organizations" description="Tenant provisioning and lifecycle. Platform administrators do not get access to tenant data by default." />
      <PlatformOrganizations orgs={orgs} />
    </div>
  );
}
