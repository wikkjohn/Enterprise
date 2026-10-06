"use client";

import Link from "next/link";
import { useState } from "react";
import { Ban, CheckCircle2, KeyRound, OctagonX, Plus, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CodeBlock, DataTable, FormField, Input, KeyValueList, Modal, Select, Switch, TabPanel, Tabs, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type AgentGovernanceService, type BindingView } from "@eaop/module-agent-governance";
import { ActionButton, useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { ACTION_TYPES, AG, EffectBadge, ENVIRONMENTS, fmtNum, opts, RiskBadge, SENSITIVITY, StatusPill } from "./common";
import { type MemberOption } from "./inventory";

export type AgentDetail = Awaited<ReturnType<AgentGovernanceService["getAgent"]>>;
export interface ConnectorOption { id: string; name: string; type: string }
export interface DetailPerms { manage: boolean; suspend: boolean; policyManage: boolean; policyRead: boolean; incident: boolean; audit: boolean }

export function AgentDetailView({ agent: a, perms, connectors, members, viewerId }: { agent: AgentDetail; perms: DetailPerms; connectors: ConnectorOption[]; members: MemberOption[]; viewerId: string }) {
  const [tab, setTab] = useState("overview");
  const [kill, setKill] = useState(false);
  const stopped = a.status === "suspended" || a.quarantined;
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "permissions", label: "Permissions", badge: a.canSeeBindings ? <Badge>{a.bindings.filter((b) => b.status === "active").length}</Badge> : undefined },
    { value: "identities", label: "Identities", badge: <Badge>{a.identities.filter((i) => i.status === "active").length}</Badge> },
    { value: "risk", label: "Risk" },
    { value: "activity", label: "Activity" },
    { value: "governance", label: "Reviews & history" },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={a.status} quarantined={a.quarantined} />
        <RiskBadge band={a.riskBand} score={a.riskScore} />
        <Badge>{a.environment}</Badge>
        <Badge>{a.autonomyLevel.replace("_", " ")}</Badge>
        {a.discoveredVia !== "manual" && <Badge tone="info">discovered via {a.discoveredVia}</Badge>}
        <span className="flex-1" />
        {perms.manage && !stopped && a.status !== "approved" && a.status !== "retired" && (
          a.createdBy === viewerId
            ? <span className="text-xs text-muted">You registered this agent, so someone else must approve it.</span>
            : <ActionButton path={`${AG}/agents/${a.id}/status`} body={{ status: "approved" }} success="Agent approved" leftIcon={<CheckCircle2 className="size-4" />} disabled={!a.ownerUserId} title={a.ownerUserId ? undefined : "Assign an owner first"}>Approve</ActionButton>
        )}
        {perms.manage && a.status === "approved" && <ActionButton variant="secondary" path={`${AG}/agents/${a.id}/status`} body={{ status: "restricted" }} success="Agent restricted to read-only" confirm={{ title: `Restrict ${a.name}?`, message: "The agent will be limited to READ actions until approved again.", tone: "default", confirmLabel: "Restrict" }}>Restrict</ActionButton>}
        {perms.manage && perms.suspend && stopped && <ActionButton variant="secondary" path={`${AG}/agents/${a.id}/status`} body={{ status: "approved" }} success="Agent reinstated" leftIcon={<Undo2 className="size-4" />} confirm={{ title: `Reinstate ${a.name}?`, message: "Lifts the suspension/quarantine. Revoked credentials stay revoked and disabled bindings stay disabled — re-issue them deliberately.", tone: "default", confirmLabel: "Reinstate" }}>Reinstate</ActionButton>}
        {perms.manage && a.status !== "retired" && <ActionButton variant="ghost" path={`${AG}/agents/${a.id}/status`} body={{ status: "retired" }} success="Agent retired" confirm={{ title: `Retire ${a.name}?`, message: "Retired agents can never act or receive credentials.", requireText: a.name, confirmLabel: "Retire" }}>Retire</ActionButton>}
        {perms.suspend && a.status !== "retired" && <Button variant="danger" leftIcon={<OctagonX className="size-4" />} onClick={() => setKill(true)}>Kill switch</Button>}
      </div>
      <Tabs ariaLabel="Agent sections" idPrefix="agent" value={tab} onChange={setTab} items={tabs} />
      <TabPanel idPrefix="agent" value="overview" selected={tab}><Overview a={a} members={members} canManage={perms.manage} /></TabPanel>
      <TabPanel idPrefix="agent" value="permissions" selected={tab}><Permissions a={a} perms={perms} connectors={connectors} /></TabPanel>
      <TabPanel idPrefix="agent" value="identities" selected={tab}><Identities a={a} perms={perms} /></TabPanel>
      <TabPanel idPrefix="agent" value="risk" selected={tab}><Risk a={a} /></TabPanel>
      <TabPanel idPrefix="agent" value="activity" selected={tab}><Activity a={a} audit={perms.audit} /></TabPanel>
      <TabPanel idPrefix="agent" value="governance" selected={tab}><Governance a={a} perms={perms} members={members} /></TabPanel>
      {kill && <KillSwitch a={a} connectors={connectors} onClose={() => setKill(false)} />}
    </div>
  );
}

