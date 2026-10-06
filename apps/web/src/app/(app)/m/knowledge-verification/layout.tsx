import { type ReactNode } from "react";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { Forbidden } from "@/components/forbidden";
import { KvNav } from "@/components/knowledge/common";
import { KV_BASE } from "@/lib/knowledge";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: { template: "%s · Knowledge", default: "AI Knowledge & Verification" } };

/** Module shell: entitlement + entry permission, then sub-navigation. Every service call re-checks both. */
export default async function KnowledgeLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const nav = viewer.navigation.find((m) => m.id === "knowledge_verification");
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Knowledge & Verification" description="Trusted, permission-aware enterprise knowledge with citations, claim verification and confidence." />
        <NotInstalledState
          moduleName="AI Knowledge & Verification"
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path="/modules/knowledge_verification/enable" success="Knowledge & Verification enabled">Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  if (!can(viewer, "knowledge.read")) return <Forbidden permission="knowledge.read" />;
  return (
    <div className="space-y-6">
      <KvNav items={nav.items.map((i) => ({ label: i.label, href: i.href.replace(/\/$/, "") || KV_BASE }))} />
      {children}
    </div>
  );
}
