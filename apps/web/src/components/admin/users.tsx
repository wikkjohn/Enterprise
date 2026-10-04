"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Badge, Button, CodeBlock, DataTable, DropdownMenu, FilterBar, FormField, Input, Modal, Select, StatusBadge, type DataTableColumn } from "@eaop/design-system";
import { type MemberView } from "@eaop/organizations";
import { apiFetch } from "@/lib/client";
import { useMutation } from "@/components/actions";

interface RoleOption {
  key: string;
  name: string;
}

export function UsersAdmin({
  members,
  invitations,
  roles,
  canInvite,
  canManage,
  canAssign,
  selfId,
}: {
  members: MemberView[];
  invitations: Array<{ id: string; email: string; roleKeys: string[]; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }>;
  roles: RoleOption[];
  canInvite: boolean;
  canManage: boolean;
  canAssign: boolean;
  selfId: string;
}) {
  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<MemberView | null>(null);
  const { run } = useMutation();
  const filtered = members.filter((m) => !query || `${m.name} ${m.email}`.toLowerCase().includes(query.toLowerCase()));

  const columns: Array<DataTableColumn<MemberView>> = [
    { key: "name", header: "Name", sortable: true, sortValue: (m) => m.name, cell: (m) => (<div><div className="font-medium">{m.name}</div><div className="text-xs text-muted">{m.email}</div></div>) },
    { key: "roles", header: "Roles", cell: (m) => (<div className="flex flex-wrap gap-1">{m.roles.map((r) => <Badge key={r.id} tone="accent">{r.name}{r.scopeType ? ` · ${r.scopeId}` : ""}</Badge>)}</div>) },
    { key: "status", header: "Status", sortable: true, sortValue: (m) => m.status, cell: (m) => <StatusBadge status={m.status} /> },
    { key: "mfa", header: "MFA", hideOnMobile: true, cell: (m) => (m.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>) },
    { key: "last", header: "Last sign-in", hideOnMobile: true, sortable: true, sortValue: (m) => m.lastLoginAt ?? "", cell: (m) => (m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : "Never") },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (m) =>
        m.userId === selfId || (!canManage && !canAssign) ? null : (
          <DropdownMenu
            ariaLabel={`Actions for ${m.name}`}
            trigger={(p) => <Button {...p} size="sm" variant="ghost">Manage</Button>}
            items={[
              ...(canAssign ? [{ id: "assign", label: "Assign role…", onSelect: () => setAssignFor(m) }] : []),
              ...(canAssign
                ? m.roles.map((r) => ({ id: `revoke-${r.id}`, label: `Revoke ${r.name}`, onSelect: () => void run(() => apiFetch(`/role-assignments/${r.id}`, { method: "DELETE" }), { success: "Role revoked" }) }))
                : []),
              ...(canManage
                ? [
                    m.status === "suspended"
                      ? { id: "reactivate", label: "Reactivate", separatorBefore: true, onSelect: () => void run(() => apiFetch(`/members/${m.membershipId}`, { method: "PATCH", body: { status: "active" } }), { success: "Member reactivated" }) }
                      : { id: "suspend", label: "Suspend", tone: "danger" as const, separatorBefore: true, onSelect: () => void run(() => apiFetch(`/members/${m.membershipId}`, { method: "PATCH", body: { status: "suspended" } }), { success: "Member suspended" }) },
                    { id: "remove", label: "Remove from organization", tone: "danger" as const, onSelect: () => void run(() => apiFetch(`/members/${m.membershipId}`, { method: "PATCH", body: { status: "removed" } }), { success: "Member removed" }) },
                  ]
                : []),
            ]}
          />
        ),
    },
  ];

  const pending = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > new Date());

  return (
    <div className="space-y-6">
      <FilterBar onSearchChange={setQuery} searchPlaceholder="Search people" actions={canInvite ? <Button leftIcon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)}>Invite user</Button> : undefined} />
      <DataTable columns={columns} rows={filtered} getRowId={(m) => m.membershipId} caption="Organization members" />
      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Pending invitations</h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {pending.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span>{i.email} <span className="text-muted">· {i.roleKeys.join(", ")} · expires {new Date(i.expiresAt).toLocaleDateString()}</span></span>
                {canInvite && <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch(`/invitations/${i.id}`, { method: "DELETE" }), { success: "Invitation revoked" })}>Revoke</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} roles={roles} />
      {assignFor && <AssignRoleModal member={assignFor} roles={roles} onClose={() => setAssignFor(null)} />}
    </div>
  );
}

function InviteModal({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: RoleOption[] }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("standard_user");
  const [link, setLink] = useState<string | null>(null);
  const { run, pending } = useMutation();
  const close = () => {
    setLink(null);
    setEmail("");
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite user"
      footer={
        link ? <Button onClick={close}>Done</Button> : (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button loading={pending} onClick={async () => {
              const r = await run(() => apiFetch<{ acceptUrl: string }>("/invitations", { body: { email, roleKeys: [role] } }), { success: "Invitation created" });
              if (r) setLink(r.acceptUrl);
            }}>Send invitation</Button>
          </>
        )
      }
    >
      {link ? (
        <div className="space-y-3 text-sm">
          <p>Share this single-use link with {email}. It expires in 7 days and is shown only once.</p>
          <CodeBlock code={link} wrap />
        </div>
      ) : (
        <div className="space-y-4">
          <FormField id="invite-email" label="Email" required>{(a) => <Input {...a} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</FormField>
          <FormField id="invite-role" label="Role" hint="You can only grant roles whose permissions you hold.">
            {(a) => <Select {...a} value={role} onChange={(e) => setRole(e.target.value)} options={roles.map((r) => ({ value: r.key, label: r.name }))} />}
          </FormField>
        </div>
      )}
    </Modal>
  );
}

function AssignRoleModal({ member, roles, onClose }: { member: MemberView; roles: RoleOption[]; onClose: () => void }) {
  const [role, setRole] = useState(roles[0]?.key ?? "");
  const [scopeType, setScopeType] = useState<"" | "module" | "resource">("");
  const [scopeId, setScopeId] = useState("");
  const { run, pending } = useMutation();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign role to ${member.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={pending} onClick={async () => {
            const ok = await run(() => apiFetch("/role-assignments", { body: { membershipId: member.membershipId, roleKey: role, ...(scopeType ? { scopeType, scopeId } : {}) } }), { success: "Role assigned" });
            if (ok) onClose();
          }}>Assign</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField id="assign-role" label="Role">{(a) => <Select {...a} value={role} onChange={(e) => setRole(e.target.value)} options={roles.map((r) => ({ value: r.key, label: r.name }))} />}</FormField>
        <FormField id="assign-scope" label="Scope" hint="Organization-wide, limited to one module, or to one resource (e.g. connector:<id>).">
          {(a) => <Select {...a} value={scopeType} onChange={(e) => setScopeType(e.target.value as "")} options={[{ value: "", label: "Organization-wide" }, { value: "module", label: "Module" }, { value: "resource", label: "Resource" }]} />}
        </FormField>
        {scopeType && <FormField id="assign-scope-id" label={scopeType === "module" ? "Module id" : "Resource (type:id)"}>{(a) => <Input {...a} value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder={scopeType === "module" ? "workflow_intelligence" : "connector:…"} />}</FormField>}
      </div>
    </Modal>
  );
}
