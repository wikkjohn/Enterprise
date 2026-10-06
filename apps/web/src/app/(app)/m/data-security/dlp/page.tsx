import { PageHeader } from "@eaop/design-system";
import { DetectionTester, DlpEvents } from "@/components/data-security/dlp";
import { Forbidden } from "@/components/forbidden";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "AI DLP" };

export default async function DlpPage({ searchParams }: { searchParams: Promise<{ focus?: string; decision?: string; approval?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  if (!can(viewer, "data_security.incident.read")) return <Forbidden permission="data_security.incident.read" />;
  const events = await ds(await getPlatform()).listDlpEvents(viewer.ctx, { limit: 500 });
  return (
    <div className="space-y-6">
      <PageHeader title="AI DLP" description="Every request to the platform's AI layer — and every check from external enforcement points — is evaluated: allow, redact, require approval or block." />
      <DlpEvents events={events} focus={sp.focus} initial={{ decision: sp.decision, approval: sp.approval }} canDecide={can(viewer, "data_security.policy.manage")} viewerId={viewer.user.id} />
      <DetectionTester />
    </div>
  );
}
