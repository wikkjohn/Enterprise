"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, Drawer, FormField, Input, KeyValueList, Modal, Select, StatusBadge, type DataTableColumn } from "@eaop/design-system";
import { type AIRunView, type ProviderView } from "@eaop/ai";
import { apiFetch } from "@/lib/client";
import { useMutation } from "@/components/actions";

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function ProvidersAdmin({ providers, canManage }: { providers: ProviderView[]; canManage: boolean }) {
  const [adding, setAdding] = useState(false);
  const [modelFor, setModelFor] = useState<ProviderView | null>(null);
  const { run } = useMutation();
  return (
    <div className="space-y-4">
      {canManage && <div className="flex justify-end"><Button onClick={() => setAdding(true)}>Add organization provider</Button></div>}
      {providers.map((p) => (
        <Card key={p.id}>
          <CardHeader
            title={<span className="flex flex-wrap items-center gap-2">{p.name}<Badge>{p.scope === "platform" ? "Platform" : "Organization"}</Badge>{!p.implemented && <Badge tone="warning">Adapter not available</Badge>}{p.kind === "sandbox" && <Badge tone="warning">Simulated</Badge>}</span>}
            description={`${p.kind} · ${p.hasCredential ? "credential configured" : "no credential"}`}
            actions={
              <div className="flex items-center gap-2">
                <StatusBadge status={p.status} />
                {canManage && p.scope === "organization" && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setModelFor(p)}>Add model</Button>
                    <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch(`/ai/providers/${p.id}`, { method: "PATCH", body: { status: p.status === "enabled" ? "disabled" : "enabled" } }), { success: "Provider updated" })}>{p.status === "enabled" ? "Disable" : "Enable"}</Button>
                  </>
                )}
              </div>
            }
          />
          <CardBody flush>
            {p.models.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">{p.status === "not_configured" ? "Not configured: set the provider credential (platform: environment variable; organization: API key) and add models." : "No models registered."}</p> : (
              <DataTable
                density="compact"
                getRowId={(m) => m.id}
                rows={p.models}
                columns={[
                  { key: "model", header: "Model", cell: (m) => <div><div className="font-medium">{m.displayName}</div><code className="font-mono text-xs text-muted">{m.modelKey}</code></div> },
                  { key: "tier", header: "Tier", cell: (m) => <Badge tone={m.tier === "premium" ? "accent" : "neutral"}>{m.tier}</Badge> },
                  { key: "price", header: "Input / output per 1M tokens", align: "right", cell: (m) => `${usd(m.inputCostPerMtok)} / ${usd(m.outputCostPerMtok)}` },
                  { key: "class", header: "Max data classification", hideOnMobile: true, cell: (m) => m.maxDataClassification },
                  { key: "ctx", header: "Context", hideOnMobile: true, align: "right", cell: (m) => (m.contextWindow ? m.contextWindow.toLocaleString() : "—") },
                  { key: "status", header: "Status", cell: (m) => <StatusBadge status={m.status} /> },
                ]}
              />
            )}
          </CardBody>
        </Card>
      ))}
      <p className="text-xs text-muted">Prices are list-price estimates used for cost reporting; adjust organization models to your contract.</p>
      {adding && <AddProvider onClose={() => setAdding(false)} />}
      {modelFor && <AddModel provider={modelFor} onClose={() => setModelFor(null)} />}
    </div>
  );
}

