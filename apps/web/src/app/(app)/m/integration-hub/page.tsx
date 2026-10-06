import { PageHeader } from "@eaop/design-system";
import { IntegrationOverview } from "@/components/integration/overview";
import { getPlatform } from "@/lib/platform";
import { ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const viewer = await requireViewer();
  const svc = ih(await getPlatform());
  const history = can(viewer, "integration.history.read");
  const [overview, approvals, recent] = await Promise.all([
    svc.overview(viewer.ctx),
    svc.listApprovals(viewer.ctx, { status: "pending" }),
    history ? svc.listExecutions(viewer.ctx, { limit: 10 }) : Promise.resolve({ data: [], nextCursor: null }),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title="Enterprise AI Integration" description="AI and agents act on enterprise systems only through validated, permissioned, policy-checked and audited actions." />
      <IntegrationOverview overview={overview} approvals={approvals.slice(0, 5)} recent={recent.data} canHistory={history} canManage={can(viewer, "integration.manage") && can(viewer, "integration.create")} />
    </div>
  );
}
