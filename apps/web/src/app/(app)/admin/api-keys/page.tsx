import { PageHeader } from "@eaop/design-system";
import { ApiKeysAdmin } from "@/components/admin/settings";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "API access" };
const NON_DELEGABLE = new Set(["platform.admin", "apikey.manage", "role.manage"]);

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "apikey.read")) return <Forbidden permission="apikey.read" />;
  const keys = await (await getPlatform()).apiKeys.list(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="API access" description="Organization API keys for integrations. Send as Authorization: Bearer eaop_… to /api/v1." />
      <ApiKeysAdmin keys={keys} scopes={viewer.permissions.filter((p) => !NON_DELEGABLE.has(p))} canManage={can(viewer, "apikey.manage")} />
    </div>
  );
}
