import Link from "next/link";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@eaop/design-system";
import { ADMIN_NAV } from "@/lib/admin-nav";
import { requireViewer } from "@/lib/viewer";

export const metadata = { title: "Administration" };

export default async function AdminHome() {
  const viewer = await requireViewer();
  const items = ADMIN_NAV.filter((i) => viewer.permissions.includes(i.permission));
  return (
    <div className="space-y-6">
      <PageHeader title="Administration" description="Shared platform settings used by every module." />
      {items.length === 0 ? (
        <EmptyState title="No administrative access" description="Your role does not include any administrative permissions." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((i) => (
            <Link key={i.href} href={i.href} className="ds-ring rounded-lg">
              <Card className="h-full transition-colors hover:border-border-strong">
                <CardHeader title={<span className="flex items-center gap-2"><i.icon className="size-4 text-muted" aria-hidden />{i.label}</span>} />
                <CardBody className="text-sm text-muted">Requires {i.permission}</CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
