"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { Badge, Button, DataTable, Drawer, FilterBar, FormField, Input, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type WorkflowView } from "@eaop/module-integration-hub";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { IH, JsonField, StatusPill } from "./common";

type Row = WorkflowView & { executions30d: number; successRate30d: number | null; lastRunAt: string | null };

export function WorkflowList({ workflows, canCreate, canManage, eventTypes }: { workflows: Row[]; canCreate: boolean; canManage: boolean; eventTypes: string[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { run, pending } = useMutation();
  const rows = workflows.filter((w) => !q || `${w.name} ${w.description}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Array<DataTableColumn<Row>> = [
    { key: "name", header: "Workflow", sortable: true, sortValue: (w) => w.name, cell: (w) => <span className="font-medium">{w.name}{w.isSample && <Badge tone="warning" className="ml-2">Sample · simulated</Badge>}</span> },
    { key: "status", header: "Status", cell: (w) => <StatusPill status={w.status} /> },
    { key: "trigger", header: "Trigger", hideOnMobile: true, cell: (w) => (w.triggerType === "event" ? `event: ${String(w.triggerConfig.eventType ?? "")}` : w.triggerType) },
    { key: "ver", header: "Version", hideOnMobile: true, cell: (w) => `v${w.currentVersion}${w.publishedVersion ? ` (live v${w.publishedVersion})` : ""}` },
    { key: "runs", header: "Runs (30 d)", align: "right", hideOnMobile: true, cell: (w) => w.executions30d },
    { key: "ok", header: "Success", align: "right", hideOnMobile: true, cell: (w) => (w.successRate30d == null ? "—" : `${w.successRate30d}%`) },
    { key: "last", header: "Last run", hideOnMobile: true, cell: (w) => <LocalDate value={w.lastRunAt} /> },
  ];
  return (
    <div className="space-y-4">
      <FilterBar
        onSearchChange={setQ}
        searchPlaceholder="Search workflows"
        actions={
          <div className="flex gap-2">
            {canManage && canCreate && (
              <Button variant="secondary" leftIcon={<Sparkles className="size-4" />} loading={pending} onClick={async () => { const w = await run(() => apiFetch<{ id: string }>(`${IH}/workflows/sample`, { method: "POST" }), { success: "Sample workflow created", refresh: false }); if (w) router.push(`${IH}/workflows/${w.id}`); }}>
                Sample workflow
              </Button>
            )}
            {canCreate && <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New workflow</Button>}
          </div>
        }
      />
      <DataTable columns={columns} rows={rows} getRowId={(w) => w.id} onRowClick={(w) => router.push(`${IH}/workflows/${w.id}`)} rowLabel={(w) => `Open ${w.name}`} caption="Integration workflows"
        emptyState={<p className="p-6 text-center text-sm text-muted">No workflows yet. Create one, or generate the sample quote workflow.</p>} />
      {creating && <WorkflowSettings mode="create" eventTypes={eventTypes} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function WorkflowSettings({ mode, workflow, eventTypes, onClose }: { mode: "create" | "edit"; workflow?: WorkflowView; eventTypes: string[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(workflow?.name ?? "");
  const [description, setDescription] = useState(workflow?.description ?? "");
  const [triggerType, setTriggerType] = useState(workflow?.triggerType ?? "manual");
  const [eventType, setEventType] = useState(String(workflow?.triggerConfig.eventType ?? eventTypes[0] ?? ""));
  const [useSchema, setUseSchema] = useState(!!workflow?.inputSchema);
  const [inputSchema, setInputSchema] = useState<unknown>(workflow?.inputSchema ?? { type: "object", properties: { customerEmail: { type: "string", format: "email" } }, required: ["customerEmail"] });
  const { run, pending } = useMutation();
  async function save() {
    const body = { name, description, triggerType, triggerConfig: triggerType === "event" ? { eventType } : {}, inputSchema: useSchema ? inputSchema : null };
    if (mode === "create") {
      const w = await run(() => apiFetch<{ id: string }>(`${IH}/workflows`, { body }), { success: "Workflow created", refresh: false });
      if (w) router.push(`${IH}/workflows/${w.id}`);
    } else if (await run(() => apiFetch(`${IH}/workflows/${workflow!.id}`, { method: "PATCH", body }), { success: "Settings saved" })) onClose();
  }
  return (
    <Drawer open onClose={onClose} width="lg" title={mode === "create" ? "New workflow" : "Workflow settings"} description="Workflows start as drafts. Test-run drafts at any time; publish to run them live."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!name.trim()} onClick={save}>{mode === "create" ? "Create" : "Save"}</Button></>}>
      <div className="space-y-4">
        <FormField id="wf-name" label="Name" required>{(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
        <FormField id="wf-desc" label="Description">{(a) => <Textarea {...a} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormField>
        <FormField id="wf-trigger" label="Trigger" hint="Manual: started in the app. API: started with an API key. Event: started by a platform event (runs as the publisher).">
          {(a) => <Select {...a} value={triggerType} onChange={(e) => setTriggerType(e.target.value)} options={[{ value: "manual", label: "Manual" }, { value: "api", label: "API" }, { value: "event", label: "Platform event" }]} />}
        </FormField>
        {triggerType === "event" && (
          <FormField id="wf-event" label="Event type">{(a) => <Select {...a} value={eventType} onChange={(e) => setEventType(e.target.value)} options={eventTypes.map((t) => ({ value: t, label: t }))} />}</FormField>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useSchema} onChange={(e) => setUseSchema(e.target.checked)} /> Validate run input against a JSON schema</label>
        {useSchema && <JsonField id="wf-schema" label="Input schema (JSON Schema subset)" value={inputSchema} onValid={setInputSchema} rows={10} />}
      </div>
    </Drawer>
  );
}
