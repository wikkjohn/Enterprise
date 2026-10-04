import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, StatCard, StatusBadge, buttonClasses } from "@eaop/design-system";
import { getPlatform } from "@/lib/platform";
import { requireViewer, can } from "@/lib/viewer";

export const metadata = { title: "Home" };

export default async function HomePage() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const [notes, audit, connectors, usage] = await Promise.all([
    platform.notifications.listMine(viewer.ctx, { limit: 5 }),
    can(viewer, "audit.read") ? platform.audit.query(viewer.ctx, { limit: 8 }) : null,
    can(viewer, "connector.read") ? platform.connectors.list(viewer.ctx) : null,
    can(viewer, "usage.read")
      ? platform.usage.summary(viewer.ctx, { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() + 60_000), groupBy: "metric" })
      : null,
  ]);
  const metric = (k: string) => usage?.find((u) => u.metric === k)?.quantity ?? 0;
  const enabled = viewer.navigation.filter((m) => m.state === "enabled");

  return (
    <div className="space-y-8">
      <PageHeader title={`Welcome, ${viewer.user.name.split(" ")[0]}`} description={`${viewer.organization.name} · ${viewer.organization.environment}`} />

      {usage && (
        <section aria-label="Last 30 days" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="AI runs (30 days)" value={metric("ai.runs").toLocaleString()} />
          <StatCard label="AI tokens (30 days)" value={(metric("ai.input_tokens") + metric("ai.output_tokens")).toLocaleString()} />
          <StatCard label="Estimated AI cost (30 days)" value={`$${metric("ai.cost").toFixed(2)}`} hint="Estimated from configured model prices" />
          <StatCard label="Connector actions (30 days)" value={metric("connector.actions").toLocaleString()} />
        </section>
      )}

      <section aria-labelledby="apps-h" className="space-y-3">
        <h2 id="apps-h" className="text-sm font-semibold text-muted">Applications</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {viewer.navigation.map((m) => (
            <Card key={m.id}>
              <CardHeader
                title={m.name}
                actions={<StatusBadge status={m.state} />}
              />
              <CardBody>
                <Link href={m.basePath} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                  {m.state === "enabled" ? "Open" : "Details"} <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </CardBody>
            </Card>
          ))}
        </div>
        {enabled.length === 0 && (
          <p className="text-sm text-muted">
            No modules are enabled for this organization yet. The shared core (identity, RBAC, connectors, AI providers, policies, audit) is fully available.
          </p>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Notifications" actions={<Link className="text-sm text-accent" href="/notifications">View all</Link>} />
          <CardBody>
            {notes.data.length === 0 ? (
              <EmptyState compact title="You're all caught up" />
            ) : (
              <ul className="divide-y divide-border">
                {notes.data.map((n) => (
                  <li key={n.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                    <span className={n.readAt ? "text-muted" : "font-medium"}>{n.title}</span>
                    <Badge tone={n.priority === "critical" ? "danger" : n.priority === "high" ? "warning" : "neutral"}>{n.priority}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        {audit && (
          <Card>
            <CardHeader title="Recent activity" actions={<Link className="text-sm text-accent" href="/admin/audit">Audit log</Link>} />
            <CardBody>
              <ul className="divide-y divide-border">
                {audit.data.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{e.actorLabel}</span> <span className="text-muted">{e.action}</span>
                    </span>
                    <time className="shrink-0 text-xs text-subtle" dateTime={e.occurredAt}>
                      {new Date(e.occurredAt).toLocaleString()}
                    </time>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
        {connectors && connectors.some((c) => c.healthStatus === "unhealthy") && (
          <Card>
            <CardHeader title="Connectors needing attention" />
            <CardBody>
              <ul className="space-y-2 text-sm">
                {connectors
                  .filter((c) => c.healthStatus === "unhealthy")
                  .map((c) => (
                    <li key={c.id}>
                      <Link className="text-accent" href={`/admin/connectors/${c.id}`}>
                        {c.name}
                      </Link>{" "}
                      <span className="text-muted">— {c.lastError}</span>
                    </li>
                  ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
