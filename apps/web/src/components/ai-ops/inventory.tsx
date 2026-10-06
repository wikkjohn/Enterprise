"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Card, CardBody, CardHeader, DataTable, FormField, Input, KeyValueList, Modal, Select, Textarea, type DataTableColumn } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { useMutation } from "@/components/actions";
import { LocalDate } from "@/components/local-date";
import { apiFetch } from "@/lib/client";
import { human, num, OPS, opts, StatusPill, usd } from "./common";

type Tool = Awaited<ReturnType<AiOpsService["listTools"]>>[number];
type ToolDetail = Awaited<ReturnType<AiOpsService["getTool"]>>;
type Vendor = Awaited<ReturnType<AiOpsService["listVendors"]>>[number];
type VendorDetail = Awaited<ReturnType<AiOpsService["getVendor"]>>;
type Member = { userId: string; name: string };

const TOOL_STATUSES = ["strategic", "approved", "experimental", "restricted", "retiring"] as const;
const REVIEW = ["not_started", "in_progress", "approved", "conditional", "rejected"] as const;
const VREVIEW = ["not_reviewed", "in_review", "approved", "conditional", "rejected"] as const;
const CATEGORIES = ["chat_assistant", "coding_assistant", "writing_assistant", "meeting_assistant", "search_knowledge", "analytics", "image_media", "customer_service", "sales", "model_api", "agent_platform", "automation", "other"] as const;
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function ToolList({ tools, vendors, members, canManage, canCost }: { tools: Tool[]; vendors: Array<{ id: string; name: string }>; members: Member[]; canManage: boolean; canCost: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState(false);
  const rows = useMemo(() => tools.filter((t) => (!status || t.status === status) && (!q || `${t.name} ${t.vendorName ?? ""} ${t.purpose}`.toLowerCase().includes(q.toLowerCase()))), [tools, status, q]);
  const columns: Array<DataTableColumn<Tool>> = [
    { key: "n", header: "Tool", cell: (t) => <span><span className="font-medium">{t.name}</span><span className="block text-xs text-muted">{t.vendorName ?? "No vendor"} · {human(t.category)}</span></span> },
    { key: "s", header: "Status", cell: (t) => <StatusPill status={t.status} /> },
    { key: "u", header: "Licenses", cell: (t) => <span>{num(t.activeUsers)} active / {num(t.assignedLicenses)}{t.unusedLicenses ? <span className="block text-xs text-warning">{t.unusedLicenses} unused</span> : null}</span> },
    { key: "d", header: "Departments", hideOnMobile: true, cell: (t) => t.departments.join(", ") || "All" },
    ...(canCost ? [{ key: "c", header: "Annual cost", hideOnMobile: true, cell: (t: Tool) => usd(t.annualCost) }] : []),
    { key: "r", header: "Reviews", hideOnMobile: true, cell: (t) => <span className="text-xs">Security <StatusPill status={t.securityReview} /> Privacy <StatusPill status={t.privacyReview} /></span> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search tools" placeholder="Search tools" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "Any status" }, ...opts(TOOL_STATUSES)]} />
        <span className="flex-1" />
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit(true)}>Add tool</Button>}
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(t) => t.id} onRowClick={(t) => router.push(`${OPS}/tools/${t.id}`)} rowLabel={(t) => `Open ${t.name}`} caption="AI tools"
        emptyState={<p className="p-6 text-center text-sm text-muted">{tools.length ? "No tools match." : "No AI tools in the inventory yet."}</p>} />
      {edit && <ToolForm vendors={vendors} members={members} onClose={() => setEdit(false)} />}
    </div>
  );
}

