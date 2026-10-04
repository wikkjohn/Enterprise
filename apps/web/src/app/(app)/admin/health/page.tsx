import { Card, CardBody, CardHeader, PageHeader, StatusBadge } from "@eaop/design-system";
import { FailedJobsTable, RecentErrorsTable } from "@/components/admin/health-tables";
import { Forbidden } from "@/components/forbidden";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "System health" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const viewer = await requireViewer();
  if (!can(viewer, "observability.read")) return <Forbidden permission="observability.read" />;
  const r = await (await getPlatform()).health.report(viewer.ctx);
  return (
    <div className="space-y-6">
      <PageHeader title="System health" description={`Generated ${new Date(r.generatedAt).toLocaleString()}`} meta={<StatusBadge status={r.overall} />} />
      <div className="grid gap-4 md:grid-cols-3">
        {r.services.map((s) => (
          <Card key={s.name}><CardHeader title={s.name.replace("_", " ")} actions={<StatusBadge status={s.state} />} /><CardBody className="text-sm text-muted">{s.message ?? (s.latencyMs !== undefined ? `${s.latencyMs} ms` : "—")}</CardBody></Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connectors" description={`${r.connectors.total} configured`} />
          <CardBody className="space-y-2 text-sm">
            <p>{Object.entries(r.connectors.byHealth).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No connectors."}</p>
            {r.connectors.failing.map((c) => <p key={c.id}><a className="text-accent" href={`/admin/connectors/${c.id}`}>{c.name}</a> <span className="text-muted">— {c.lastError}</span></p>)}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="AI providers" />
          <CardBody>
            <ul className="space-y-1 text-sm">{r.aiProviders.map((a) => <li key={a.key} className="flex justify-between"><span>{a.key} <span className="text-muted">({a.kind}{a.implemented ? "" : ", adapter not available"})</span></span><StatusBadge status={a.status} /></li>)}</ul>
          </CardBody>
        </Card>
        {r.queue && (
          <Card>
            <CardHeader title="Job queue" description="Platform-wide (platform administrators only)" />
            <CardBody className="text-sm">{Object.entries(r.queue.byStatus).map(([k, v]) => `${k}: ${v}`).join(" · ") || "Empty"}{r.queue.oldestQueuedSeconds ? ` · oldest due job waiting ${r.queue.oldestQueuedSeconds}s` : ""}</CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="Modules" />
          <CardBody><ul className="space-y-1 text-sm">{r.modules.map((m) => <li key={m.moduleId} className="flex justify-between"><span>{m.moduleId}</span><StatusBadge status={m.state} /></li>)}</ul></CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Failed background jobs" />
        <CardBody flush>
          <FailedJobsTable jobs={r.failedJobs} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Recent errors (7 days)" description="Messages are redacted. Use the correlation id to find the request in logs." />
        <CardBody flush>
          <RecentErrorsTable errors={r.recentErrors} />
        </CardBody>
      </Card>
    </div>
  );
}