function Overview({ a, members, canManage }: { a: AgentDetail; members: MemberOption[]; canManage: boolean }) {
  const [edit, setEdit] = useState(false);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Inventory record" actions={canManage ? <Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Edit</Button> : undefined} />
        <CardBody>
          <KeyValueList columns={2} items={[
            { key: "owner", label: "Owner", value: a.ownerName ?? <span className="text-danger">No owner</span> },
            { key: "dept", label: "Department", value: a.department ?? "—" },
            { key: "purpose", label: "Business purpose", value: a.businessPurpose || "—" },
            { key: "desc", label: "Description", value: a.description || "—" },
            { key: "env", label: "Environment", value: a.environment },
            { key: "prov", label: "Provider / model", value: `${a.provider ?? "—"}${a.model ? ` / ${a.model}` : ""}` },
            { key: "aut", label: "Autonomy", value: a.autonomyLevel.replace("_", " ") },
            { key: "riskcat", label: "Risk category", value: a.riskCategory },
            { key: "sys", label: "Connected systems", value: a.connectedSystems.join(", ") || "—" },
            { key: "ext", label: "External id", value: a.externalId ?? "—" },
            { key: "last", label: "Last activity", value: <LocalDate value={a.lastActivityAt} /> },
            { key: "reg", label: "Registered", value: <LocalDate value={a.createdAt} /> },
            { key: "rev", label: "Last review", value: <LocalDate value={a.lastReviewAt} dateOnly /> },
            { key: "next", label: "Next review", value: <LocalDate value={a.nextReviewAt} dateOnly /> },
          ]} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Decisions (30 days)" />
        <CardBody className="space-y-2 text-sm">
          {["ALLOW", "REQUIRE_APPROVAL", "ESCALATE", "DENY"].map((e) => <div key={e} className="flex items-center justify-between"><EffectBadge effect={e} /><span>{fmtNum(a.decisions30d[e] ?? 0)}</span></div>)}
          <p className="pt-2 text-xs text-muted">{a.pendingApprovals} pending approval(s) · {a.openIncidents} open incident(s)</p>
          {a.blockedConnectorIds.length > 0 && <p className="text-xs text-danger">{a.blockedConnectorIds.length} connector(s) blocked by the kill switch.</p>}
        </CardBody>
      </Card>
      {edit && <EditAgent a={a} members={members} onClose={() => setEdit(false)} />}
    </div>
  );
}

