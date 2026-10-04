"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, FormField, Input, Modal, Textarea } from "@eaop/design-system";
import { type RoleView } from "@eaop/rbac";
import { apiFetch } from "@/lib/client";
import { ActionButton, useMutation } from "@/components/actions";

interface Perm {
  key: string;
  owner: string;
  description: string;
  risk: string;
}

export function RolesAdmin({ roles, permissions, canManage }: { roles: RoleView[]; permissions: Perm[]; canManage: boolean }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-4">
      {canManage && <div className="flex justify-end"><Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Custom role</Button></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {roles.map((r) => (
          <Card key={r.id}>
            <CardHeader
              title={<span className="flex items-center gap-2">{r.name}{r.isSystem ? <Badge>System</Badge> : <Badge tone="accent">Custom</Badge>}</span>}
              description={r.description}
              actions={!r.isSystem && canManage ? <ActionButton size="sm" variant="ghost" path={`/roles/${r.key}`} method="DELETE" success="Role deleted" confirm={{ title: `Delete ${r.name}?`, message: "Members lose the permissions this role grants." }}>Delete</ActionButton> : undefined}
            />
            <CardBody>
              <details>
                <summary className="cursor-pointer text-sm text-muted">{r.permissions.length} permissions</summary>
                <div className="mt-2 flex flex-wrap gap-1">{r.permissions.map((p) => <code key={p} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">{p}</code>)}</div>
              </details>
            </CardBody>
          </Card>
        ))}
      </div>
      {creating && <CreateRole permissions={permissions} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateRole({ permissions, onClose }: { permissions: Perm[]; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { run, pending } = useMutation();
  const grouped = useMemo(() => {
    const g = new Map<string, Perm[]>();
    for (const p of permissions) g.set(p.owner, [...(g.get(p.owner) ?? []), p]);
    return [...g.entries()];
  }, [permissions]);
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <Modal open onClose={onClose} size="lg" title="Create custom role" description="Least privilege: grant only what the job needs. You can only grant permissions you hold."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={async () => { const ok = await run(() => apiFetch("/roles", { body: { key, name, description, permissions: [...selected] } }), { success: "Role created" }); if (ok) onClose(); }}>Create role</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="role-name" label="Name" required>{(a) => <Input {...a} value={name} onChange={(e) => { setName(e.target.value); setKey(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")); }} />}</FormField>
          <FormField id="role-key" label="Key" required hint="lowercase_with_underscores">{(a) => <Input {...a} value={key} onChange={(e) => setKey(e.target.value)} />}</FormField>
        </div>
        <FormField id="role-desc" label="Description">{(a) => <Textarea {...a} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormField>
        <div className="max-h-80 space-y-4 overflow-y-auto rounded-md border border-border p-3">
          {grouped.map(([owner, perms]) => (
            <fieldset key={owner} className="space-y-1.5">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted">{owner}</legend>
              {perms.map((p) => (
                <Checkbox key={p.key} checked={selected.has(p.key)} onChange={() => toggle(p.key)} label={<span className="font-mono text-xs">{p.key}</span>} description={`${p.description}${p.risk === "high" || p.risk === "critical" ? ` · ${p.risk} risk` : ""}`} />
              ))}
            </fieldset>
          ))}
        </div>
      </div>
    </Modal>
  );
}
