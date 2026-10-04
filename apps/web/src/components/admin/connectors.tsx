"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, Drawer, FilterBar, FormField, Input, KeyValueList, Select, StatusBadge, Textarea, type DataTableColumn,
} from "@eaop/design-system";
import { type ConnectorView } from "@eaop/connectors";
import { apiFetch } from "@/lib/client";
import { ActionButton, useMutation } from "@/components/actions";

export interface CatalogEntry {
  type: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  availability: "available" | "contract_only" | "sandbox";
  authTypes: string[];
  capabilities: Array<{ key: string; description: string; operations: string[]; risk: string }>;
  configFields: Array<{ key: string; label: string; type: string; required?: boolean; placeholder?: string; help?: string; options?: string[] }>;
  credentialFields: Record<string, Array<{ key: string; label: string; secret: boolean; required?: boolean }> | undefined>;
}

const AVAILABILITY_LABEL = { available: "Available", contract_only: "Adapter not yet available", sandbox: "Simulated (sandbox)" } as const;
const AVAILABILITY_TONE = { available: "success", contract_only: "neutral", sandbox: "warning" } as const;

export function ConnectorsList({ connectors, catalog, canManage }: { connectors: ConnectorView[]; catalog: CatalogEntry[]; canManage: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = connectors.filter((c) => !q || `${c.name} ${c.type}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Array<DataTableColumn<ConnectorView>> = [
    { key: "name", header: "Name", sortable: true, sortValue: (c) => c.name, cell: (c) => <span className="font-medium">{c.name}</span> },
    { key: "type", header: "System", sortable: true, sortValue: (c) => c.type, cell: (c) => catalog.find((d) => d.type === c.type)?.name ?? c.type },
    { key: "status", header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
    { key: "health", header: "Health", cell: (c) => <StatusBadge status={c.healthStatus} /> },
    { key: "cred", header: "Credential", hideOnMobile: true, cell: (c) => (c.credential ? <span className="font-mono text-xs">{c.credential.hint ?? c.credential.kind}</span> : <span className="text-muted">None</span>) },
    { key: "checked", header: "Last check", hideOnMobile: true, cell: (c) => (c.lastHealthCheckAt ? new Date(c.lastHealthCheckAt).toLocaleString() : "—") },
  ];
  return (
    <div className="space-y-4">
      <FilterBar onSearchChange={setQ} searchPlaceholder="Search connectors" actions={canManage ? <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Add connector</Button> : undefined} />
      <DataTable columns={columns} rows={rows} getRowId={(c) => c.id} onRowClick={(c) => router.push(`/admin/connectors/${c.id}`)} rowLabel={(c) => `Open ${c.name}`} caption="Connectors" emptyState={<p className="p-6 text-center text-sm text-muted">No connectors yet. Connectors configured here are shared by every module.</p>} />
      {creating && <CreateConnector catalog={catalog} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateConnector({ catalog, onClose }: { catalog: CatalogEntry[]; onClose: () => void }) {
  const router = useRouter();
  const [type, setType] = useState<string | null>(null);
  const def = catalog.find((d) => d.type === type);
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const { run, pending } = useMutation();
  const groups = useMemo(() => {
    const g = new Map<string, CatalogEntry[]>();
    for (const d of catalog) g.set(d.category, [...(g.get(d.category) ?? []), d]);
    return [...g.entries()];
  }, [catalog]);

  async function create() {
    if (!def) return;
    const cfg: Record<string, unknown> = {};
    for (const f of def.configFields) if (config[f.key]) cfg[f.key] = f.type === "number" ? Number(config[f.key]) : config[f.key];
    const c = await run(() => apiFetch<ConnectorView>("/connectors", { body: { type: def.type, name, authType: authType || def.authTypes[0], config: cfg } }), { success: "Connector created", refresh: false });
    if (c) router.push(`/admin/connectors/${c.id}`);
  }

  return (
    <Drawer open onClose={onClose} width="lg" title={def ? `New ${def.name} connector` : "Add connector"} description="Credentials are added after creation and stored in the secret store, never in the database."
      footer={def ? <><Button variant="secondary" onClick={() => setType(null)}>Back</Button><Button loading={pending} disabled={!name} onClick={create}>Create connector</Button></> : undefined}>
      {!def ? (
        <div className="space-y-6">
          {groups.map(([cat, defs]) => (
            <section key={cat} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{cat}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {defs.map((d) => (
                  <button key={d.type} type="button" onClick={() => { setType(d.type); setAuthType(d.authTypes[0] ?? "none"); setName(d.name); }} className="ds-ring rounded-md border border-border p-3 text-left hover:border-border-strong">
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">{d.name}</span><Badge tone={AVAILABILITY_TONE[d.availability]}>{AVAILABILITY_LABEL[d.availability]}</Badge></div>
                    <p className="mt-1 text-xs text-muted">{d.description}</p>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {def.availability !== "available" && (
            <p className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm">
              {def.availability === "sandbox" ? "This connector is simulated and never contacts a real system." : "The adapter for this system is not available yet. You can save its configuration now; testing and execution will work once the adapter ships."}
            </p>
          )}
          <FormField id="c-name" label="Name" required>{(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
          <FormField id="c-auth" label="Authentication">{(a) => <Select {...a} value={authType} onChange={(e) => setAuthType(e.target.value)} options={def.authTypes.map((t) => ({ value: t, label: t.replace("_", " ") }))} />}</FormField>
          {def.configFields.map((f) => (
            <FormField key={f.key} id={`c-${f.key}`} label={f.label} required={f.required} hint={f.help}>
              {(a) => f.type === "select" ? <Select {...a} value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} placeholder="Select…" options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />
                : f.type === "textarea" ? <Textarea {...a} value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
                : <Input {...a} type={f.type === "number" ? "number" : f.type === "url" ? "url" : "text"} placeholder={f.placeholder} value={config[f.key] ?? ""} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />}
            </FormField>
          ))}
          <div>
            <h3 className="mb-1 text-sm font-semibold">Capabilities</h3>
            <ul className="space-y-1 text-sm">{def.capabilities.map((c) => <li key={c.key}><code className="font-mono text-xs">{c.key}</code> <span className="text-muted">— {c.description} ({c.operations.join(", ")})</span></li>)}</ul>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function ConnectorDetail({ connector, def, canManage, canManageCreds }: { connector: ConnectorView; def: CatalogEntry | undefined; canManage: boolean; canManageCreds: boolean }) {
  const router = useRouter();
  const fields = def?.credentialFields[connector.authType] ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [expiresAt, setExpiresAt] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
  const { run, pending } = useMutation();

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader title="Overview" actions={canManage ? (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" loading={pending} onClick={async () => setTestResult((await run(() => apiFetch<{ ok: boolean; message: string; latencyMs?: number }>(`/connectors/${connector.id}/test`, { method: "POST" }))) ?? null)}>Test connection</Button>
              <ActionButton size="sm" variant="danger" path={`/connectors/${connector.id}`} method="DELETE" success="Connector deleted" confirm={{ title: `Delete ${connector.name}?`, message: "Its credentials are destroyed and modules using it will stop working.", requireText: connector.name }} onClickCapture={() => setTimeout(() => router.push("/admin/connectors"), 800)}>Delete</ActionButton>
            </div>
          ) : undefined} />
          <CardBody className="space-y-4">
            {testResult && <p role="status" className={`rounded-md px-3 py-2 text-sm ${testResult.ok ? "bg-success-subtle text-success" : "bg-danger-subtle text-danger"}`}>{testResult.message}{testResult.latencyMs !== undefined ? ` (${testResult.latencyMs} ms)` : ""}</p>}
            <KeyValueList columns={2} items={[
              { key: "type", label: "System", value: def?.name ?? connector.type },
              { key: "avail", label: "Adapter", value: def ? AVAILABILITY_LABEL[def.availability] : "Unknown" },
              { key: "status", label: "Status", value: <StatusBadge status={connector.status} /> },
              { key: "health", label: "Health", value: <StatusBadge status={connector.healthStatus} /> },
              { key: "auth", label: "Authentication", value: connector.authType },
              { key: "last", label: "Last check", value: connector.lastHealthCheckAt ? new Date(connector.lastHealthCheckAt).toLocaleString() : "Never" },
              ...(connector.lastError ? [{ key: "err", label: "Last error", value: <span className="text-danger">{connector.lastError}</span> }] : []),
            ]} />
            <div>
              <h3 className="mb-1 text-sm font-semibold">Configuration</h3>
              <CodeBlock code={JSON.stringify(connector.config, null, 2)} language="json" />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Capabilities" description="Operations modules may execute through this connector." />
          <CardBody>
            <ul className="divide-y divide-border text-sm">
              {connector.capabilities.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-3 py-2">
                  <span><code className="font-mono text-xs">{c.key}</code> <span className="text-muted">{c.operations.join(", ")}</span></span>
                  <StatusBadge status={c.enabled ? "enabled" : "disabled"} />
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Credential" description="Stored in the secret store. Only a reference and a hint are kept here." />
        <CardBody className="space-y-4">
          {connector.credential ? (
            <KeyValueList items={[
              { key: "hint", label: "Hint", value: <span className="font-mono">{connector.credential.hint ?? "—"}</span> },
              { key: "rot", label: "Last rotated", value: connector.credential.lastRotatedAt ? new Date(connector.credential.lastRotatedAt).toLocaleString() : "—" },
              { key: "exp", label: "Expires", value: connector.credential.expiresAt ? new Date(connector.credential.expiresAt).toLocaleDateString() : "No expiry" },
            ]} />
          ) : <p className="text-sm text-muted">No credential set.</p>}
          {canManageCreds && connector.authType !== "none" && (
            <form className="space-y-3" onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => apiFetch(`/connectors/${connector.id}/credentials`, { method: "PUT", body: { values, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) } }), { success: connector.credential ? "Credential replaced" : "Credential saved" });
              if (ok) setValues({});
            }}>
              {fields.map((f) => (
                <FormField key={f.key} id={`cred-${f.key}`} label={f.label} required={f.required}>
                  {(a) => <Input {...a} type={f.secret ? "password" : "text"} autoComplete="off" value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
                </FormField>
              ))}
              <FormField id="cred-exp" label="Expires (optional)">{(a) => <Input {...a} type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}</FormField>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" loading={pending}>{connector.credential ? "Replace" : "Save credential"}</Button>
                {connector.credential && <ActionButton size="sm" variant="ghost" path={`/connectors/${connector.id}/credentials`} method="DELETE" success="Credential revoked" confirm={{ title: "Revoke credential?", message: "The secret is destroyed immediately. The connector stops working until a new credential is set." }}>Revoke</ActionButton>}
                {connector.authType === "oauth2" && def?.capabilities && <Button size="sm" variant="secondary" type="button" onClick={async () => { const r = await run(() => apiFetch<{ authorizationUrl: string }>(`/connectors/${connector.id}/oauth/start`, { method: "POST" }), { refresh: false }); if (r) window.location.assign(r.authorizationUrl); }}>Authorize via OAuth</Button>}
              </div>
            </form>
          )}
          <Link className="text-sm text-accent" href={`/admin/audit?resourceId=${connector.id}`}>View audit history</Link>
        </CardBody>
      </Card>
    </div>
  );
}
