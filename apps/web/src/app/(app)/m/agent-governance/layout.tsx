import { type ReactNode } from "react";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { AgNav } from "@/components/agents/common";
import { Forbidden } from "@/components/forbidden";
import { AG_BASE } from "@/lib/agent-governance";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: { template: "%s · Agent Governance", default: "AI Agent Governance" } };

/** Module shell: entitlement + entry permission, then sub-navigation. Every service call re-checks both. */
export default async function AgentGovernanceLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const nav = viewer.navigation.find((m) => m.id === "agent_governance");
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Agent Governance" description="Enterprise control plane for AI agents: inventory, identity, permissions, approvals, kill switch and replay." />
        <NotInstalledState
          moduleName="AI Agent Governance"
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path="/modules/agent_governance/enable" success="Agent Governance enabled">Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  if (!can(viewer, "agent.read")) return <Forbidden permission="agent.read" />;
  return (
    <div className="space-y-6">
      <AgNav items={nav.items.map((i) => ({ label: i.label, href: i.href.replace(/\/$/, "") || AG_BASE }))} />
      {children}
    </div>
  );
}
