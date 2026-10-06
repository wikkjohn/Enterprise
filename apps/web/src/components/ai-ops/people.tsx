"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { BarChart, Button, Card, CardBody, CardHeader, DataTable, FormField, Input, Modal, Select, StatCard, Switch, TabPanel, Tabs, Textarea } from "@eaop/design-system";
import { type AiOpsService } from "@eaop/module-ai-operations";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { num, OPS, opts, StatusPill } from "./common";

type Adoption = Awaited<ReturnType<AiOpsService["adoption"]>>;
type UseCase = Awaited<ReturnType<AiOpsService["listUseCases"]>>[number];
type Program = Awaited<ReturnType<AiOpsService["listPrograms"]>>[number];
type Assignment = Awaited<ReturnType<AiOpsService["listAssignments"]>>[number];

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function AdoptionView({ a }: { a: Adoption }) {
  const t = a.totals;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active people (30 days)" value={`${t.activePct}%`} hint={`${num(t.activeUsers)} of ${num(t.members)} members`} />
        <StatCard label="Licensed people" value={num(t.licensedUsers)} hint="Hold at least one AI tool license" />
        <StatCard label="Usage frequency" value={`${t.runsPerActiveUser}`} hint="Platform AI runs per active person (30 days)" />
        <StatCard label="Required training completed" value={t.trainingCompletionPct == null ? "—" : `${t.trainingCompletionPct}%`} hint="Across required assignments" />
      </div>
      <p className="text-sm text-muted">Adoption is reported for groups only. Departments with fewer than {a.minGroupSize} people are hidden so nobody can be singled out; nothing here ranks or tracks individuals.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Adoption by department" />
          <CardBody>
            <DataTable caption="Department adoption" rows={a.departments} getRowId={(d) => d.department} columns={[
              { key: "d", header: "Department", cell: (d) => d.department },
              { key: "a", header: "Active", cell: (d) => (d.suppressed ? <span className="text-xs text-muted">fewer than {a.minGroupSize} people</span> : `${d.activePct}% (${d.active}/${d.members})`) },
              { key: "l", header: "Licensed", hideOnMobile: true, cell: (d) => (d.suppressed ? "—" : num(d.licensed)) },
              { key: "r", header: "Runs / active person", hideOnMobile: true, cell: (d) => (d.suppressed ? "—" : d.aiRunsPerActiveUser) },
              { key: "t", header: "Training", cell: (d) => (d.suppressed || d.trainingCompletionPct == null ? "—" : `${d.trainingCompletionPct}%`) },
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Active people over time" />
          <CardBody>{a.trend.length ? <BarChart data={a.trend.map((x) => ({ label: x.period, value: x.activePct }))} ariaLabel="Share of people active per month" height={220} valueLabel="% active" tickFormatter={(v) => `${v}%`} valueFormatter={(v) => `${v}%`} /> : <p className="text-sm text-muted">History builds up month by month.</p>}</CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Approved use-case adoption" description="People using each published use case in the last 30 days, measured through the shared usage metering (use cases with a usage key)." />
        <CardBody className="space-y-1">
          {a.useCases.length === 0 && <p className="text-sm text-muted">No published use cases yet.</p>}
          {a.useCases.map((u) => <div key={u.id} className="flex items-center justify-between gap-2 text-sm"><span>{u.title}<span className="block text-xs text-muted">{u.department}</span></span><span>{!u.tracked ? <span className="text-xs text-muted">not tracked</span> : u.suppressed ? <span className="text-xs text-muted">fewer than {a.minGroupSize}</span> : `${num(u.activeUsers)} people`}</span></div>)}
        </CardBody>
      </Card>
    </div>
  );
}

export function EnablementView({ useCases, departments, tools, programs, canManage, focus }: { useCases: UseCase[]; departments: string[]; tools: Array<{ id: string; name: string; status: string }>; programs: Array<{ id: string; name: string }>; canManage: boolean; focus?: string }) {
  const allDepts = [...new Set([...departments, ...useCases.map((u) => u.department)])];
  const [dept, setDept] = useState(useCases.find((u) => u.id === focus)?.department ?? "");
  const [edit, setEdit] = useState<UseCase | "new" | null>(null);
  const shown = useCases.filter((u) => !dept || u.department === dept);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Department" className="w-56" value={dept} onChange={(e) => setDept(e.target.value)} options={[{ value: "", label: "All departments" }, ...allDepts.map((d) => ({ value: d, label: d }))]} />
        <span className="flex-1" />
        {canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit("new")}>New use case</Button>}
      </div>
      {canManage && useCases.some((u) => u.status === "draft") && <p className="text-xs text-muted">Starter use cases are drafts: adapt them, name the approved tool and publish.</p>}
      {shown.length === 0 && <p className="text-sm text-muted">No use cases{dept ? ` for ${dept}` : ""} yet.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {shown.map((u) => (
          <Card key={u.id} className={u.id === focus ? "ring-2 ring-accent" : undefined}>
            <CardHeader title={u.title} description={`${u.department}${u.toolName ? ` · ${u.toolName}` : ""}`} actions={<span className="flex items-center gap-2"><StatusPill status={u.status} />{canManage && <Button size="sm" variant="ghost" onClick={() => setEdit(u)}>Edit</Button>}</span>} />
            <CardBody className="space-y-2 text-sm">
              {[["Business problem", u.businessProblem], ["Approved workflow", u.approvedWorkflow], ["Instructions", u.instructions], ["Expected benefit", u.expectedBenefit], ["Risks", u.risks], ["Success metric", u.successMetric]].filter(([, v]) => v).map(([k, v]) => <p key={k}><span className="font-medium">{k}:</span> {v}</p>)}
              {u.trainingName && <p><span className="font-medium">Required training:</span> {u.trainingName}</p>}
              {u.workflowRef && <p className="text-xs text-muted">Workflow Intelligence workflow {u.workflowRef}</p>}
            </CardBody>
          </Card>
        ))}
      </div>
      {edit && <UseCaseForm u={edit === "new" ? undefined : edit} departments={allDepts} tools={tools} programs={programs} onClose={() => setEdit(null)} />}
    </div>
  );
}

