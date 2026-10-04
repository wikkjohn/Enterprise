"use client";

import { Card, CardBody, CardFooter, CardHeader, StatusBadge, Switch } from "@eaop/design-system";
import { type OrgModuleView } from "@eaop/module-registry";
import { apiFetch } from "@/lib/client";
import { ActionButton, useMutation } from "@/components/actions";

export function ModulesAdmin({ modules, flags, canManage }: { modules: OrgModuleView[]; flags: Array<{ key: string; description: string; enabled: boolean; source: string }>; canManage: boolean }) {
  const { run } = useMutation();
  return (
    <div className="space-y-8">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {modules.map((m) => (
          <Card key={m.id}>
            <CardHeader title={m.name} actions={<StatusBadge status={m.installStatus === "not_installed" ? "not_installed" : m.enabled ? "enabled" : "disabled"} />} />
            <CardBody className="space-y-2 text-sm text-muted">
              <p>{m.description}</p>
              {m.dependsOn.length > 0 && <p>Requires: {m.dependsOn.join(", ")}</p>}
              <p>{m.permissions.length} permissions reserved</p>
            </CardBody>
            {canManage && m.installStatus === "installed" && (
              <CardFooter>
                {m.enabled ? (
                  <ActionButton size="sm" variant="secondary" path={`/modules/${m.id}/disable`} success={`${m.name} disabled`} confirm={{ title: `Disable ${m.name}?`, message: "Users lose access to this module immediately. Its data is retained." }}>Disable</ActionButton>
                ) : (
                  <ActionButton size="sm" path={`/modules/${m.id}/enable`} success={`${m.name} enabled`}>Enable</ActionButton>
                )}
              </CardFooter>
            )}
          </Card>
        ))}
      </div>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Feature flags</h2>
        {flags.length === 0 ? <p className="text-sm text-muted">No feature flags are registered yet. Modules declare them in their manifest.</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {flags.map((f) => (
              <li key={f.key} className="px-4 py-3">
                <Switch checked={f.enabled} disabled={!canManage} label={<span className="font-mono text-sm">{f.key}</span>} description={`${f.description} · ${f.source}`} onCheckedChange={(v) => void run(() => apiFetch(`/feature-flags/${encodeURIComponent(f.key)}`, { method: "PUT", body: { enabled: v } }), { success: "Flag updated" })} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
