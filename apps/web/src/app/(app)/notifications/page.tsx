import { PageHeader } from "@eaop/design-system";
import { NotificationsList } from "@/components/account";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";

export const metadata = { title: "Notifications" };

export default async function Page() {
  const viewer = await requireViewer();
  const p = await getPlatform();
  const [items, prefs] = await Promise.all([p.notifications.listMine(viewer.ctx, { limit: 100 }), p.notifications.preferences(viewer.ctx)]);
  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" />
      <NotificationsList items={items.data} prefs={prefs} />
    </div>
  );
}