function UseCaseForm({ u, departments, tools, programs, onClose }: { u?: UseCase; departments: string[]; tools: Array<{ id: string; name: string; status: string }>; programs: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ department: u?.department ?? departments[0] ?? "", title: u?.title ?? "", businessProblem: u?.businessProblem ?? "", approvedWorkflow: u?.approvedWorkflow ?? "", toolId: u?.toolId ?? "", instructions: u?.instructions ?? "", expectedBenefit: u?.expectedBenefit ?? "", risks: u?.risks ?? "", requiredTrainingId: u?.requiredTrainingId ?? "", successMetric: u?.successMetric ?? "", usageKey: u?.usageKey ?? "", workflowRef: u?.workflowRef ?? "", status: u?.status ?? "draft" });
  const go = async () => {
    const body = { ...f, toolId: f.toolId || null, requiredTrainingId: f.requiredTrainingId || null, usageKey: f.usageKey || null, workflowRef: f.workflowRef || null };
    if (await run(() => apiFetch(u ? `${OPS}/use-cases/${u.id}` : `${OPS}/use-cases`, { method: u ? "PATCH" : "POST", body }), { success: "Use case saved" })) onClose();
  };
  const ta = (k: keyof typeof f, label: string) => <FormField id={`uc-${k}`} label={label} className="sm:col-span-2">{(x) => <Textarea {...x} rows={2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Modal open onClose={onClose} title={u ? `Edit ${u.title}` : "New use case"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.title || !f.department} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="uc-dept" label="Department">{(x) => <Input {...x} list="uc-depts" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} />}</FormField>
        <datalist id="uc-depts">{departments.map((d) => <option key={d} value={d} />)}</datalist>
        <FormField id="uc-title" label="Title">{(x) => <Input {...x} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</FormField>
        {ta("businessProblem", "Business problem")}{ta("approvedWorkflow", "Approved workflow")}
        <FormField id="uc-tool" label="Approved tool" hint="Strategic or Approved tools only, to publish">{(x) => <Select {...x} value={f.toolId} onChange={(e) => setF({ ...f, toolId: e.target.value })} options={[{ value: "", label: "—" }, ...tools.map((t) => ({ value: t.id, label: `${t.name} (${t.status})` }))]} />}</FormField>
        <FormField id="uc-tr" label="Required training">{(x) => <Select {...x} value={f.requiredTrainingId} onChange={(e) => setF({ ...f, requiredTrainingId: e.target.value })} options={[{ value: "", label: "None" }, ...programs.map((p) => ({ value: p.id, label: p.name }))]} />}</FormField>
        {ta("instructions", "Instructions")}{ta("expectedBenefit", "Expected benefit")}{ta("risks", "Risks")}
        <FormField id="uc-metric" label="Success metric">{(x) => <Input {...x} value={f.successMetric} onChange={(e) => setF({ ...f, successMetric: e.target.value })} />}</FormField>
        <FormField id="uc-usage" label="Usage key" hint="Platform AI use case to measure adoption, e.g. sales.brief or sales.*">{(x) => <Input {...x} value={f.usageKey} onChange={(e) => setF({ ...f, usageKey: e.target.value })} />}</FormField>
        <FormField id="uc-wf" label="Workflow Intelligence workflow id">{(x) => <Input {...x} value={f.workflowRef} onChange={(e) => setF({ ...f, workflowRef: e.target.value })} />}</FormField>
        <FormField id="uc-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["draft", "published", "retired"])} />}</FormField>
      </div>
    </Modal>
  );
}