function EditAgent({ a, members, onClose }: { a: AgentDetail; members: MemberOption[]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ ownerUserId: a.ownerUserId ?? "", department: a.department ?? "", businessPurpose: a.businessPurpose, description: a.description, environment: a.environment, autonomyLevel: a.autonomyLevel, connectedSystems: a.connectedSystems.join(", "), changeNote: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ownerOpts = [{ value: "", label: "No owner" }, ...members.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` }))];
  if (a.ownerUserId && !members.some((m) => m.userId === a.ownerUserId)) ownerOpts.push({ value: a.ownerUserId, label: a.ownerName ?? a.ownerUserId });
  const save = async () => {
    const ok = await run(() => apiFetch(`${AG}/agents/${a.id}`, { method: "PATCH", body: { ...f, ownerUserId: f.ownerUserId || null, department: f.department || null, connectedSystems: f.connectedSystems.split(",").map((s) => s.trim()).filter(Boolean), changeNote: f.changeNote || undefined } }), { success: "Agent updated (new version recorded)" });
    if (ok !== undefined) onClose();
  };
  return (
    <Modal open onClose={onClose} size="lg" title={`Edit ${a.name}`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="e-owner" label="Owner">{(x) => <Select {...x} value={f.ownerUserId} onChange={set("ownerUserId")} options={ownerOpts} />}</FormField>
        <FormField id="e-dept" label="Department">{(x) => <Input {...x} value={f.department} onChange={set("department")} />}</FormField>
        <FormField id="e-env" label="Environment">{(x) => <Select {...x} value={f.environment} onChange={set("environment")} options={opts(ENVIRONMENTS)} />}</FormField>
        <FormField id="e-aut" label="Autonomy">{(x) => <Select {...x} value={f.autonomyLevel} onChange={set("autonomyLevel")} options={opts(["assistive", "supervised", "semi_autonomous", "autonomous"])} />}</FormField>
        <FormField id="e-sys" label="Connected systems" className="sm:col-span-2">{(x) => <Input {...x} value={f.connectedSystems} onChange={set("connectedSystems")} />}</FormField>
        <FormField id="e-purpose" label="Business purpose" className="sm:col-span-2">{(x) => <Textarea {...x} rows={2} value={f.businessPurpose} onChange={set("businessPurpose")} />}</FormField>
        <FormField id="e-note" label="Change note" className="sm:col-span-2">{(x) => <Input {...x} value={f.changeNote} onChange={set("changeNote")} />}</FormField>
      </div>
    </Modal>
  );
}

function Permissions({ a, perms, connectors }: { a: AgentDetail; perms: DetailPerms; connectors: ConnectorOption[] }) {
  const [add, setAdd] = useState(false);
  const { run } = useMutation();
  if (!a.canSeeBindings) return <p className="text-sm text-muted">Viewing permission bindings requires agent.policy.read.</p>;
  const cname = (id: string | null) => (id ? connectors.find((c) => c.id === id)?.name ?? `connector ${id.slice(0, 8)}` : null);
  const columns: Array<DataTableColumn<BindingView>> = [
    { key: "t", header: "Action", cell: (b) => <Badge>{b.actionType}</Badge> },
    { key: "s", header: "System / resource", cell: (b) => <span className="font-mono text-xs">{cname(b.connectorId) ?? b.system} / {b.resource}</span> },
    { key: "e", header: "Environment", hideOnMobile: true, cell: (b) => b.environment },
    { key: "d", header: "Max data", hideOnMobile: true, cell: (b) => b.maxDataSensitivity },
    { key: "f", header: "Financial limit", hideOnMobile: true, align: "right", cell: (b) => (b.financialLimit == null ? "—" : fmtNum(b.financialLimit)) },
    { key: "x", header: "Scope", hideOnMobile: true, cell: (b) => <span className="text-xs text-muted">{[b.requiresApproval && "approval", b.timeWindow && "time window", b.conditions && "conditions", b.expiresAt && "expires"].filter(Boolean).join(" · ") || "—"}</span> },
    { key: "st", header: "Status", cell: (b) => (perms.policyManage || (perms.suspend && b.status === "active")
      ? <Switch checked={b.status === "active"} aria-label={`Binding ${b.actionType} ${b.system} active`} onCheckedChange={(on) => void run(() => apiFetch(`${AG}/bindings/${b.id}/status`, { body: { status: on ? "active" : "disabled" } }), { success: on ? "Binding enabled" : "Binding disabled" })} />
      : <StatusPill status={b.status} />) },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Permission bindings" description="Least privilege: an agent can do nothing that a binding does not grant. Organization policies (kind agent_action) can only make a decision stricter." actions={perms.policyManage ? <Button size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setAdd(true)}>Add binding</Button> : undefined} />
        <DataTable columns={columns} rows={a.bindings} getRowId={(b) => b.id} caption="Permission bindings" emptyState={<p className="p-6 text-center text-sm text-muted">No bindings — every action is denied.</p>} />
      </Card>
      {perms.policyRead && <Simulator agentId={a.id} />}
      {add && <AddBinding agentId={a.id} connectors={connectors} onClose={() => setAdd(false)} />}
    </div>
  );
}

function AddBinding({ agentId, connectors, onClose }: { agentId: string; connectors: ConnectorOption[]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ actionType: "READ", system: "", connectorId: "", resource: "*", environment: "any", maxDataSensitivity: "internal", financialLimit: "", requiresApproval: false, description: "", windowOn: false, days: "1,2,3,4,5", startHour: "9", endHour: "17", timeZone: "UTC", conditions: "", expiresAt: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    let conditions: unknown;
    if (f.conditions.trim()) {
      try { conditions = JSON.parse(f.conditions); } catch { conditions = "__invalid__"; }
    }
    const body = {
      actionType: f.actionType, system: f.system.trim() || "*", connectorId: f.connectorId || null, resource: f.resource.trim() || "*", environment: f.environment, maxDataSensitivity: f.maxDataSensitivity,
      financialLimit: f.financialLimit ? Number(f.financialLimit) : null, requiresApproval: f.requiresApproval, description: f.description,
      timeWindow: f.windowOn ? { days: f.days.split(",").map((d) => Number(d.trim())).filter(Boolean), startHour: Number(f.startHour), endHour: Number(f.endHour), timeZone: f.timeZone || "UTC" } : null,
      ...(conditions !== undefined ? { conditions } : {}), expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null,
    };
    if (await run(() => apiFetch(`${AG}/agents/${agentId}/bindings`, { body }), { success: "Binding added (new version recorded)" })) onClose();
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Add permission binding" description="Grant the narrowest scope the agent needs." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Add binding</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="b-type" label="Action type" hint="WRITE also covers CREATE and UPDATE">{(x) => <Select {...x} value={f.actionType} onChange={set("actionType")} options={opts(ACTION_TYPES)} />}</FormField>
        <FormField id="b-conn" label="Connector (optional)" hint="Pins the binding to one shared connector">{(x) => <Select {...x} value={f.connectorId} onChange={set("connectorId")} options={[{ value: "", label: "Any (match by system)" }, ...connectors.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))]} />}</FormField>
        <FormField id="b-sys" label="System" hint='e.g. stripe, salesforce, or "*"'>{(x) => <Input {...x} value={f.system} onChange={set("system")} disabled={!!f.connectorId} placeholder={f.connectorId ? "From connector" : "*"} />}</FormField>
        <FormField id="b-res" label="Resource" hint='Glob, e.g. "Charge/*"'>{(x) => <Input {...x} value={f.resource} onChange={set("resource")} />}</FormField>
        <FormField id="b-env" label="Environment">{(x) => <Select {...x} value={f.environment} onChange={set("environment")} options={opts(["any", ...ENVIRONMENTS])} />}</FormField>
        <FormField id="b-sens" label="Max data sensitivity">{(x) => <Select {...x} value={f.maxDataSensitivity} onChange={set("maxDataSensitivity")} options={opts(SENSITIVITY)} />}</FormField>
        <FormField id="b-fin" label="Financial limit" hint="Amounts above this need approval">{(x) => <Input {...x} type="number" min={0} value={f.financialLimit} onChange={set("financialLimit")} />}</FormField>
        <FormField id="b-exp" label="Expires">{(x) => <Input {...x} type="date" value={f.expiresAt} onChange={set("expiresAt")} />}</FormField>
        <div className="flex items-center gap-2 sm:col-span-2"><Switch checked={f.requiresApproval} onCheckedChange={(v) => setF({ ...f, requiresApproval: v })} aria-label="Always require approval" /><span className="text-sm">Always require human approval</span></div>
        <div className="flex items-center gap-2 sm:col-span-2"><Switch checked={f.windowOn} onCheckedChange={(v) => setF({ ...f, windowOn: v })} aria-label="Restrict to a time window" /><span className="text-sm">Restrict to a time window</span></div>
        {f.windowOn && (
          <>
            <FormField id="b-days" label="Days (1=Mon … 7=Sun)">{(x) => <Input {...x} value={f.days} onChange={set("days")} />}</FormField>
            <FormField id="b-tz" label="Time zone">{(x) => <Input {...x} value={f.timeZone} onChange={set("timeZone")} />}</FormField>
            <FormField id="b-sh" label="From hour">{(x) => <Input {...x} type="number" min={0} max={23} value={f.startHour} onChange={set("startHour")} />}</FormField>
            <FormField id="b-eh" label="To hour">{(x) => <Input {...x} type="number" min={0} max={24} value={f.endHour} onChange={set("endHour")} />}</FormField>
          </>
        )}
        <FormField id="b-cond" label="Context conditions (optional, policy-engine JSON)" hint='e.g. {"field":"context.region","op":"eq","value":"EU"}' className="sm:col-span-2">{(x) => <Textarea {...x} rows={3} className="font-mono text-xs" value={f.conditions} onChange={set("conditions")} />}</FormField>
        <FormField id="b-desc" label="Description" className="sm:col-span-2">{(x) => <Input {...x} value={f.description} onChange={set("description")} />}</FormField>
      </div>
    </Modal>
  );
}

function Simulator({ agentId }: { agentId: string }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ actionType: "EXECUTE", action: "refund", system: "stripe", resource: "*", dataSensitivity: "internal", amount: "" });
  const [out, setOut] = useState<{ effect: string; reasons: string[]; policies: unknown[] } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    const r = await run(() => apiFetch<{ effect: string; reasons: string[]; policies: unknown[] }>(`${AG}/agents/${agentId}/simulate`, { body: { ...f, amount: f.amount ? Number(f.amount) : null } }), { refresh: false });
    if (r) setOut(r);
  };
  return (
    <Card>
      <CardHeader title="Decision simulator" description="Dry-run a request against this agent's bindings and your agent_action policies. Simulations are logged but never count as violations." />
      <CardBody className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <Select aria-label="Action type" value={f.actionType} onChange={set("actionType")} options={opts(ACTION_TYPES)} />
          <Input aria-label="Action" value={f.action} onChange={set("action")} placeholder="action" />
          <Input aria-label="System" value={f.system} onChange={set("system")} placeholder="system" />
          <Input aria-label="Resource" value={f.resource} onChange={set("resource")} placeholder="resource" />
          <Select aria-label="Data sensitivity" value={f.dataSensitivity} onChange={set("dataSensitivity")} options={opts(SENSITIVITY)} />
          <Input aria-label="Amount" type="number" value={f.amount} onChange={set("amount")} placeholder="amount" />
        </div>
        <Button size="sm" loading={pending} leftIcon={<ShieldCheck className="size-4" />} onClick={go}>Simulate</Button>
        {out && (
          <div className="space-y-1 rounded-md border border-border p-3 text-sm">
            <EffectBadge effect={out.effect} />
            <ul className="list-disc pl-5 text-muted">{out.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Identities({ a, perms }: { a: AgentDetail; perms: DetailPerms }) {
  const [issue, setIssue] = useState(false);
  const [ext, setExt] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Identities and credentials"
        description="Agent credentials live in the shared credential system: API keys are stored as hashes, other secrets in the shared secret store. Plaintext is never kept."
        actions={perms.manage && a.status !== "retired" ? <div className="flex gap-2"><Button size="sm" leftIcon={<KeyRound className="size-4" />} onClick={() => setIssue(true)}>Issue API key</Button><Button size="sm" variant="secondary" onClick={() => setExt(true)}>Record external identity</Button></div> : undefined}
      />
      <CardBody className="space-y-2">
        {a.identities.length === 0 && <p className="text-sm text-muted">No identities. The agent cannot authenticate.</p>}
        {a.identities.map((i) => (
          <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{i.kind.replace("_", " ")}</span> <span className="font-mono text-xs text-muted">{i.fingerprint ?? i.subject ?? ""}</span>
              <span className="block text-xs text-muted">{i.scopes.length ? `scopes: ${i.scopes.join(", ")}` : "no scopes"} · {i.environment ?? "—"} · expires <LocalDate value={i.expiresAt} dateOnly /> · last used <LocalDate value={i.lastUsedAt} />{i.hasSecret ? " · secret in secret store" : ""}</span>
            </span>
            <span className="flex items-center gap-2">
              <StatusPill status={i.status} />
              {i.status === "active" && (perms.manage || perms.suspend) && <ActionButton size="sm" variant="ghost" path={`${AG}/identities/${i.id}/revoke`} success="Credential revoked" confirm={{ title: "Revoke this credential?", message: "The agent can no longer authenticate with it. This cannot be undone." , confirmLabel: "Revoke" }}>Revoke</ActionButton>}
            </span>
          </div>
        ))}
      </CardBody>
      {issue && <IssueKey agentId={a.id} onClose={() => setIssue(false)} />}
      {ext && <ExternalIdentity agentId={a.id} onClose={() => setExt(false)} />}
    </Card>
  );
}

function IssueKey({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [scopes, setScopes] = useState("integration.execute, integration.connector.use, connector.use");
  const [days, setDays] = useState("90");
  const [key, setKey] = useState<string | null>(null);
  const go = async () => {
    const r = await run(() => apiFetch<{ key: string }>(`${AG}/agents/${agentId}/credentials`, { body: { scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean), expiresInDays: Number(days) } }), { success: "API key issued" });
    if (r) setKey(r.key);
  };
  return (
    <Modal open onClose={onClose} title="Issue an agent API key" description="Scopes are the most the agent can ever do; bindings and policies narrow it further. You can only delegate permissions you hold." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{key ? "Done" : "Cancel"}</Button>{!key && <Button loading={pending} onClick={go}>Issue key</Button>}</div>}>
      {key ? (
        <div className="space-y-2 text-sm">
          <p className="rounded-md border border-warning/40 bg-warning-subtle p-2 text-warning">Copy this key now. It is shown once and only its hash is stored.</p>
          <CodeBlock code={key} language="text" />
          <p className="text-muted">The agent sends it as <code>Authorization: Bearer …</code> to <code>/api/v1/m/agent-governance/runtime/*</code> and to the Integration tool gateway.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          <FormField id="k-scopes" label="Scopes (comma-separated permission keys)">{(x) => <Input {...x} value={scopes} onChange={(e) => setScopes(e.target.value)} />}</FormField>
          <FormField id="k-days" label="Expires in (days)">{(x) => <Input {...x} type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} />}</FormField>
        </div>
      )}
    </Modal>
  );
}

function ExternalIdentity({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ kind: "oauth_client", issuer: "", subject: "", fingerprint: "", scopes: "", secret: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const go = async () => {
    if (await run(() => apiFetch(`${AG}/agents/${agentId}/identities`, { body: { kind: f.kind, issuer: f.issuer || undefined, subject: f.subject, fingerprint: f.fingerprint || undefined, scopes: f.scopes.split(",").map((s) => s.trim()).filter(Boolean), secret: f.secret || undefined } }), { success: "Identity recorded" })) onClose();
  };
  return (
    <Modal open onClose={onClose} title="Record an external identity" description="OAuth clients, certificates or IdP subjects issued outside the platform. A secret, if given, goes to the shared secret store; only a reference is kept." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.subject.trim()} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="x-kind" label="Kind">{(x) => <Select {...x} value={f.kind} onChange={set("kind")} options={opts(["oauth_client", "certificate", "external"])} />}</FormField>
        <FormField id="x-sub" label="Subject / client id" required>{(x) => <Input {...x} value={f.subject} onChange={set("subject")} />}</FormField>
        <FormField id="x-iss" label="Issuer">{(x) => <Input {...x} value={f.issuer} onChange={set("issuer")} />}</FormField>
        <FormField id="x-fp" label="Fingerprint">{(x) => <Input {...x} value={f.fingerprint} onChange={set("fingerprint")} />}</FormField>
        <FormField id="x-scopes" label="Scopes" className="sm:col-span-2">{(x) => <Input {...x} value={f.scopes} onChange={set("scopes")} />}</FormField>
        <FormField id="x-secret" label="Secret (optional)" hint="Stored encrypted in the shared secret store" className="sm:col-span-2">{(x) => <Input {...x} type="password" autoComplete="off" value={f.secret} onChange={set("secret")} />}</FormField>
      </div>
    </Modal>
  );
}

function Risk({ a }: { a: AgentDetail }) {
  const { run, pending } = useMutation();
  if (!a.risk) return <p className="text-sm text-muted">Not scored yet.</p>;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">Risk score {fmtNum(a.risk.score)} / 100 <RiskBadge band={a.risk.band} /></span>} description={a.risk.explanation} actions={<Button size="sm" variant="secondary" loading={pending} leftIcon={<RefreshCw className="size-4" />} onClick={() => void run(() => apiFetch(`${AG}/agents/${a.id}/risk`, { method: "POST" }), { success: "Risk recomputed" })}>Recompute</Button>} />
      <CardBody>
        <table className="w-full text-sm">
          <caption className="sr-only">Risk components</caption>
          <thead><tr className="text-left text-xs text-muted"><th className="py-1">Factor</th><th>Rating</th><th className="hidden sm:table-cell">Weight</th><th>Points</th><th className="hidden md:table-cell">Evidence</th></tr></thead>
          <tbody>
            {(a.risk.components as Array<{ factor: string; label: string; rating: number; weight: number; points: number; assumed: boolean; evidence: string }>).map((c) => (
              <tr key={c.factor} className="border-t border-border">
                <td className="py-1.5">{c.label}{c.assumed && <Badge className="ml-1" tone="warning">assumed</Badge>}</td>
                <td><span className="inline-flex gap-0.5" aria-label={`${c.rating} of 5`}>{[1, 2, 3, 4, 5].map((n) => <span key={n} className={`h-2 w-3 rounded-sm ${n <= c.rating ? "bg-accent" : "bg-surface-hover"}`} />)}</span></td>
                <td className="hidden sm:table-cell">{Math.round(c.weight * 100)}%</td>
                <td>{fmtNum(c.points)}</td>
                <td className="hidden text-xs text-muted md:table-cell">{c.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Model {a.risk.modelVersion} · computed <LocalDate value={a.risk.computedAt} /></p>
      </CardBody>
    </Card>
  );
}

function Activity({ a, audit }: { a: AgentDetail; audit: boolean }) {
  if (!audit) return <p className="text-sm text-muted">The activity timeline requires agent.audit.read.</p>;
  return (
    <Card>
      <CardHeader title="Recent activity" actions={<Link className="text-sm text-accent hover:underline" href={`${AG}/activity?agentId=${a.id}`}>Open replay →</Link>} />
      <CardBody className="space-y-1">
        {a.recentActivity.length === 0 && <p className="text-sm text-muted">No activity yet.</p>}
        {a.recentActivity.map((x) => (
          <div key={x.id} className="flex flex-wrap items-center gap-2 border-b border-border py-1.5 text-sm last:border-0">
            <span className="w-40 shrink-0 text-xs text-muted"><LocalDate value={x.occurredAt} /></span>
            <Badge>{x.kind.replace(/_/g, " ")}</Badge>
            {x.decision && <EffectBadge effect={x.decision} />}
            <span className="min-w-0 flex-1 truncate">{x.summary}</span>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function Governance({ a, perms, members }: { a: AgentDetail; perms: DetailPerms; members: MemberOption[] }) {
  const [incident, setIncident] = useState(false);
  const [review, setReview] = useState(false);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Reviews" actions={perms.manage ? <Button size="sm" variant="secondary" onClick={() => setReview(true)}>Schedule review</Button> : undefined} />
        <CardBody className="space-y-2 text-sm">
          {a.reviews.length === 0 && <p className="text-muted">No reviews. One is scheduled automatically when the agent is approved.</p>}
          {a.reviews.map((r) => <div key={r.id} className="flex items-center justify-between"><span>Due <LocalDate value={r.dueAt} dateOnly />{r.outcome ? ` · ${r.outcome.replace("_", " ")}` : ""}</span><StatusPill status={r.status} /></div>)}
          <Link className="text-accent hover:underline" href={`${AG}/reviews`}>All reviews →</Link>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Incidents" actions={perms.incident ? <Button size="sm" variant="secondary" onClick={() => setIncident(true)}>Open incident</Button> : undefined} />
        <CardBody className="space-y-2 text-sm">
          {a.incidents.length === 0 && <p className="text-muted">No incidents.</p>}
          {a.incidents.map((i) => <Link key={i.id} href={`${AG}/incidents?focus=${i.id}`} className="flex items-center justify-between hover:underline"><span>{i.title}</span><StatusPill status={i.status} /></Link>)}
        </CardBody>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader title="Versions" description="Every change to the agent or its bindings creates a snapshot." />
        <CardBody className="space-y-1 text-sm">
          {a.versions.map((v) => <div key={v.version} className="flex gap-3"><span className="w-10 font-mono text-xs text-muted">v{v.version}</span><span className="flex-1">{v.changeNote}</span><span className="text-xs text-muted"><LocalDate value={v.createdAt} /></span></div>)}
        </CardBody>
      </Card>
      {incident && <NewIncident agentId={a.id} onClose={() => setIncident(false)} />}
      {review && <NewReview agentId={a.id} members={members} onClose={() => setReview(false)} />}
    </div>
  );
}

function NewIncident({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ severity: "medium", title: "", description: "" });
  const go = async () => { if (await run(() => apiFetch(`${AG}/agents/${agentId}/incidents`, { body: f }), { success: "Incident opened" })) onClose(); };
  return (
    <Modal open onClose={onClose} title="Open an incident" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={f.title.trim().length < 3} onClick={go}>Open</Button></div>}>
      <div className="grid gap-3">
        <FormField id="i-sev" label="Severity">{(x) => <Select {...x} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} options={opts(["low", "medium", "high", "critical"])} />}</FormField>
        <FormField id="i-title" label="Title" required>{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
        <FormField id="i-desc" label="Description">{(x) => <Textarea {...x} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

function NewReview({ agentId, members, onClose }: { agentId: string; members: MemberOption[]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState("");
  const go = async () => { if (await run(() => apiFetch(`${AG}/agents/${agentId}/reviews`, { body: { dueAt: new Date(due).toISOString(), reviewOwnerUserId: owner || undefined } }), { success: "Review scheduled" })) onClose(); };
  return (
    <Modal open onClose={onClose} title="Schedule a review" description="The review owner is reminded through notifications 7 days before it is due." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!due} onClick={go}>Schedule</Button></div>}>
      <div className="grid gap-3">
        <FormField id="r-due" label="Due date" required>{(x) => <Input {...x} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</FormField>
        <FormField id="r-owner" label="Review owner" hint="Defaults to the agent owner">{(x) => <Select {...x} value={owner} onChange={(e) => setOwner(e.target.value)} options={[{ value: "", label: "Agent owner" }, ...members.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` }))]} />}</FormField>
      </div>
    </Modal>
  );
}

