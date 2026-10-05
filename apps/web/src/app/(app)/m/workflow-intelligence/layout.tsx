import { type ReactNode } from "react";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { Forbidden } from "@/components/forbidden";
import { WiNav } from "@/components/workflow/common";
import { can, requireViewer } from "@/lib/viewer";
import { WI_BASE } from "@/lib/workflow";

export const metadata = { title: { template: "%s · Workflow Intelligence", default: "Workflow Intelligence" } };

/** Module shell: entitlement + entry permission, then the module's own sub-navigation. Every service call re-checks both. */
export default async function WorkflowIntelligenceLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const nav = viewer.navigation.find((m) => m.id === "workflow_intelligence");
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Workflow Intelligence" description="Find, score and redesign the workflows where AI creates measurable value, and track realized ROI." />
        <NotInstalledState
          moduleName="AI Workflow Intelligence"
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path="/modules/workflow_intelligence/enable" success="Workflow Intelligence enabled">Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  if (!can(viewer, "workflow.read")) return <Forbidden permission="workflow.read" />;
  const items = nav.items.length ? nav.items : [{ label: "Dashboard", href: WI_BASE }];
  return (
    <div className="space-y-6">
      <WiNav items={items.map((i) => ({ label: i.label, href: i.href.replace(/\/$/, "") || WI_BASE }))} />
      {children}
    </div>
  );
}