export function TrainingView({ mine, programs, records, canManage }: { mine: Assignment[]; programs: Program[]; records: Assignment[] | null; canManage: boolean }) {
  const [tab, setTab] = useState("mine");
  const [edit, setEdit] = useState<Program | "new" | null>(null);
  const [assign, setAssign] = useState<Program | null>(null);
  return (
    <div className="space-y-4">
      <Tabs ariaLabel="Training" idPrefix="tr" value={tab} onChange={setTab} items={[{ value: "mine", label: "My training" }, { value: "catalog", label: "Programs and courses" }, ...(canManage ? [{ value: "records", label: "Completion records" }] : [])]} />
      <TabPanel idPrefix="tr" value="mine" selected={tab}>
        <div className="space-y-3">
          {mine.length === 0 && <p className="text-sm text-muted">No training assigned to you.</p>}
          {mine.map((a) => <MyAssignment key={a.id} a={a} />)}
        </div>
      </TabPanel>
      <TabPanel idPrefix="tr" value="catalog" selected={tab}>
        <div className="space-y-3">
          <div className="flex items-center gap-2"><p className="flex-1 text-sm text-muted">Training focuses on real job workflows, not just prompting.</p>{canManage && <Button leftIcon={<Plus className="size-4" />} onClick={() => setEdit("new")}>New training</Button>}</div>
          {programs.length === 0 && <p className="text-sm text-muted">No training yet.</p>}
          <div className="grid gap-3 lg:grid-cols-2">
            {programs.map((p) => (
              <Card key={p.id}>
                <CardHeader title={p.name} description={`${p.kind}${p.required ? " · required" : ""}${p.validityDays ? ` · valid ${p.validityDays} days` : ""}${p.passScore != null ? ` · pass mark ${p.passScore}` : ""}`} actions={<StatusPill status={p.status} />} />
                <CardBody className="space-y-1 text-sm">
                  {p.workflowFocus && <p><span className="font-medium">Workflow:</span> {p.workflowFocus}</p>}
                  {p.description && <p className="text-muted">{p.description}</p>}
                  <p className="text-xs text-muted">{p.departments.length ? `For ${p.departments.join(", ")}` : "For everyone"}{p.roles.length ? ` · roles ${p.roles.join(", ")}` : ""}</p>
                  {canManage && <p className="text-xs">{p.completed} of {p.assigned} completed</p>}
                  {canManage && <div className="flex gap-2 pt-1"><Button size="sm" onClick={() => setAssign(p)} disabled={p.status !== "active"}>Assign</Button><Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Edit</Button></div>}
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </TabPanel>
      {records && (
        <TabPanel idPrefix="tr" value="records" selected={tab}>
          <DataTable caption="Training records" rows={records} getRowId={(r) => r.id} columns={[
            { key: "u", header: "Person", cell: (r) => <span>{r.userName}<span className="block text-xs text-muted">{r.department ?? "—"}{r.role ? ` · ${r.role}` : ""}</span></span> },
            { key: "p", header: "Training", cell: (r) => <span>{r.programName}{r.required ? <span className="block text-xs text-muted">required</span> : null}</span> },
            { key: "s", header: "Status", cell: (r) => <span><StatusPill status={r.status} />{r.overdue ? <span className="block text-xs text-danger">overdue</span> : null}</span> },
            { key: "d", header: "Due", hideOnMobile: true, cell: (r) => r.dueDate ?? "—" },
            { key: "sc", header: "Score", hideOnMobile: true, cell: (r) => (r.score == null ? "—" : `${r.score}${r.passed === false ? " (not passed)" : ""}`) },
            { key: "e", header: "Expires", hideOnMobile: true, cell: (r) => r.expiresAt?.slice(0, 10) ?? "—" },
          ]} emptyState={<p className="p-6 text-center text-sm text-muted">No assignments.</p>} />
        </TabPanel>
      )}
      {edit && <ProgramForm p={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
      {assign && <AssignForm p={assign} onClose={() => setAssign(null)} />}
    </div>
  );
}

function MyAssignment({ a }: { a: Assignment }) {
  const { run, pending } = useMutation();
  const [score, setScore] = useState("");
  return (
    <Card>
      <CardBody className="flex flex-wrap items-center gap-3 text-sm">
        <span className="min-w-0 flex-1"><span className="font-medium">{a.programName}</span><span className="block text-xs text-muted">{a.workflowFocus}{a.dueDate ? ` · due ${a.dueDate}` : ""}{a.overdue ? " · overdue" : ""}{a.expiresAt ? ` · valid until ${a.expiresAt.slice(0, 10)}` : ""}</span></span>
        {a.contentUrl && <a className="text-accent hover:underline" href={a.contentUrl} target="_blank" rel="noreferrer">Open course</a>}
        <StatusPill status={a.status} />
        {a.status !== "completed" && a.status !== "waived" && (
          <span className="flex items-center gap-2">
            {a.passScore != null && <Input aria-label="Assessment score" className="w-24" type="number" placeholder={`score ≥ ${a.passScore}`} value={score} onChange={(e) => setScore(e.target.value)} />}
            <Button size="sm" loading={pending} disabled={a.passScore != null && !score} onClick={() => run(() => apiFetch(`${OPS}/training/assignments/${a.id}`, { body: { status: "completed", score: score ? Number(score) : null } }), { success: "Recorded" })}>Mark complete</Button>
          </span>
        )}
      </CardBody>
    </Card>
  );
}

function ProgramForm({ p, onClose }: { p?: Program; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ name: p?.name ?? "", kind: p?.kind ?? "course", description: p?.description ?? "", workflowFocus: p?.workflowFocus ?? "", departments: (p?.departments ?? []).join(", "), roles: (p?.roles ?? []).join(", "), required: p?.required ?? false, validityDays: p?.validityDays?.toString() ?? "", passScore: p?.passScore?.toString() ?? "", contentUrl: p?.contentUrl ?? "", status: p?.status ?? "active" });
  const go = async () => {
    const body = { ...f, departments: csv(f.departments), roles: csv(f.roles), validityDays: f.validityDays ? Number(f.validityDays) : null, passScore: f.passScore ? Number(f.passScore) : null, contentUrl: f.contentUrl || null };
    if (await run(() => apiFetch(p ? `${OPS}/training/${p.id}` : `${OPS}/training`, { method: p ? "PATCH" : "POST", body }), { success: "Training saved" })) onClose();
  };
  const inp = (k: keyof typeof f, label: string, hint?: string, type = "text") => <FormField id={`pg-${k}`} label={label} hint={hint}>{(x) => <Input {...x} type={type} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</FormField>;
  return (
    <Modal open onClose={onClose} title={p ? `Edit ${p.name}` : "New training"} size="lg" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!f.name} onClick={go}>Save</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {inp("name", "Name")}
        <FormField id="pg-kind" label="Kind">{(x) => <Select {...x} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })} options={opts(["program", "course"])} />}</FormField>
        {inp("workflowFocus", "Job workflow it teaches", "e.g. Drafting customer replies in ServiceNow")}
        {inp("contentUrl", "Course link", undefined, "url")}
        {inp("departments", "Departments", "empty = everyone")}{inp("roles", "Roles", "role keys")}
        {inp("validityDays", "Valid for (days)", "empty = no expiry", "number")}{inp("passScore", "Assessment pass mark", "0–100; empty = no assessment", "number")}
        <FormField id="pg-status" label="Status">{(x) => <Select {...x} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })} options={opts(["draft", "active", "retired"])} />}</FormField>
        <div className="pt-6"><Switch checked={f.required} onCheckedChange={(v) => setF({ ...f, required: v })} label="Required" /></div>
        <FormField id="pg-desc" label="Description" className="sm:col-span-2">{(x) => <Textarea {...x} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
      </div>
    </Modal>
  );
}

