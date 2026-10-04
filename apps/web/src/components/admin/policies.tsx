"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, FormField, Input, Modal, Select, StatusBadge, Textarea } from "@eaop/design-system";
import { type PolicyVersionView, type PolicyView } from "@eaop/policies";
import { apiFetch } from "@/lib/client";
import { errorMessage, useMutation } from "@/components/actions";

const TEMPLATE = JSON.stringify(
  { combining: "deny-overrides", defaultEffect: "ALLOW", rules: [{ id: "example", description: "Require approval above 500", effect: "REQUIRE_APPROVAL", actions: ["refund"], when: { field: "resource.attributes.amount", op: "gt", value: 500 } }] },
  null,
  2,
);

export function PoliciesList({ policies, kinds, canManage }: { policies: PolicyView[]; kinds: Array<{ key: string; owner: string; description: string }>; canManage: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-4">
      {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}>New policy</Button></div>}
      <DataTable
        caption="Policies"
        rows={policies}
        getRowId={(p) => p.id}
        onRowClick={(p) => router.push(`/admin/policies/${encodeURIComponent(p.key)}`)}
        emptyState={<p className="p-6 text-center text-sm text-muted">No policies yet. Policies return ALLOW, DENY, REQUIRE_APPROVAL or ESCALATE and are evaluated by the core and by modules.</p>}
        columns={[
          { key: "name", header: "Policy", cell: (p) => <div><div className="font-medium">{p.name}</div><code className="font-mono text-xs text-muted">{p.key}</code></div> },
          { key: "kind", header: "Kind", cell: (p) => <Badge>{p.kind}</Badge> },
          { key: "status", header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
          { key: "ver", header: "Active / latest", align: "right", cell: (p) => `${p.activeVersion ?? "—"} / ${p.latestVersion}` },
          { key: "upd", header: "Updated", hideOnMobile: true, cell: (p) => new Date(p.updatedAt).toLocaleString() },
        ]}
      />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Registered policy kinds</h2>
        <ul className="grid gap-2 md:grid-cols-2">{kinds.map((k) => <li key={k.key} className="rounded-md border border-border bg-surface p-3 text-sm"><code className="font-mono">{k.key}</code> <span className="text-muted">({k.owner})</span><p className="text-muted">{k.description}</p></li>)}</ul>
      </section>
      {creating && <CreatePolicy kinds={kinds} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreatePolicy({ kinds, onClose }: { kinds: Array<{ key: string }>; onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ key: "", name: "", description: "", kind: kinds[0]?.key ?? "access", definition: TEMPLATE });
  const [err, setErr] = useState<string | null>(null);
  const { run, pending } = useMutation();
  return (
    <Modal open onClose={onClose} size="lg" title="New policy" description="New policies start as drafts. Activate a version to enforce it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={async () => {
        let definition: unknown;
        try { definition = JSON.parse(f.definition); } catch { setErr("Definition must be valid JSON."); return; }
        const p = await run(() => apiFetch<PolicyView>("/policies", { body: { key: f.key, name: f.name, description: f.description, kind: f.kind, definition } }), { success: "Policy created", refresh: false });
        if (p) router.push(`/admin/policies/${encodeURIComponent(p.key)}`);
      }}>Create draft</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="pol-name" label="Name" required>{(a) => <Input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
          <FormField id="pol-key" label="Key" required hint="e.g. ai.no-restricted-data">{(a) => <Input {...a} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />}</FormField>
        </div>
        <FormField id="pol-kind" label="Kind">{(a) => <Select {...a} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={kinds.map((k) => ({ value: k.key, label: k.key }))} />}</FormField>
        <FormField id="pol-def" label="Definition (JSON)" error={err ?? undefined}>{(a) => <Textarea {...a} rows={14} className="font-mono text-xs" value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

export function PolicyDetail({ policy, canManage }: { policy: PolicyView & { versions: PolicyVersionView[] }; canManage: boolean }) {
  const { run, pending } = useMutation();
  const latest = policy.versions[0];
  const [draft, setDraft] = useState(JSON.stringify(latest?.definition ?? {}, null, 2));
  const [note, setNote] = useState("");
  const [sim, setSim] = useState(JSON.stringify({ subject: { type: "user", id: "u-1" }, resource: { type: "payment", attributes: { amount: 750 } }, action: "refund", context: {} }, null, 2));
  const [simResult, setSimResult] = useState<string | null>(null);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Versions" description="Versions are immutable. Activating one makes it the enforced definition." actions={canManage && policy.status === "active" ? <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch(`/policies/${encodeURIComponent(policy.key)}/disable`, { method: "POST" }), { success: "Policy disabled" })}>Disable</Button> : undefined} />
        <CardBody>
          <ul className="space-y-3">
            {policy.versions.map((v) => (
              <li key={v.version} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">v{v.version} {policy.activeVersion === v.version && policy.status === "active" && <Badge tone="success">Active</Badge>}</span>
                  {canManage && !(policy.activeVersion === v.version && policy.status === "active") && <Button size="sm" variant="secondary" loading={pending} onClick={() => void run(() => apiFetch(`/policies/${encodeURIComponent(policy.key)}/activate`, { body: { version: v.version } }), { success: `v${v.version} activated` })}>Activate</Button>}
                </div>
                <p className="text-xs text-muted">{v.changeNote ?? "No change note"} · {new Date(v.createdAt).toLocaleString()}</p>
                <details className="mt-2"><summary className="cursor-pointer text-xs text-muted">Definition</summary><CodeBlock code={JSON.stringify(v.definition, null, 2)} language="json" maxHeight="260px" /></details>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <div className="space-y-6">
        {canManage && (
          <Card>
            <CardHeader title="New version" />
            <CardBody className="space-y-3">
              <Textarea aria-label="Policy definition JSON" rows={12} className="font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <Input aria-label="Change note" placeholder="Change note" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button loading={pending} onClick={async () => {
                let definition: unknown;
                try { definition = JSON.parse(draft); } catch { return; }
                await run(() => apiFetch(`/policies/${encodeURIComponent(policy.key)}/versions`, { body: { definition, changeNote: note || undefined } }), { success: "Version saved" });
              }}>Save version</Button>
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="Simulate" description="Evaluate the active (or latest) version against a sample request. Nothing is enforced." />
          <CardBody className="space-y-3">
            <Textarea aria-label="Simulation request JSON" rows={8} className="font-mono text-xs" value={sim} onChange={(e) => setSim(e.target.value)} />
            <Button variant="secondary" onClick={async () => {
              try {
                const r = await apiFetch("/policies/simulate", { body: { key: policy.key, request: JSON.parse(sim) } });
                setSimResult(JSON.stringify(r, null, 2));
              } catch (e) {
                setSimResult(errorMessage(e));
              }
            }}>Run simulation</Button>
            {simResult && <CodeBlock code={simResult} language="json" />}
          </CardBody>
        </Card>
        <Link className="text-sm text-accent" href={`/admin/audit?resourceId=${policy.id}`}>View change history</Link>
      </div>
    </div>
  );
}
