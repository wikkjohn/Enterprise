"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardFooter, CardHeader, DataTable, FormField, Input, Select, StatusBadge } from "@eaop/design-system";
import { type OrganizationView } from "@eaop/organizations";
import { apiFetch } from "@/lib/client";
import { useMutation } from "@/components/actions";

export function PlatformOrganizations({ orgs }: { orgs: OrganizationView[] }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: "", slug: "", environment: "production" });
  return (
    <div className="space-y-6">
      <DataTable caption="Organizations" rows={orgs} getRowId={(o) => o.id} columns={[
        { key: "name", header: "Organization", sortable: true, sortValue: (o) => o.name, cell: (o) => <div><div className="font-medium">{o.name}</div><code className="font-mono text-xs text-muted">{o.slug}</code></div> },
        { key: "env", header: "Environment", cell: (o) => o.environment },
        { key: "status", header: "Status", cell: (o) => <StatusBadge status={o.status} /> },
        { key: "created", header: "Created", hideOnMobile: true, cell: (o) => new Date(o.createdAt).toLocaleDateString() },
        { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (o) => (
          <Button size="sm" variant={o.status === "active" ? "ghost" : "secondary"} onClick={() => void run(() => apiFetch(`/platform/organizations/${o.id}`, { method: "PATCH", body: { status: o.status === "active" ? "suspended" : "active" } }), { success: "Status updated" })}>{o.status === "active" ? "Suspend" : "Reactivate"}</Button>
        ) },
      ]} />
      <Card>
        <CardHeader title="Provision organization" description="You become its first Organization Administrator; invite the customer's administrators, then remove yourself." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <FormField id="po-name" label="Name">{(a) => <Input {...a} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) })} />}</FormField>
          <FormField id="po-slug" label="Slug">{(a) => <Input {...a} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} />}</FormField>
          <FormField id="po-env" label="Environment">{(a) => <Select {...a} value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })} options={["production", "staging", "sandbox"].map((v) => ({ value: v, label: v }))} />}</FormField>
        </CardBody>
        <CardFooter><Button loading={pending} disabled={!f.name || !f.slug} onClick={async () => { if (await run(() => apiFetch("/platform/organizations", { body: f }), { success: "Organization provisioned" })) setF({ name: "", slug: "", environment: "production" }); }}>Provision</Button></CardFooter>
      </Card>
    </div>
  );
}
