import { PageHeader } from "@eaop/design-system";
import { KnowledgeSettings } from "@/components/knowledge/insights";
import { Forbidden } from "@/components/forbidden";
import { kv } from "@/lib/knowledge";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Settings" };

export default async function KnowledgeSettingsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "knowledge.admin")) return <Forbidden permission="knowledge.admin" />;
  const platform = await getPlatform();
  const svc = kv(platform);
  const [s, indexes] = [await svc.getSettings(viewer.ctx), await svc.listIndexes(viewer.ctx)];
  const members = can(viewer, "user.read") ? (await platform.organizations.listMembers(viewer.ctx, { status: "active" })).map((m) => ({ userId: m.userId, name: m.name })) : [];
  return (
    <div className="space-y-6">
      <PageHeader title="Knowledge settings" description="Freshness rules, question retention, expert escalation and the search index." />
      <KnowledgeSettings s={s} indexes={indexes} members={members} />
    </div>
  );
}
