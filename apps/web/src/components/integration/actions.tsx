"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bot, Plus, Wrench } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, CodeBlock, DataTable, Drawer, FilterBar, FormField, Input, KeyValueList, Select, TabPanel, Tabs, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type ActionView } from "@eaop/module-integration-hub";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { IH, JsonField, RiskBadge, StatusPill } from "./common";
import { MappingEditor } from "./editor";

export interface TemplateView {
  key: string;
  connectorType: string;
  connectorName: string;
  availability: string;
  name: string;
  description: string;
  capability: string;
  operation: string;
  risk: string;
  requiresApproval: boolean;
  connectors: Array<{ id: string; name: string }>;
}
export interface TransformationView {
  id: string;
  name: string;
  description: string;
  mappings: unknown;
  updatedAt: string;
}

type Perms = { manage: boolean; admin: boolean; create: boolean };

export function ActionCatalog({ actions, templates, transformations, restConnectors, perms }: { actions: ActionView[]; templates: TemplateView[]; transformations: TransformationView[]; restConnectors: Array<{ id: string; name: string }>; perms: Perms }) {
  const router = useRouter();
  const [tab, setTab] = useState("actions");
  const [q, setQ] = useState("");
  const [installing, setInstalling] = useState<TemplateView | null>(null);
  const [building, setBuilding] = useState(false);
  const rows = actions.filter((a) => !q || `${a.key} ${a.name} ${a.connectorName}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Array<DataTableColumn<ActionView>> = [
    { key: "name", header: "Action", sortable: true, sortValue: (a) => a.name, cell: (a) => <span><span className="font-medium">{a.name}</span><span className="block font-mono text-xs text-subtle">{a.key}</span></span> },
    { key: "system", header: "System", cell: (a) => <span className="text-sm">{a.connectorName}<span className="block text-xs text-subtle">{a.connectorType} · {a.capability}</span></span> },
    { key: "op", header: "Operation", hideOnMobile: true, cell: (a) => a.operation },
    { key: "risk", header: "Risk", cell: (a) => <RiskBadge risk={a.risk} /> },
    { key: "flags", header: "Controls", hideOnMobile: true, cell: (a) => <span className="flex flex-wrap gap-1">{a.requiresApproval && <Badge tone="warning">approval</Badge>}{a.aiExposed && <Badge tone="accent" icon={<Bot />}>AI tool</Badge>}{a.bridgeType !== "native" && <Badge>{a.bridgeType.replace("_", " ")}</Badge>}{a.idempotency !== "none" && <Badge>idempotent</Badge>}</span> },
    { key: "status", header: "Status", cell: (a) => <StatusPill status={a.status} /> },
  ];
  return (
    <div className="space-y-4">
      <Tabs ariaLabel="Catalog sections" value={tab} onChange={setTab} idPrefix="cat" items={[{ value: "actions", label: `Actions (${actions.length})` }, { value: "templates", label: `Templates (${templates.length})` }, { value: "transformations", label: `Transformations (${transformations.length})` }]} />
      <TabPanel value="actions" selected={tab} idPrefix="cat">
        <div className="space-y-4">
          <FilterBar onSearchChange={setQ} searchPlaceholder="Search actions" actions={perms.admin ? <Button variant="secondary" leftIcon={<Wrench className="size-4" />} onClick={() => setBuilding(true)}>Custom action</Button> : undefined} />
          <DataTable columns={columns} rows={rows} getRowId={(a) => a.id} onRowClick={(a) => router.push(`${IH}/actions/${a.id}`)} rowLabel={(a) => `Open ${a.name}`} caption="Installed actions"
            emptyState={<p className="p-6 text-center text-sm text-muted">No actions yet. Install one from the Templates tab — it binds a business action to one of your shared connectors.</p>} />
        </div>
      </TabPanel>
      <TabPanel value="templates" selected={tab} idPrefix="cat">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.key}>
              <CardHeader title={t.name} description={`${t.connectorName} · ${t.capability} (${t.operation})`} actions={<RiskBadge risk={t.risk} />} />
              <CardBody className="space-y-2 text-sm">
                <p className="text-muted">{t.description}</p>
                <div className="flex flex-wrap gap-1">
                  {t.requiresApproval && <Badge tone="warning">approval by default</Badge>}
                  {t.availability === "contract_only" && <Badge>adapter not shipped yet — test-mode dry runs only</Badge>}
                  {t.availability === "sandbox" && <Badge tone="warning">simulated</Badge>}
                </div>
                {perms.manage && (
                  t.connectors.length ? (
                    <Button size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setInstalling(t)}>Install</Button>
                  ) : (
                    <p className="text-xs text-subtle">No {t.connectorName} connector configured. Add one under Administration → Connectors.</p>
                  )
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      </TabPanel>
      <TabPanel value="transformations" selected={tab} idPrefix="cat">
        <Transformations items={transformations} canEdit={perms.create} />
      </TabPanel>
      {installing && <InstallTemplate template={installing} onClose={() => setInstalling(null)} />}
      {building && <CustomActionBuilder connectors={restConnectors} onClose={() => setBuilding(false)} />}
    </div>
  );
}

function InstallTemplate({ template: t, onClose }: { template: TemplateView; onClose: () => void }) {
  const router = useRouter();
  const [connectorId, setConnectorId] = useState(t.connectors[0]!.id);
  const [key, setKey] = useState("");
  const [name, setName] = useState(t.name);
  const [requiresApproval, setRequiresApproval] = useState(t.requiresApproval);
  const [aiExposed, setAiExposed] = useState(false);
  const { run, pending } = useMutation();
  return (
    <Drawer open onClose={onClose} title={`Install "${t.name}"`} description="Binds the action to a shared connector. Credentials stay on the connector; the action only references it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={async () => { const a = await run(() => apiFetch<ActionView>(`${IH}/actions`, { body: { templateKey: t.key, connectorId, key: key || undefined, name, requiresApproval, aiExposed } }), { success: "Action installed", refresh: false }); if (a) router.push(`${IH}/actions/${a.id}`); }}>Install</Button></>}>
      <div className="space-y-4">
        <FormField id="i-conn" label="Connector">{(a) => <Select {...a} value={connectorId} onChange={(e) => setConnectorId(e.target.value)} options={t.connectors.map((c) => ({ value: c.id, label: c.name }))} />}</FormField>
        <FormField id="i-key" label="Action key" hint="Used in workflows and as the AI tool name. Leave empty to generate one.">{(a) => <Input {...a} placeholder="e.g. crm.create_lead" value={key} onChange={(e) => setKey(e.target.value)} />}</FormField>
        <FormField id="i-name" label="Display name">{(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
        <Checkbox label="Require human approval" description={t.requiresApproval ? "The template requires approval; you can't turn it off here." : "Every live call pauses for integration.approve."} disabled={t.requiresApproval} checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
        <Checkbox label="Expose to AI as a tool" description="AI callers reach it only through the tool gateway, with the same validation, permissions, policy and approval." checked={aiExposed} onChange={(e) => setAiExposed(e.target.checked)} />
      </div>
    </Drawer>
  );
}

const DEFAULT_INPUT_SCHEMA = { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64, description: "Record id" } } };

function CustomActionBuilder({ connectors, onClose }: { connectors: Array<{ id: string; name: string }>; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ key: "", name: "", description: "", connectorId: connectors[0]?.id ?? "", bridgeType: "api_wrapper", method: "GET", path: "/records/{{input.id}}", risk: "medium", idempotency: "none", timeoutMs: "30000", rateLimitPerMinute: "", requiresApproval: false, aiExposed: false, capturePayloads: false });
  const [inputSchema, setInputSchema] = useState<unknown>(DEFAULT_INPUT_SCHEMA);
  const [outputSchema, setOutputSchema] = useState<unknown>(null);
  const [useOutput, setUseOutput] = useState(false);
  const [query, setQuery] = useState<unknown>({});
  const [body, setBody] = useState<unknown>({});
  const [headers, setHeaders] = useState<unknown>({});
  const { run, pending } = useMutation();
  const ui = f.bridgeType === "ui_automation";
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function create() {
    const payload = {
      ...f, timeoutMs: Number(f.timeoutMs), rateLimitPerMinute: f.rateLimitPerMinute ? Number(f.rateLimitPerMinute) : null, inputSchema, outputSchema: useOutput ? outputSchema : undefined,
      query, headers, ...(f.method !== "GET" && f.method !== "DELETE" ? { body } : {}),
    };
    const a = await run(() => apiFetch<ActionView>(`${IH}/actions/custom`, { body: payload }), { success: "Custom action created", refresh: false });
    if (a) router.push(`${IH}/actions/${a.id}`);
  }
  return (
    <Drawer open onClose={onClose} width="lg" title="Custom action" description="For shared REST API connectors. Authentication comes from the connector's stored credential — never from the action. Headers cannot set credentials."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.key || !f.name || !f.connectorId} onClick={create}>Create</Button></>}>
      {connectors.length === 0 ? (
        <p className="text-sm text-muted">Add a REST API connector under Administration → Connectors first.</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="c-key" label="Key" required>{(a) => <Input {...a} placeholder="erp.get_order" value={f.key} onChange={set("key")} />}</FormField>
            <FormField id="c-name" label="Name" required>{(a) => <Input {...a} value={f.name} onChange={set("name")} />}</FormField>
            <FormField id="c-conn" label="Connector (authentication reference)">{(a) => <Select {...a} value={f.connectorId} onChange={set("connectorId")} options={connectors.map((c) => ({ value: c.id, label: c.name }))} />}</FormField>
            <FormField id="c-bridge" label="Bridge" hint="Legacy bridges run through an API you operate (wrapper, DB adapter, SFTP gateway, RPA or UI-automation orchestrator).">
              {(a) => <Select {...a} value={f.bridgeType} onChange={set("bridgeType")} options={[{ value: "api_wrapper", label: "API wrapper" }, { value: "database", label: "Database adapter" }, { value: "sftp", label: "SFTP gateway" }, { value: "rpa", label: "RPA orchestrator" }, { value: "ui_automation", label: "UI / browser automation (high risk)" }, { value: "native", label: "Native API" }]} />}
            </FormField>
            <FormField id="c-method" label="Method">{(a) => <Select {...a} value={f.method} onChange={set("method")} options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))} />}</FormField>
            <FormField id="c-path" label="Endpoint path" hint="Relative to the connector's base URL; {{input.x}} placeholders allowed.">{(a) => <Input {...a} value={f.path} onChange={set("path")} />}</FormField>
            <FormField id="c-risk" label="Risk">{(a) => <Select {...a} value={f.risk} onChange={set("risk")} options={["low", "medium", "high", "critical"].map((r) => ({ value: r, label: r }))} />}</FormField>
            <FormField id="c-idem" label="Idempotency" hint="auto: sends an Idempotency-Key header per execution step.">{(a) => <Select {...a} value={f.idempotency} onChange={set("idempotency")} options={[{ value: "none", label: "None" }, { value: "auto", label: "Automatic key" }, { value: "key_required", label: "Caller must supply a key" }]} />}</FormField>
            <FormField id="c-timeout" label="Timeout (ms)">{(a) => <Input {...a} type="number" min={1000} max={120000} value={f.timeoutMs} onChange={set("timeoutMs")} />}</FormField>
            <FormField id="c-rate" label="Rate limit (calls/min)" hint="On top of the connector's own limit.">{(a) => <Input {...a} type="number" min={1} value={f.rateLimitPerMinute} onChange={set("rateLimitPerMinute")} />}</FormField>
          </div>
          <FormField id="c-desc" label="Description">{(a) => <Textarea {...a} rows={2} value={f.description} onChange={set("description")} />}</FormField>
          {ui && <p className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-sm text-warning">UI automation is fragile and hard to observe. These actions are always at least high risk, always require approval, and always capture full request/response payloads in the execution history.</p>}
          <JsonField id="c-input" label="Request schema (validated input)" value={inputSchema} onValid={setInputSchema} rows={8} />
          <div className="grid gap-3 sm:grid-cols-2">
            <JsonField id="c-query" label="Query parameters (templates)" value={query} onValid={setQuery} rows={4} />
            <JsonField id="c-headers" label="Headers (no credentials)" value={headers} onValid={setHeaders} rows={4} />
          </div>
          {f.method !== "GET" && f.method !== "DELETE" && <JsonField id="c-body" label="Body template" value={body} onValid={setBody} rows={6} />}
          <Checkbox label="Validate the response against a schema" checked={useOutput} onChange={(e) => setUseOutput(e.target.checked)} />
          {useOutput && <JsonField id="c-output" label="Response schema (applied to the response body)" value={outputSchema ?? { type: "object", additionalProperties: true, properties: {} }} onValid={setOutputSchema} rows={6} />}
          <Checkbox label="Require human approval" disabled={ui} checked={ui || f.requiresApproval} onChange={(e) => setF({ ...f, requiresApproval: e.target.checked })} />
          <Checkbox label="Capture full payloads in history" description="Off by default: history stores redacted summaries." disabled={ui} checked={ui || f.capturePayloads} onChange={(e) => setF({ ...f, capturePayloads: e.target.checked })} />
          <Checkbox label="Expose to AI as a tool" checked={f.aiExposed} onChange={(e) => setF({ ...f, aiExposed: e.target.checked })} />
        </div>
      )}
    </Drawer>
  );
}

function Transformations({ items, canEdit }: { items: TransformationView[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<TransformationView | "new" | null>(null);
  return (
    <div className="space-y-3">
      {canEdit && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEditing("new")}>New transformation</Button>}
      <DataTable
        caption="Reusable transformations"
        rows={items}
        getRowId={(t) => t.id}
        onRowClick={canEdit ? (t) => setEditing(t) : undefined}
        rowLabel={(t) => `Edit ${t.name}`}
        emptyState={<p className="p-6 text-center text-sm text-muted">No reusable transformations. Transform nodes can also define mappings inline.</p>}
        columns={[
          { key: "n", header: "Name", cell: (t) => <span className="font-medium">{t.name}</span> },
          { key: "m", header: "Mappings", cell: (t) => (Array.isArray(t.mappings) ? t.mappings.length : 0) },
          { key: "d", header: "Description", hideOnMobile: true, cell: (t) => t.description || "—" },
          { key: "u", header: "Updated", cell: (t) => <LocalDate value={t.updatedAt} /> },
        ]}
      />
      {editing && <TransformationEditor item={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TransformationEditor({ item, onClose }: { item: TransformationView | null; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [mappings, setMappings] = useState<never[]>(() => (Array.isArray(item?.mappings) ? (item!.mappings as never[]) : ([{ target: "email", source: "input.email", transforms: ["trim", "lowercase"], type: "string", required: true }] as never[])));
  const { run, pending } = useMutation();
  return (
    <Drawer open onClose={onClose} width="lg" title={item ? "Edit transformation" : "New transformation"} description="Source fields → normalized fields → destination fields, with types, transforms, required fields and fallbacks."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!name.trim()} onClick={async () => { if (await run(() => apiFetch(item ? `${IH}/transformations/${item.id}` : `${IH}/transformations`, { method: item ? "PUT" : "POST", body: { name, description, mappings } }), { success: "Transformation saved" })) onClose(); }}>Save</Button></>}>
      <div className="space-y-4">
        <FormField id="t-name" label="Name">{(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
        <FormField id="t-desc" label="Description">{(a) => <Input {...a} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormField>
        <MappingEditor value={mappings} readOnly={false} onChange={(v) => setMappings(v as never[])} />
      </div>
    </Drawer>
  );
}

export function ActionDetailView({ action, tool, canManage }: { action: ActionView; tool: unknown; canManage: boolean }) {
  const [f, setF] = useState({ name: action.name, description: action.description, risk: action.risk, requiresApproval: action.requiresApproval, aiExposed: action.aiExposed, capturePayloads: action.capturePayloads, timeoutMs: String(action.timeoutMs), rateLimitPerMinute: action.rateLimitPerMinute ? String(action.rateLimitPerMinute) : "", maxAttempts: String(action.retry.maxAttempts), backoffSeconds: String(action.retry.backoffSeconds), status: action.status });
  const { run, pending } = useMutation();
  const ui = action.bridgeType === "ui_automation";
  const save = () =>
    run(() => apiFetch(`${IH}/actions/${action.id}`, {
      method: "PATCH",
      body: { name: f.name, description: f.description, risk: f.risk, requiresApproval: f.requiresApproval, aiExposed: f.aiExposed, capturePayloads: f.capturePayloads, timeoutMs: Number(f.timeoutMs), rateLimitPerMinute: f.rateLimitPerMinute ? Number(f.rateLimitPerMinute) : null, retry: { maxAttempts: Number(f.maxAttempts), backoffSeconds: Number(f.backoffSeconds) }, status: f.status },
    }), { success: "Action updated" });
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader title="Controls" actions={canManage ? <Button size="sm" loading={pending} onClick={save}>Save</Button> : undefined} />
        <CardBody className="space-y-3">
          <KeyValueList items={[
            { key: "sys", label: "System", value: `${action.connectorName} (${action.connectorType})` },
            { key: "cap", label: "Capability", value: `${action.capability} · ${action.operation}` },
            { key: "kind", label: "Kind", value: `${action.kind}${action.templateKey ? ` · template ${action.templateKey}` : ""} · ${action.bridgeType.replace("_", " ")}` },
            { key: "perm", label: "Required permissions", value: action.requiredPermissions.join(", ") },
            { key: "idem", label: "Idempotency", value: action.idempotency },
            { key: "upd", label: "Updated", value: <LocalDate value={action.updatedAt} /> },
          ]} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="a-name" label="Name">{(a) => <Input {...a} disabled={!canManage} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
            <FormField id="a-risk" label="Risk">{(a) => <Select {...a} disabled={!canManage} value={f.risk} onChange={(e) => setF({ ...f, risk: e.target.value as typeof f.risk })} options={["low", "medium", "high", "critical"].map((r) => ({ value: r, label: r }))} />}</FormField>
            <FormField id="a-timeout" label="Timeout (ms)">{(a) => <Input {...a} type="number" disabled={!canManage} value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: e.target.value })} />}</FormField>
            <FormField id="a-rate" label="Rate limit / min">{(a) => <Input {...a} type="number" disabled={!canManage} value={f.rateLimitPerMinute} onChange={(e) => setF({ ...f, rateLimitPerMinute: e.target.value })} />}</FormField>
            <FormField id="a-att" label="Retry attempts">{(a) => <Input {...a} type="number" min={1} max={10} disabled={!canManage} value={f.maxAttempts} onChange={(e) => setF({ ...f, maxAttempts: e.target.value })} />}</FormField>
            <FormField id="a-back" label="Initial backoff (s)">{(a) => <Input {...a} type="number" min={1} disabled={!canManage} value={f.backoffSeconds} onChange={(e) => setF({ ...f, backoffSeconds: e.target.value })} />}</FormField>
            <FormField id="a-status" label="Status">{(a) => <Select {...a} disabled={!canManage} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={[{ value: "active", label: "Active" }, { value: "disabled", label: "Disabled" }]} />}</FormField>
          </div>
          <FormField id="a-desc" label="Description">{(a) => <Textarea {...a} rows={2} disabled={!canManage} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
          <Checkbox label="Require human approval" disabled={!canManage || ui} checked={f.requiresApproval} onChange={(e) => setF({ ...f, requiresApproval: e.target.checked })} />
          <Checkbox label="Capture full payloads in history" disabled={!canManage || ui} checked={f.capturePayloads} onChange={(e) => setF({ ...f, capturePayloads: e.target.checked })} />
          <Checkbox label="Expose to AI as a tool" disabled={!canManage} checked={f.aiExposed} onChange={(e) => setF({ ...f, aiExposed: e.target.checked })} />
        </CardBody>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Input schema" description="Every call is validated against this before anything else happens." />
          <CardBody><CodeBlock code={JSON.stringify(action.inputSchema, null, 2)} language="json" maxHeight="280px" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Request template" description="How validated input becomes the connector request." />
          <CardBody><CodeBlock code={JSON.stringify(action.requestTemplate, null, 2)} language="json" maxHeight="220px" /></CardBody>
        </Card>
        {action.outputSchema && (
          <Card>
            <CardHeader title="Response schema" />
            <CardBody><CodeBlock code={JSON.stringify(action.outputSchema, null, 2)} language="json" maxHeight="220px" /></CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="AI tool definition" description={action.aiExposed ? "Returned by GET /tools to AI callers that hold the required permissions." : "Not exposed to AI."} />
          <CardBody><CodeBlock code={JSON.stringify(tool, null, 2)} language="json" maxHeight="220px" /></CardBody>
        </Card>
      </div>
    </div>
  );
}
