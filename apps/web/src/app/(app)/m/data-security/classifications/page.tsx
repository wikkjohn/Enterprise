import { PageHeader } from "@eaop/design-system";
import { ClassificationsView } from "@/components/data-security/classifications";
import { ds } from "@/lib/data-security";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Classifications" };

export default async function ClassificationsPage() {
  const viewer = await requireViewer();
  const svc = ds(await getPlatform());
  const [rules, settings] = [await svc.listRules(viewer.ctx), await svc.getSettings(viewer.ctx)];
  return (
    <div className="space-y-6">
      <PageHeader title="Classifications & DLP" description="Built-in and custom classifications, what DLP does with each for approved and unapproved AI, and privacy settings." />
      <ClassificationsView rules={rules} settings={settings} canManage={can(viewer, "data_security.classification.manage")} canPolicy={can(viewer, "data_security.policy.manage")} />
    </div>
  );
}
