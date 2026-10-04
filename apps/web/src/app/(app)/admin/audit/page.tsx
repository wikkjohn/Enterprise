import { Suspense } from "react";
import { PageHeader } from "@eaop/design-system";
import { auditQuerySchema } from "@eaop/audit";
import { AuditLog } from "@/components/admin/audit";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Audit log" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const viewer = await requireViewer();
  if (!can(viewer, "audit.read")) return <Forbidden permission="audit.read" />;
  const parsed = auditQuerySchema.safeParse({ ...(await searchParams), limit: 50 });
  const page = await (await getPlatform()).audit.query(viewer.ctx, parsed.success ? parsed.data : { limit: 50 });
  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" description="Append-only record of security-relevant and administrative actions. It cannot be edited or deleted by any user." />
      <Suspense>
        <AuditLog events={page.data} nextCursor={page.nextCursor} canExport={can(viewer, "audit.export")} />
      </Suspense>
    </div>
  );
}