function AddProvider({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ key: "", name: "", kind: "openai_compatible", baseUrl: "", apiVersion: "", apiKey: "" });
  const { run, pending } = useMutation();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title="Add organization AI provider" description="Bring your own deployment or key. The key is stored in the secret store."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={async () => {
        const config: Record<string, string> = {};
        if (form.baseUrl) config.baseUrl = form.baseUrl;
        if (form.apiVersion) config.apiVersion = form.apiVersion;
        const ok = await run(() => apiFetch("/ai/providers", { body: { key: form.key, name: form.name, kind: form.kind, config, ...(form.apiKey ? { apiKey: form.apiKey } : {}) } }), { success: "Provider added" });
        if (ok) onClose();
      }}>Add provider</Button></>}>
      <div className="space-y-4">
        <FormField id="p-kind" label="Kind">{(a) => <Select {...a} value={form.kind} onChange={set("kind")} options={[["anthropic", "Anthropic"], ["openai", "OpenAI"], ["azure_openai", "Azure OpenAI"], ["openai_compatible", "OpenAI-compatible endpoint"], ["local", "Local / private model server"], ["google", "Google (adapter not available)"], ["bedrock", "AWS Bedrock (adapter not available)"]].map(([value, label]) => ({ value: value!, label: label! }))} />}</FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="p-name" label="Name" required>{(a) => <Input {...a} value={form.name} onChange={set("name")} />}</FormField>
          <FormField id="p-key" label="Key" required hint="e.g. acme-azure">{(a) => <Input {...a} value={form.key} onChange={set("key")} />}</FormField>
        </div>
        <FormField id="p-url" label="Base URL" hint="Required for Azure, OpenAI-compatible and local servers.">{(a) => <Input {...a} type="url" value={form.baseUrl} onChange={set("baseUrl")} />}</FormField>
        {form.kind === "azure_openai" && <FormField id="p-ver" label="API version">{(a) => <Input {...a} value={form.apiVersion} onChange={set("apiVersion")} placeholder="2024-10-21" />}</FormField>}
        <FormField id="p-apikey" label="API key">{(a) => <Input {...a} type="password" autoComplete="off" value={form.apiKey} onChange={set("apiKey")} />}</FormField>
      </div>
    </Modal>
  );
}