const KILL_ACTIONS = [
  { value: "suspend", label: "Suspend agent", help: "Status → suspended. Permissions vanish on the next request; pending approvals and active sessions are cancelled." },
  { value: "quarantine", label: "Quarantine", help: "Suspend + revoke every credential + disable every binding. Use when the agent or its credentials may be compromised." },
  { value: "revoke_credentials", label: "Revoke credentials", help: "Revoke every active API key and external secret. The agent can no longer authenticate." },
  { value: "disable_capability", label: "Disable one capability", help: "Disable a single permission binding." },
  { value: "block_connector", label: "Block connector access", help: "Deny every action through one shared connector, regardless of bindings." },
];

function KillSwitch({ a, connectors, onClose }: { a: AgentDetail; connectors: ConnectorOption[]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [action, setAction] = useState("suspend");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [bindingId, setBindingId] = useState(a.bindings.find((b) => b.status === "active")?.id ?? "");
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const meta = KILL_ACTIONS.find((k) => k.value === action)!;
  const ready = reason.trim().length >= 5 && confirm === a.name && (action !== "disable_capability" || bindingId) && (action !== "block_connector" || connectorId);
  const go = async () => {
    const r = await run(() => apiFetch<{ incidentId: string }>(`${AG}/agents/${a.id}/emergency`, { body: { action, reason, confirm, ...(action === "disable_capability" ? { bindingId } : {}), ...(action === "block_connector" ? { connectorId } : {}) } }), { success: "Emergency action applied — incident opened" });
    if (r) onClose();
  };
  return (
    <Modal open alert onClose={onClose} title={<span className="flex items-center gap-2 text-danger"><Ban className="size-5" />Kill switch — {a.name}</span>} description="Emergency controls take effect immediately, are written to the audit log and open an incident." footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={pending} disabled={!ready} onClick={go}>Apply {meta.label.toLowerCase()}</Button></div>}>
      <div className="grid gap-3">
        <FormField id="k-action" label="Action">{(x) => <Select {...x} value={action} onChange={(e) => setAction(e.target.value)} options={KILL_ACTIONS.map((k) => ({ value: k.value, label: k.label }))} />}</FormField>
        <p className="text-sm text-muted">{meta.help}</p>
        {action === "disable_capability" && <FormField id="k-binding" label="Binding">{(x) => <Select {...x} value={bindingId} onChange={(e) => setBindingId(e.target.value)} options={a.bindings.filter((b) => b.status === "active").map((b) => ({ value: b.id, label: `${b.actionType} ${b.system}/${b.resource}` }))} placeholder="No active bindings" />}</FormField>}
        {action === "block_connector" && <FormField id="k-conn" label="Connector">{(x) => <Select {...x} value={connectorId} onChange={(e) => setConnectorId(e.target.value)} options={connectors.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))} placeholder="No connectors visible" />}</FormField>}
        <FormField id="k-reason" label="Reason" required hint="At least 5 characters; recorded in the audit log and the incident">{(x) => <Textarea {...x} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</FormField>
        <FormField id="k-confirm" label={<>Type <span className="font-mono">{a.name}</span> to confirm</>} required>{(x) => <Input {...x} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</FormField>
      </div>
    </Modal>
  );
}
