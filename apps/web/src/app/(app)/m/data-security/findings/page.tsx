import { PageHeader } from "@eaop/design-system";
import { FindingsView } from "@/components/data-security/findings";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";

export const metadata = { title: "Findings" };

export default async function FindingsPage() {
  const viewer = await requireViewer();
  const findings = await ds(await getPlatform()).listFindings(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="Findings" description="Permission exposure (public links, org-wide sharing, broad groups, departed and stale users, inherited access) and AI exposure, ranked by severity." />
      <FindingsView findings={findings} />
    </div>
  );
}
