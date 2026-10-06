import { type ReactNode } from "react";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { DsNav } from "@/components/data-security/common";
import { Forbidden } from "@/components/forbidden";
import { DS_BASE } from "@/lib/data-security";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: { template: "%s · Data Security", default: "AI Data Security" } };

/** Module shell: entitlement + entry permission, then sub-navigation. Every service call re-checks both. */
export default async function DataSecurityLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const nav = viewer.navigation.find((m) => m.id === "data_security");
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Data Security" description="Discover, classify and protect enterprise data used with AI: exposure, shadow AI, AI DLP and incidents." />
        <NotInstalledState
          moduleName="AI Data Security"
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path="/modules/data_security/enable" success="Data Security enabled">Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  if (!can(viewer, "data_security.read")) return <Forbidden permission="data_security.read" />;
  return (
    <div className="space-y-6">
      <DsNav items={nav.items.map((i) => ({ label: i.label, href: i.href.replace(/\/$/, "") || DS_BASE }))} />
      {children}
    </div>
  );
}
