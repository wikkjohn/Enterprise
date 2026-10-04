import { KeyValueList, PageHeader } from "@eaop/design-system";
import { ProfileSecurity } from "@/components/account";
import { getPlatform } from "@/lib/platform";
import { requireViewer } from "@/lib/viewer";

export const metadata = { title: "Profile & security" };

export default async function Page() {
  const viewer = await requireViewer();
  const sessions = await (await getPlatform()).auth.listSessions(viewer.user.id);
  return (
    <div className="space-y-6">
      <PageHeader title="Profile & security" />
      <KeyValueList columns={2} items={[{ key: "n", label: "Name", value: viewer.user.name }, { key: "e", label: "Email", value: viewer.user.email }, { key: "o", label: "Organization", value: viewer.organization.name }, { key: "r", label: "Permissions", value: `${viewer.permissions.length} granted` }]} />
      <ProfileSecurity
        mfaEnabled={viewer.user.mfaEnabled}
        sessions={sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), current: s.id === viewer.ctx.sessionId }))}
      />
    </div>
  );
}