function AddModel({ provider, onClose }: { provider: ProviderView; onClose: () => void }) {
  const [f, setF] = useState({ modelKey: "", displayName: "", inputCostPerMtok: "0", outputCostPerMtok: "0", tier: "standard", maxDataClassification: "internal", contextWindow: "" });
  const { run, pending } = useMutation();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={`Add model to ${provider.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={async () => {
        const ok = await run(() => apiFetch(`/ai/providers/${provider.id}/models`, { body: { modelKey: f.modelKey, displayName: f.displayName || f.modelKey, inputCostPerMtok: Number(f.inputCostPerMtok), outputCostPerMtok: Number(f.outputCostPerMtok), tier: f.tier, maxDataClassification: f.maxDataClassification, ...(f.contextWindow ? { contextWindow: Number(f.contextWindow) } : {}) } }), { success: "Model saved" });
        if (ok) onClose();
      }}>Save model</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="m-key" label="Model / deployment id" required>{(a) => <Input {...a} value={f.modelKey} onChange={set("modelKey")} />}</FormField>
        <FormField id="m-name" label="Display name">{(a) => <Input {...a} value={f.displayName} onChange={set("displayName")} />}</FormField>
        <FormField id="m-in" label="Input $ / 1M tokens">{(a) => <Input {...a} type="number" step="0.01" value={f.inputCostPerMtok} onChange={set("inputCostPerMtok")} />}</FormField>
        <FormField id="m-out" label="Output $ / 1M tokens">{(a) => <Input {...a} type="number" step="0.01" value={f.outputCostPerMtok} onChange={set("outputCostPerMtok")} />}</FormField>
        <FormField id="m-tier" label="Tier">{(a) => <Select {...a} value={f.tier} onChange={set("tier")} options={["economy", "standard", "premium"].map((v) => ({ value: v, label: v }))} />}</FormField>
        <FormField id="m-class" label="Approved up to">{(a) => <Select {...a} value={f.maxDataClassification} onChange={set("maxDataClassification")} options={["public", "internal", "confidential", "restricted"].map((v) => ({ value: v, label: v }))} />}</FormField>
        <FormField id="m-ctx" label="Context window (tokens)">{(a) => <Input {...a} type="number" value={f.contextWindow} onChange={set("contextWindow")} />}</FormField>
      </div>
    </Modal>
  );
}

export function RunsTable({ runs, nextCursor }: { runs: AIRunView[]; nextCursor?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState<AIRunView | null>(null);
  const columns: Array<DataTableColumn<AIRunView>> = [
    { key: "time", header: "Time", cell: (r) => new Date(r.createdAt).toLocaleString() },
    { key: "module", header: "Module / use case", cell: (r) => <div><div>{r.moduleId}</div><code className="font-mono text-xs text-muted">{r.useCase}</code></div> },
    { key: "model", header: "Model", cell: (r) => <code className="font-mono text-xs">{r.providerKey}/{r.modelKey}</code> },
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "tokens", header: "Tokens in/out", align: "right", hideOnMobile: true, cell: (r) => `${r.inputTokens.toLocaleString()} / ${r.outputTokens.toLocaleString()}` },
    { key: "cost", header: "Est. cost", align: "right", cell: (r) => usd(r.estimatedCostUsd) },
    { key: "lat", header: "Latency", align: "right", hideOnMobile: true, cell: (r) => `${r.latencyMs} ms` },
  ];
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <FormField id="f-status" label="Status">{(a) => <Select {...a} size="sm" value={params.get("status") ?? ""} onChange={(e) => router.push(`/admin/ai-runs${e.target.value ? `?status=${e.target.value}` : ""}`)} options={[{ value: "", label: "All" }, ...["succeeded", "failed", "blocked", "pending_approval"].map((v) => ({ value: v, label: v }))]} />}</FormField>
      </div>
      <DataTable columns={columns} rows={runs} getRowId={(r) => r.id} onRowClick={setOpen} rowLabel={(r) => `Open run ${r.id}`} caption="AI runs" emptyState={<p className="p-6 text-center text-sm text-muted">No AI runs yet.</p>} />
      {nextCursor && <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => router.push(`/admin/ai-runs?cursor=${encodeURIComponent(nextCursor)}${params.get("status") ? `&status=${params.get("status")}` : ""}`)}>Older runs</Button></div>}
      {open && (
        <Drawer open onClose={() => setOpen(null)} title="AI run" description={open.id} width="lg">
          <div className="space-y-4">
            <KeyValueList columns={2} items={[
              { key: "s", label: "Status", value: <StatusBadge status={open.status} /> },
              { key: "a", label: "Actor", value: `${open.actorType}:${open.actorId}` },
              { key: "m", label: "Model", value: `${open.providerKey}/${open.modelKey}` },
              { key: "t", label: "Prompt template", value: open.promptTemplateId ? `${open.promptTemplateId}@${open.promptTemplateVersion}` : "—" },
              { key: "r", label: "Prompt retention", value: open.promptRetention },
              { key: "h", label: "Prompt hash", value: <code className="break-all font-mono text-xs">{open.promptHash ?? "—"}</code> },
              { key: "p", label: "Policy decision", value: open.policyDecision ?? "—" },
              { key: "c", label: "Correlation id", value: <code className="font-mono text-xs">{open.correlationId ?? "—"}</code> },
              ...(open.errorCode ? [{ key: "e", label: "Error", value: <span className="text-danger">{open.errorCode}: {open.errorMessage}</span> }] : []),
            ]} />
            {open.policyReasons && open.policyReasons.length > 0 && <div><h3 className="mb-1 text-sm font-semibold">Policy reasons</h3><ul className="list-disc pl-5 text-sm">{open.policyReasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
            <div><h3 className="mb-1 text-sm font-semibold">References</h3><CodeBlock code={JSON.stringify(open.metadata, null, 2)} language="json" /></div>
            {open.request !== null && <div><h3 className="mb-1 text-sm font-semibold">Request (retained)</h3><CodeBlock code={JSON.stringify(open.request, null, 2)} language="json" maxHeight="300px" /></div>}
            {open.response !== null && <div><h3 className="mb-1 text-sm font-semibold">Response (retained)</h3><CodeBlock code={JSON.stringify(open.response, null, 2)} language="json" maxHeight="300px" /></div>}
          </div>
        </Drawer>
      )}
    </>
  );
}
