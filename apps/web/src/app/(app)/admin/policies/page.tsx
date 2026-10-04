import { PageHeader } from "@eaop/design-system";
import { PoliciesList } from "@/components/admin/policies";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Policies" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "policy.read")) return <Forbidden permission="policy.read" />;
  const platform = await getPlatform();
  const policies = await platform.policies.list(viewer.ctx);
  const kinds = platform.policies.kinds().map((k) => ({ key: k.key, owner: k.owner, description: k.description }));
  return (
    <div className="space-y-6">
      <PageHeader title="Policies" description="Shared policy primitives. Modules such as Agent Governance and AI Data Security add their own policy kinds." />
      <PoliciesList policies={policies} kinds={kinds} canManage={can(viewer, "policy.manage")} />
    </div>
  );
}
