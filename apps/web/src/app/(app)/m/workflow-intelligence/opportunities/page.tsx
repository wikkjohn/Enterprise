import { PageHeader } from "@eaop/design-system";
import { DataClassToggle, SampleBanner } from "@/components/workflow/common";
import { OpportunityPortfolio } from "@/components/workflow/portfolio";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";
import { wi } from "@/lib/workflow";

export const metadata = { title: "Opportunities" };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ data?: string; focus?: string }> }) {
  const sp = await searchParams;
  const dataClass = sp.data === "sample" ? "sample" : "production";
  const viewer = await requireViewer();
  const opportunities = await wi(await getPlatform()).listOpportunities(viewer.ctx, { dataClass });
  return (
    <div className="space-y-6">
      <PageHeader title="Opportunity portfolio" description="Every analyzed workflow ranked by value, complexity, risk and return — decide what to build next." actions={<DataClassToggle value={dataClass} />} />
      {dataClass === "sample" && <SampleBanner />}
      <OpportunityPortfolio
        opportunities={opportunities}
        dataClass={dataClass}
        focus={sp.focus}
        viewerId={viewer.user.id}
        perms={{ approve: can(viewer, "workflow.approve"), implement: can(viewer, "workflow.implementation.manage") }}
      />
    </div>
  );
}
