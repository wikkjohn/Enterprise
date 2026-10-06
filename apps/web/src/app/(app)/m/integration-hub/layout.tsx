import { type ReactNode } from "react";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { Forbidden } from "@/components/forbidden";
import { IhNav } from "@/components/integration/common";
import { IH_BASE } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: { template: "%s · Integration", default: "Enterprise AI Integration" } };

/** Module shell: entitlement + entry permission, then sub-navigation. Every service call re-checks both. */
export default async function IntegrationLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const nav = viewer.navigation.find((m) => m.id === "integration_hub");
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title="Enterprise AI Integration" description="Controlled execution layer connecting AI and agents to enterprise systems under policy and approval." />
        <NotInstalledState
          moduleName="Enterprise AI Integration"
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path="/modules/integration_hub/enable" success="Integration enabled">Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  if (!can(viewer, "integration.read")) return <Forbidden permission="integration.read" />;
  return (
    <div className="space-y-6">
      <IhNav items={nav.items.map((i) => ({ label: i.label, href: i.href.replace(/\/$/, "") || IH_BASE }))} />
      {children}
    </div>
  );
}
