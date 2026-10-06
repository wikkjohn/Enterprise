import { PageHeader } from "@eaop/design-system";
import { SecurityDashboard } from "@/components/data-security/dashboard";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Dashboard" };

export default async function DataSecurityDashboardPage() {
  const viewer = await requireViewer();
  const d = await ds(await getPlatform()).dashboard(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="AI Data Security" description="Can this company's data safely be used with AI? Sensitive data, who can reach it, which AI it reaches, and what was stopped." />
      <SecurityDashboard d={d} canShadow={can(viewer, "data_security.shadow_ai.read")} />
    </div>
  );
}