function AssignForm({ p, onClose }: { p: Program; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [f, setF] = useState({ users: "", departments: p.departments.join(", "), roles: p.roles.join(", "), dueDate: "" });
  const go = async () => {
    const r = await run(() => apiFetch<{ assigned: number }>(`${OPS}/training/${p.id}/assign`, { body: { users: csv(f.users.replace(/\n/g, ",")), departments: csv(f.departments), roles: csv(f.roles), dueDate: f.dueDate || null } }), { success: "Training assigned" });
    if (r) onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Assign ${p.name}`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={go}>Assign</Button></div>}>
      <div className="grid gap-3">
        <FormField id="as-dept" label="Departments">{(x) => <Input {...x} value={f.departments} onChange={(e) => setF({ ...f, departments: e.target.value })} />}</FormField>
        <FormField id="as-roles" label="Roles">{(x) => <Input {...x} value={f.roles} onChange={(e) => setF({ ...f, roles: e.target.value })} />}</FormField>
        <FormField id="as-users" label="People" hint="Emails, one per line">{(x) => <Textarea {...x} rows={3} value={f.users} onChange={(e) => setF({ ...f, users: e.target.value })} />}</FormField>
        <FormField id="as-due" label="Due date">{(x) => <Input {...x} type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</FormField>
        <p className="text-xs text-muted">Each person is notified. People who already have this training are skipped.</p>
      </div>
    </Modal>
  );
}
