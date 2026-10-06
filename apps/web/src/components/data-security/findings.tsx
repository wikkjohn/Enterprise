"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Card, CardHeader, DataTable, Select, type DataTableColumn } from "@eaop/design-system";
import { type DataSecurityService } from "@eaop/module-data-security";
import { LocalDate } from "@/components/local-date";
import { DS, human, opts, SensitivityBadge, SeverityBadge } from "./common";

type Findings = Awaited<ReturnType<DataSecurityService["listFindings"]>>;

export function FindingsView({ findings }: { findings: Findings }) {
  const [sev, setSev] = useState("");
  const access = findings.access.filter((f) => !sev || f.severity === sev);
  const aCols: Array<DataTableColumn<Findings["access"][number]>> = [
    { key: "sev", header: "Severity", cell: (f) => <SeverityBadge value={f.severity} /> },
    { key: "k", header: "Finding", cell: (f) => <span><span className="font-medium">{human(f.kind)}</span>{f.principal ? <span className="text-muted"> — {f.principal}</span> : null}<span className="block text-xs text-muted">{f.detail}</span></span> },
    { key: "a", header: "Asset", cell: (f) => <Link className="text-accent hover:underline" href={`${DS}/assets/${f.assetId}`}>{f.assetName}</Link> },
    { key: "c", header: "Data", hideOnMobile: true, cell: (f) => <SensitivityBadge value={f.classification} /> },
    { key: "s", header: "Source", hideOnMobile: true, cell: (f) => f.sourceSystem },
    { key: "t", header: "Last seen", hideOnMobile: true, cell: (f) => <LocalDate value={f.lastSeenAt} /> },
  ];
  const eCols: Array<DataTableColumn<Findings["exposure"][number]>> = [
    { key: "sev", header: "Severity", cell: (f) => <SeverityBadge value={f.severity} /> },
    { key: "t", header: "Exposure", cell: (f) => <span><span className="font-medium">{human(f.type)}</span>{f.destination ? ` — ${f.destination}` : ""} <Badge>{f.basis}</Badge><span className="block text-xs text-muted">{f.detail}</span></span> },
    { key: "a", header: "Asset", cell: (f) => <Link className="text-accent hover:underline" href={`${DS}/assets/${f.assetId}`}>{f.assetName}</Link> },
    { key: "c", header: "Data", hideOnMobile: true, cell: (f) => <SensitivityBadge value={f.classification} /> },
  ];
  return (
    <div className="space-y-4">
      <Select aria-label="Severity" className="max-w-xs" value={sev} onChange={(e) => setSev(e.target.value)} options={[{ value: "", label: "Any severity" }, ...opts(["critical", "high", "medium", "low"])]} />
      <Card>
        <CardHeader title={`Permission exposure (${access.length})`} description="Ranked by severity, then by how sensitive the data is." />
        <DataTable columns={aCols} rows={access} getRowId={(f) => f.id} caption="Permission findings" emptyState={<p className="p-6 text-center text-sm text-muted">No open permission findings.</p>} />
      </Card>
      <Card>
        <CardHeader title={`AI exposure (${findings.exposure.length})`} description="Inferred: sharing makes the asset reachable by AI. Observed: DLP saw content from it headed to AI." />
        <DataTable columns={eCols} rows={findings.exposure} getRowId={(f) => f.id} caption="AI exposure findings" emptyState={<p className="p-6 text-center text-sm text-muted">No open AI exposure.</p>} />
      </Card>
    </div>
  );
}