function ToolForm({ tool, vendors, members, onClose }: { tool?: ToolDetail; vendors: Array<{ id: string; name: string }>; members: Member[]; onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [f, setF] = useState({
    name: tool?.name ?? "", vendorId: tool?.vendorId ?? "", category: tool?.category ?? "other", status: tool?.status ?? "experimental", purpose: tool?.purpose ?? "", businessOwnerUserId: tool?.businessOwnerUserId ?? "",
    departments: (tool?.departments ?? []).join(", "), licensedSeats: String(tool?.licensedSeats ?? 0), annualCost: String(tool?.annualCost ?? 0), renewalDate: tool?.renewalDate ?? "",
    securityReview: tool?.securityReview ?? "not_started", privacyReview: tool?.privacyReview ?? "not_started", maxDataClassification: tool?.maxDataClassification ?? "internal",
    platformProviderKey: tool?.platformProviderKey ?? "", relatedModules: (tool?.relatedModules ?? []).join(", "), website: tool?.website ?? "",
  });
  const go = async () => {
    const body = {
      name: f.name, vendorId: f.vendorId || null, category: f.category, status: f.status, purpose: f.purpose, businessOwnerUserId: f.businessOwnerUserId || null, departments: csv(f.departments),
      licensedSeats: Number(f.licensedSeats) || 0, annualCost: Number(f.annualCost) || 0, renewalDate: f.renewalDate || null, securityReview: f.securityReview, privacyReview: f.privacyReview,
      maxDataClassification: f.maxDataClassification, platformProviderKey: f.platformProviderKey || null, relatedModules: csv(f.relatedModules), website: f.website || null,
    };
    const r = await run(() => apiFetch<{ id: string }>(tool ? `${OPS}/tools/${tool.id}` : `${OPS}/tools`, { method: tool ? "PATCH" : "POST", body }), { success: tool ? "Tool updated" : "Tool added", refresh: !!tool });
    if (r) {
      onClose();
      if (!tool) router.push(`${OPS}/tools/${r.id}`);
    }
  };
  const field = (k: keyof typeof f, label: string, el: "input" | "select" | "textarea" = "input", o?: Array<{ value: string; label: string }>, extra: { type?: string; hint?: string; span?: boolean } = {}) => (
    <FormField id={`tf-${k}`} label={label} hint={extra.hint} className={extra.span ? "sm:col-span-2" : undefined}>
      {(x) => el === "select" ? <Select {...x} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} options={o!} /> : el === "textarea" ? <Textarea {...x} rows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /> : <Input {...x} type={extra.type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
    </FormField>
  );
  return (
    <Modal open onClose={onClose} title={tool ? `Edit ${tool.name}` : "Add an AI tool"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name.trim()} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("name", "Name")}
        {field("vendorId", "Vendor", "select", [{ value: "", label: "None" }, ...vendors.map((v) => ({ value: v.id, label: v.name }))])}
        {field("category", "Category", "select", opts(CATEGORIES))}
        {field("status", "Status", "select", opts(TOOL_STATUSES))}
        {field("purpose", "Purpose", "textarea", undefined, { span: true })}
        {field("businessOwnerUserId", "Business owner", "select", [{ value: "", label: "None" }, ...members.map((m) => ({ value: m.userId, label: m.name }))])}
        {field("departments", "Departments", "input", undefined, { hint: "Comma separated; empty = all" })}
        {field("licensedSeats", "Licensed seats", "input", undefined, { type: "number" })}
        {field("annualCost", "Annual cost (USD)", "input", undefined, { type: "number" })}
        {field("renewalDate", "Renewal date", "input", undefined, { type: "date" })}
        {field("maxDataClassification", "Approved for data up to", "select", opts(["public", "internal", "confidential", "restricted"]))}
        {field("securityReview", "Security review", "select", opts(REVIEW))}
        {field("privacyReview", "Privacy review", "select", opts(REVIEW))}
        {field("platformProviderKey", "Platform AI provider key", "input", undefined, { hint: "Links usage from the shared AI layer (e.g. anthropic)" })}
        {field("relatedModules", "Related modules", "input", undefined, { hint: "e.g. knowledge_verification, integration_hub" })}
        {field("website", "Website", "input", undefined, { type: "url", span: true })}
      </div>
    </Modal>
  );
}

export function ToolDetailView({ t, vendors, members, canManage }: { t: ToolDetail; vendors: Array<{ id: string; name: string }>; members: Member[]; canManage: boolean }) {
  const { run, pending } = useMutation();
  const [edit, setEdit] = useState(false);
  const [assign, setAssign] = useState("");
  const [activity, setActivity] = useState("");
  const doAssign = async () => {
    const r = await run(() => apiFetch<{ assigned: number; unknown: string[] }>(`${OPS}/tools/${t.id}/licenses`, { body: { users: csv(assign.replace(/\n/g, ",")) } }), { success: "Licenses assigned" });
    if (r) setAssign("");
  };
  const doActivity = async () => {
    const entries = activity.split("\n").map((l) => l.split(",").map((x) => x.trim())).filter((x) => x[0]).map(([user, lastActiveAt, days]) => ({ user: user!, lastActiveAt: lastActiveAt || new Date().toISOString(), activeDays30: Number(days) || 0 }));
    if (await run(() => apiFetch(`${OPS}/tools/${t.id}/activity`, { body: { activity: entries } }), { success: "Activity recorded" })) setActivity("");
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={t.status} />
        <span className="text-sm text-muted">{t.vendorName ?? "No vendor"} · {human(t.category)} · approved for {t.maxDataClassification} data</span>
        <span className="flex-1" />
        {canManage && <Button variant="secondary" onClick={() => setEdit(true)}>Edit</Button>}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Details" />
          <CardBody>
            <KeyValueList columns={2} items={[
              { key: "p", label: "Purpose", value: t.purpose || "—" }, { key: "o", label: "Business owner", value: t.businessOwner ?? "—" },
              { key: "d", label: "Departments", value: t.departments.join(", ") || "All" }, { key: "s", label: "Licenses", value: `${t.activeUsers} active of ${t.assignedLicenses} assigned (${t.licensedSeats} seats bought)` },
              { key: "c", label: "Annual cost", value: t.annualCost == null ? "Hidden" : usd(t.annualCost) }, { key: "r", label: "Renewal", value: t.contract ? `${t.contract.name} · ${t.contract.renewalDate ?? "no date"}` : t.renewalDate ?? "—" },
              { key: "sec", label: "Security review", value: <StatusPill status={t.securityReview} /> }, { key: "pri", label: "Privacy review", value: <StatusPill status={t.privacyReview} /> },
              { key: "pk", label: "Platform AI provider", value: t.platformProviderKey ?? "—" }, { key: "m", label: "Related modules", value: t.relatedModules.map(human).join(", ") || "—" },
              { key: "src", label: "Added via", value: t.requestId ? <Link className="text-accent hover:underline" href={`${OPS}/requests/${t.requestId}`}>AI request</Link> : human(t.source) },
            ]} />
          </CardBody>
        </Card>
        {canManage && (
          <Card>
            <CardHeader title="Assign licenses" description="Emails or user IDs of organization members." />
            <CardBody className="space-y-2">
              <Textarea aria-label="Users to license" rows={3} placeholder={"jane@example.com\njohn@example.com"} value={assign} onChange={(e) => setAssign(e.target.value)} />
              <Button size="sm" loading={pending} disabled={!assign.trim()} onClick={doAssign}>Assign</Button>
              <p className="pt-2 text-sm font-medium">Import activity</p>
              <p className="text-xs text-muted">From the vendor admin console or SSO: one line per person — email, last active date, active days in the last 30.</p>
              <Textarea aria-label="Activity export" rows={3} placeholder="jane@example.com, 2026-10-01, 12" value={activity} onChange={(e) => setActivity(e.target.value)} />
              <Button size="sm" variant="secondary" loading={pending} disabled={!activity.trim()} onClick={doActivity}>Record activity</Button>
            </CardBody>
          </Card>
        )}
      </div>
      {t.licenses && (
        <Card>
          <CardHeader title="Licenses" description="Last activity is used only to find unused seats." />
          <CardBody className="space-y-1">
            {t.licenses.length === 0 && <p className="text-sm text-muted">No licenses assigned.</p>}
            {t.licenses.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1 text-sm last:border-0">
                <span>{l.name}<span className="block text-xs text-muted">{l.email}{l.department ? ` · ${l.department}` : ""}</span></span>
                <span className="flex items-center gap-3 text-xs text-muted">
                  {l.lastActiveAt ? <span>last active <LocalDate value={l.lastActiveAt} dateOnly /></span> : <span className="text-warning">never used</span>}
                  <StatusPill status={l.status} />
                  {l.status === "active" && <Button size="sm" variant="ghost" onClick={() => run(() => apiFetch(`${OPS}/tools/${t.id}/licenses/${l.id}`, { method: "DELETE" }), { success: "License revoked" })}>Revoke</Button>}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
      {edit && <ToolForm tool={t} vendors={vendors} members={members} onClose={() => setEdit(false)} />}
    </div>
  );
}

export function VendorList({ vendors, canManage, canCost }: { vendors: Vendor[]; canManage: boolean; canCost: boolean }) {
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  const columns: Array<DataTableColumn<Vendor>> = [
    { key: "n", header: "Vendor", cell: (v) => <span><span className="font-medium">{v.name}</span><span className="block text-xs text-muted">{v.products.map((p) => p.name).join(", ") || "No products"}</span></span> },
    { key: "s", header: "Security", cell: (v) => <StatusPill status={v.securityStatus} /> },
    { key: "p", header: "Privacy", hideOnMobile: true, cell: (v) => <StatusPill status={v.privacyStatus} /> },
    { key: "c", header: "Contracts", cell: (v) => <span>{v.activeContracts}{v.nextRenewal ? <span className="block text-xs text-muted">renews {v.nextRenewal}</span> : null}</span> },
    ...(canCost ? [{ key: "v", header: "Annual contract value", hideOnMobile: true, cell: (v: Vendor) => usd(v.annualContractValue) }] : []),
    { key: "st", header: "Status", hideOnMobile: true, cell: (v) => <StatusPill status={v.status} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">Vendors link to the shared AI provider registry by key instead of copying it.</p>
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit(true)}>Add vendor</Button>}
      </div>
      <DataTable columns={columns} rows={vendors} getRowId={(v) => v.id} onRowClick={(v) => router.push(`${OPS}/vendors/${v.id}`)} rowLabel={(v) => `Open ${v.name}`} caption="AI vendors" emptyState={<p className="p-6 text-center text-sm text-muted">No vendors yet.</p>} />
      {edit && <VendorForm onClose={() => setEdit(false)} />}
    </div>
  );
}

function VendorForm({ vendor, onClose }: { vendor?: VendorDetail; onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: vendor?.name ?? "", website: vendor?.website ?? "", platformProviderKeys: (vendor?.platformProviderKeys ?? []).join(", "), securityStatus: vendor?.securityStatus ?? "not_reviewed", privacyStatus: vendor?.privacyStatus ?? "not_reviewed", status: vendor?.status ?? "active", notes: vendor?.notes ?? "", contacts: (vendor?.contacts ?? []).map((c) => [c.name, c.email ?? "", c.role ?? ""].join(", ")).join("\n") });
  const go = async () => {
    const contacts = f.contacts.split("\n").map((l) => l.split(",").map((x) => x.trim())).filter((x) => x[0]).map(([name, email, role]) => ({ name: name!, ...(email ? { email } : {}), ...(role ? { role } : {}) }));
    const body = { name: f.name, website: f.website || null, platformProviderKeys: csv(f.platformProviderKeys), securityStatus: f.securityStatus, privacyStatus: f.privacyStatus, status: f.status, notes: f.notes, contacts };
    const r = await run(() => apiFetch<{ id: string }>(vendor ? `${OPS}/vendors/${vendor.id}` : `${OPS}/vendors`, { method: vendor ? "PATCH" : "POST", body }), { success: "Vendor saved", refresh: !!vendor });
    if (r) {
      onClose();
      if (!vendor) router.push(`${OPS}/vendors/${r.id}`);
    }
  };
  return (
    <Modal open onClose={onClose} title={vendor ? `Edit ${vendor.name}` : "Add a vendor"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name.trim()} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="vf-name" label="Name">{(x) => <Input {...x} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</FormField>
        <FormField id="vf-web" label="Website">{(x) => <Input {...x} type="url" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />}</FormField>
        <FormField id="vf-keys" label="Platform AI provider keys" hint="Links metered usage, e.g. anthropic">{(x) => <Input {...x} value={f.platformProviderKeys} onChange={(e) => setF({ ...f, platformProviderKeys: e.target.value })} />}</FormField>
        <FormField id="vf-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["active", "inactive"])} />}</FormField>
        <FormField id="vf-sec" label="Security status">{(x) => <Select {...x} value={f.securityStatus} onChange={(e) => setF({ ...f, securityStatus: e.target.value as typeof f.securityStatus })} options={opts(VREVIEW)} />}</FormField>
        <FormField id="vf-pri" label="Privacy status">{(x) => <Select {...x} value={f.privacyStatus} onChange={(e) => setF({ ...f, privacyStatus: e.target.value as typeof f.privacyStatus })} options={opts(VREVIEW)} />}</FormField>
        <FormField id="vf-contacts" label="Contacts" hint="One per line: name, email, role" className="sm:col-span-2">{(x) => <Textarea {...x} rows={3} value={f.contacts} onChange={(e) => setF({ ...f, contacts: e.target.value })} />}</FormField>
        <FormField id="vf-notes" label="Notes" className="sm:col-span-2">{(x) => <Textarea {...x} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

export function VendorDetailView({ v, members, canManage }: { v: VendorDetail; members: Member[]; canManage: boolean }) {
  const [edit, setEdit] = useState(false);
  const [contract, setContract] = useState<VendorDetail["contracts"][number] | "new" | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Security</span><StatusPill status={v.securityStatus} /><span className="text-sm text-muted">Privacy</span><StatusPill status={v.privacyStatus} />
        {v.website && <a className="text-sm text-accent hover:underline" href={v.website} target="_blank" rel="noreferrer">{v.website}</a>}
        <span className="flex-1" />
        {canManage && <Button variant="secondary" onClick={() => setEdit(true)}>Edit vendor</Button>}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Contracts" actions={canManage ? <Button size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setContract("new")}>Add contract</Button> : undefined} />
          <CardBody className="space-y-2">
            {v.contracts.length === 0 && <p className="text-sm text-muted">No contracts recorded (or you cannot see contract terms).</p>}
            {v.contracts.map((c) => (
              <div key={c.id} className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2 text-sm last:border-0">
                <span><span className="font-medium">{c.name}</span><span className="block text-xs text-muted">{c.contractNumber ? `${c.contractNumber} · ` : ""}{c.billingFrequency} billing{c.autoRenew ? " · auto-renews" : ""} · notice {c.noticeDays} days</span></span>
                <span className="text-right text-xs">
                  <StatusPill status={c.status} />
                  <span className="block">{c.annualValue == null ? "" : `${usd(c.annualValue)}/yr`}{c.committedAnnualSpend ? ` · commit ${usd(c.committedAnnualSpend)}` : ""}</span>
                  <span className={c.daysToRenewal != null && c.daysToRenewal <= c.noticeDays ? "block text-warning" : "block text-muted"}>{c.renewalDate ? `renews ${c.renewalDate}${c.daysToRenewal != null ? ` (${c.daysToRenewal} days)` : ""}` : "no renewal date"}</span>
                  {canManage && <Button size="sm" variant="ghost" onClick={() => setContract(c)}>Edit</Button>}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Products and platform links" />
          <CardBody className="space-y-2 text-sm">
            {v.products.map((p) => <Link key={p.id} href={`${OPS}/tools/${p.id}`} className="flex items-center justify-between hover:underline"><span>{p.name}</span><StatusPill status={p.status} /></Link>)}
            {v.products.length === 0 && <p className="text-muted">No tools linked.</p>}
            <p className="pt-2 font-medium">Shared AI provider registry</p>
            {v.platformProviders.length === 0 && <p className="text-muted">Not linked.</p>}
            {v.platformProviders.map((p) => <p key={p.key} className="text-xs"><span className="font-mono">{p.key}</span> · {p.name} · {p.status}</p>)}
            {canManage && v.contacts.length > 0 && <><p className="pt-2 font-medium">Contacts</p>{v.contacts.map((c, i) => <p key={i} className="text-xs">{c.name}{c.role ? ` (${c.role})` : ""}{c.email ? ` · ${c.email}` : ""}</p>)}</>}
          </CardBody>
        </Card>
      </div>
      {edit && <VendorForm vendor={v} onClose={() => setEdit(false)} />}
      {contract && <ContractForm vendorId={v.id} contract={contract === "new" ? undefined : contract} members={members} onClose={() => setContract(null)} />}
    </div>
  );
}

function ContractForm({ vendorId, contract, members, onClose }: { vendorId: string; contract?: VendorDetail["contracts"][number]; members: Member[]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: contract?.name ?? "", contractNumber: contract?.contractNumber ?? "", status: contract?.status ?? "active", startDate: contract?.startDate ?? "", endDate: contract?.endDate ?? "", renewalDate: contract?.renewalDate ?? "", autoRenew: contract?.autoRenew ?? false, noticeDays: String(contract?.noticeDays ?? 30), annualValue: String(contract?.annualValue ?? 0), committedAnnualSpend: String(contract?.committedAnnualSpend ?? 0), billingFrequency: contract?.billingFrequency ?? "annual", ownerUserId: contract?.ownerUserId ?? "" });
  const go = async () => {
    const body = { vendorId, name: f.name, contractNumber: f.contractNumber || null, status: f.status, startDate: f.startDate || null, endDate: f.endDate || null, renewalDate: f.renewalDate || null, autoRenew: f.autoRenew, noticeDays: Number(f.noticeDays) || 0, annualValue: Number(f.annualValue) || 0, committedAnnualSpend: Number(f.committedAnnualSpend) || 0, billingFrequency: f.billingFrequency, ownerUserId: f.ownerUserId || null };
    if (await run(() => apiFetch(contract ? `${OPS}/contracts/${contract.id}` : `${OPS}/contracts`, { method: contract ? "PATCH" : "POST", body }), { success: "Contract saved" })) onClose();
  };
  const inp = (k: keyof typeof f, label: string, type = "text") => <FormField id={`cf-${k}`} label={label}>{(x) => <Input {...x} type={type} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Modal open onClose={onClose} title={contract ? `Edit ${contract.name}` : "Add a contract"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name.trim()} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-3">
        {inp("name", "Name")}{inp("contractNumber", "Contract number")}
        <FormField id="cf-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["draft", "active", "expired", "terminated"])} />}</FormField>
        {inp("startDate", "Start", "date")}{inp("endDate", "End", "date")}{inp("renewalDate", "Renewal date", "date")}
        {inp("annualValue", "Annual value (USD)", "number")}{inp("committedAnnualSpend", "Committed spend / yr", "number")}{inp("noticeDays", "Notice (days)", "number")}
        <FormField id="cf-billing" label="Billing">{(x) => <Select {...x} value={f.billingFrequency} onChange={(e) => setF({ ...f, billingFrequency: e.target.value as typeof f.billingFrequency })} options={opts(["monthly", "quarterly", "annual", "usage"])} />}</FormField>
        <FormField id="cf-owner" label="Owner">{(x) => <Select {...x} value={f.ownerUserId} onChange={(e) => setF({ ...f, ownerUserId: e.target.value })} options={[{ value: "", label: "Vendor managers" }, ...members.map((m) => ({ value: m.userId, label: m.name }))]} />}</FormField>
        <FormField id="cf-auto" label="Auto-renews">{(x) => <Select {...x} value={f.autoRenew ? "yes" : "no"} onChange={(e) => setF({ ...f, autoRenew: e.target.value === "yes" })} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} />}</FormField>
      </div>
    </Modal>
  );
}
