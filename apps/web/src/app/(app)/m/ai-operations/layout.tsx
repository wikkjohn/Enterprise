import { type ReactNode } from "react";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { OpsNav } from "@/components/ai-ops/common";
import { Forbidden } from "@/components/forbidden";
import { OPS_BASE } from "@/lib/ai-operations";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: { template: "%s · AI Operations", default: "AI Operations Management" } };

/** Module shell: entitlement + entry permission, then sub-navigation. Every service call re-checks both. */
export default async function AiOpsLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const nav = viewer.navigation.find((m) => m.id === "ai_operations");
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Operations Management" description="System of record for the AI estate: tools, vendors, costs, adoption, training, requests and value." />
        <NotInstalledState
          moduleName="AI Operations Management"
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path="/modules/ai_operations/enable" success="AI Operations enabled">Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  if (!can(viewer, "ai_ops.read")) return <Forbidden permission="ai_ops.read" />;
  return (
    <div className="space-y-6">
      <OpsNav items={nav.items.map((i) => ({ label: i.label, href: i.href.replace(/\/$/, "") || OPS_BASE }))} />
      {children}
    </div>
  );
}
