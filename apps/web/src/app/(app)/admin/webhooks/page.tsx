import { PageHeader } from "@eaop/design-system";
import { WebhooksAdmin } from "@/components/admin/settings";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Webhooks & events" };

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "notification.manage")) return <Forbidden permission="notification.manage" />;
  const p = await getPlatform();
  const hooks = await p.events.webhooks.list(viewer.ctx);
  const events = p.events.registry.list().map((c) => ({ type: c.type, owner: c.owner, description: c.description, externallyVisible: c.externallyVisible !== false }));
  return (
    <div className="space-y-6">
      <PageHeader title="Webhooks & events" description="Deliver platform events to your systems as signed HTTPS requests." />
      <WebhooksAdmin hooks={hooks} events={events} />
    </div>
  );
}
