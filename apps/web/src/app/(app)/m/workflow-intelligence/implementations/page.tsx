import { PageHeader } from "@eaop/design-system";
import { DataClassToggle, SampleBanner } from "@/components/workflow/common";
import { ImplementationList } from "@/components/workflow/implementations";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";
import { wi } from "@/lib/workflow";

export const metadata = { title: "Implementations" };

export default async function ImplementationsPage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const dataClass = (await searchParams).data === "sample" ? "sample" : "production";
  const viewer = await requireViewer();
  const implementations = await wi(await getPlatform()).listImplementations(viewer.ctx, { dataClass });
  return (
    <div className="space-y-6">
      <PageHeader title="Implementations" description="Approved opportunities from proposal to measured production value." actions={<DataClassToggle value={dataClass} />} />
      {dataClass === "sample" && <SampleBanner />}
      <ImplementationList implementations={implementations} dataClass={dataClass} />
    </div>
  );
}
