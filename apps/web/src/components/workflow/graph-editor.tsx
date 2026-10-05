"use client";

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GitBranch, LayoutGrid, Link2, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, FormField, Input, Select, Textarea, cn } from "@eaop/design-system";
import { type EdgeView, type StepView } from "@eaop/module-workflow-intelligence";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { STEP_TYPE_META, WI_API } from "./common";

const W = 168;
const H = 60;
const STEP_TYPES = Object.keys(STEP_TYPE_META);

export type EditableStep = Omit<StepView, "id" | "sort"> & { id?: string };

const blankStep = (type: string, key: string, position: { x: number; y: number }): EditableStep => ({
  key, type: type as StepView["type"], name: STEP_TYPE_META[type]?.label ?? type, description: "", owner: null, role: null, system: null, input: null, output: null,
  durationMinutes: 0, waitMinutes: 0, frequencyPerRun: 1, costPerExecution: 0, errorRate: 0, reworkRate: 0, requiresApproval: type === "approval",
  risk: "low", automationPotential: "unknown", position,
});

/** Longest-path layering from the roots; deterministic and readable for typical business flows. */
export function autoLayout(steps: EditableStep[], edges: EdgeView[]): EditableStep[] {
  const incoming = new Map(steps.map((s) => [s.key, 0]));
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const layer = new Map<string, number>();
  const queue = steps.filter((s) => !incoming.get(s.key)).map((s) => s.key);
  if (queue.length === 0 && steps[0]) queue.push(steps[0].key);
  queue.forEach((k) => layer.set(k, 0));
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const k = queue.shift()!;
    for (const e of edges.filter((x) => x.from === k)) {
      const next = (layer.get(k) ?? 0) + 1;
      if ((layer.get(e.to) ?? -1) < next && next < steps.length) {
        layer.set(e.to, next);
        queue.push(e.to);
      }
    }
  }
  const rows = new Map<number, number>();
  return steps.map((s) => {
    const l = layer.get(s.key) ?? 0;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    return { ...s, position: { x: 40 + l * (W + 48), y: 40 + r * (H + 50) } };
  });
}

export function GraphEditor({ workflowId, initialSteps, initialEdges, readOnly }: { workflowId: string; initialSteps: StepView[]; initialEdges: EdgeView[]; readOnly: boolean }) {
  const [steps, setSteps] = useState<EditableStep[]>(initialSteps);
  const [edges, setEdges] = useState<EdgeView[]>(initialEdges);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [newType, setNewType] = useState("human_task");
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ key: string; dx: number; dy: number } | null>(null);
  const { run, pending } = useMutation();

  const byKey = useMemo(() => new Map(steps.map((s) => [s.key, s])), [steps]);
  const step = selected ? byKey.get(selected) : undefined;
  const maxX = Math.max(600, ...steps.map((s) => s.position.x + W + 40));
  const maxY = Math.max(260, ...steps.map((s) => s.position.y + H + 40));

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
  };
  const updateStep = (key: string, patch: Partial<EditableStep>) => change(() => setSteps((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s))));

  function toSvg(e: { clientX: number; clientY: number }) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }

  function onNodePointerDown(e: ReactPointerEvent, key: string) {
    e.stopPropagation();
    if (connectFrom && connectFrom !== key) {
      connect(connectFrom, key);
      return;
    }
    setSelected(key);
    setSelectedEdge(null);
    if (readOnly) return;
    const s = byKey.get(key)!;
    const p = toSvg(e);
    drag.current = { key, dx: p.x - s.position.x, dy: p.y - s.position.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent) {
    if (!drag.current) return;
    const p = toSvg(e);
    const { key, dx, dy } = drag.current;
    const x = Math.max(0, Math.round((p.x - dx) / 10) * 10);
    const y = Math.max(0, Math.round((p.y - dy) / 10) * 10);
    setSteps((ss) => ss.map((s) => (s.key === key ? { ...s, position: { x, y } } : s)));
    setDirty(true);
  }

  function connect(from: string, to: string) {
    setConnectFrom(null);
    if (from === to || edges.some((x) => x.from === from && x.to === to)) return;
    change(() => setEdges((es) => [...es, { from, to, label: null }]));
  }
  function addStep() {
    let n = steps.length + 1;
    while (byKey.has(`${newType}_${n}`)) n++;
    const key = `${newType}_${n}`;
    const anchor = step ?? steps[steps.length - 1];
    const s = blankStep(newType, key, anchor ? { x: anchor.position.x + W + 48, y: anchor.position.y } : { x: 40, y: 40 });
    change(() => {
      setSteps((ss) => [...ss, s]);
      if (anchor && !readOnly) setEdges((es) => [...es, { from: anchor.key, to: key, label: null }]);
    });
    setSelected(key);
  }
  function removeSelected(stepKey: string | null = selected) {
    if (selectedEdge != null && stepKey === selected) {
      change(() => setEdges((es) => es.filter((_, i) => i !== selectedEdge)));
      setSelectedEdge(null);
    } else if (stepKey) {
      change(() => {
        setSteps((ss) => ss.filter((s) => s.key !== stepKey));
        setEdges((es) => es.filter((x) => x.from !== stepKey && x.to !== stepKey));
      });
      setSelected(null);
    }
  }
  async function save() {
    const out = await run(
      () => apiFetch<{ version: number }>(`${WI_API}/workflows/${workflowId}/graph`, {
        method: "PUT",
        body: { steps: steps.map(({ id: _id, ...s }) => s), edges, changeNote: note || undefined },
      }),
      { success: "Model saved as a new version" },
    );
    if (out) {
      setDirty(false);
      setNote("");
    }
  }
  function onNodeKey(e: React.KeyboardEvent, key: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (connectFrom && connectFrom !== key) connect(connectFrom, key);
      else setSelected(key);
      return;
    }
    if (readOnly) return;
    const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key];
    if (delta) {
      e.preventDefault();
      const s = byKey.get(key)!;
      updateStep(key, { position: { x: Math.max(0, s.position.x + delta[0]!), y: Math.max(0, s.position.y + delta[1]!) } });
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setSelectedEdge(null);
      removeSelected(key);
    }
  }

  const edgePath = (from: EditableStep, to: EditableStep) => {
    const x1 = from.position.x + W;
    const y1 = from.position.y + H / 2;
    const x2 = to.position.x;
    const y2 = to.position.y + H / 2;
    if (x2 > x1 + 20) {
      const c = (x2 - x1) / 2;
      return { d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
    }
    // Backward/vertical edge: loop below.
    const yb = Math.max(from.position.y, to.position.y) + H + 30;
    return { d: `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${yb} ${(x1 + x2) / 2},${yb} S${x2 - 60},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: yb };
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader
          title="Process model"
          description={readOnly ? "Read-only — you need workflow.update to edit." : "Drag steps to arrange. Select a step to edit it; use Connect to draw an edge. Saving creates a new immutable version."}
          actions={dirty ? <Badge tone="warning">Unsaved changes</Badge> : undefined}
        />
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 pb-3">
            <Select size="sm" aria-label="Step type to add" value={newType} onChange={(e) => setNewType(e.target.value)} options={STEP_TYPES.map((t) => ({ value: t, label: STEP_TYPE_META[t]!.label }))} />
            <Button size="sm" variant="secondary" leftIcon={<Plus className="size-4" />} onClick={addStep}>Add step</Button>
            <Button size="sm" variant={connectFrom ? "primary" : "secondary"} leftIcon={<Link2 className="size-4" />} disabled={!selected} onClick={() => setConnectFrom(connectFrom ? null : selected)}>
              {connectFrom ? "Pick target… (Esc)" : "Connect"}
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<Trash2 className="size-4" />} disabled={!selected && selectedEdge == null} onClick={() => removeSelected()}>Delete</Button>
            <Button size="sm" variant="secondary" leftIcon={<LayoutGrid className="size-4" />} disabled={!steps.length} onClick={() => change(() => setSteps((ss) => autoLayout(ss, edges)))}>Auto-layout</Button>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <Input size="sm" aria-label="Change note" placeholder="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-48" />
              <Button size="sm" variant="ghost" leftIcon={<Undo2 className="size-4" />} disabled={!dirty} onClick={() => { setSteps(initialSteps); setEdges(initialEdges); setDirty(false); setSelected(null); }}>Discard</Button>
              <Button size="sm" leftIcon={<Save className="size-4" />} disabled={!dirty} loading={pending} onClick={save}>Save version</Button>
            </span>
          </div>
        )}
        <div className="overflow-auto" onKeyDown={(e) => e.key === "Escape" && setConnectFrom(null)}>
          {steps.length === 0 ? (
            <div className="grid place-items-center gap-2 p-10 text-center text-sm text-muted">
              <GitBranch className="size-6" aria-hidden />
              <p>No steps yet.{readOnly ? "" : " Pick a step type and choose Add step — start with a Trigger."}</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              role="group"
              aria-label="Workflow diagram"
              width={maxX}
              height={maxY}
              viewBox={`0 0 ${maxX} ${maxY}`}
              className="touch-none select-none"
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
              onPointerDown={() => { setSelected(null); setSelectedEdge(null); }}
            >
              <defs>
                <marker id="wi-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--color-border-strong)" />
                </marker>
              </defs>
              {edges.map((e, i) => {
                const from = byKey.get(e.from);
                const to = byKey.get(e.to);
                if (!from || !to) return null;
                const p = edgePath(from, to);
                const active = selectedEdge === i;
                return (
                  <g key={`${e.from}-${e.to}`} onPointerDown={(ev) => { ev.stopPropagation(); setSelectedEdge(i); setSelected(null); }} className="cursor-pointer">
                    <path d={p.d} fill="none" stroke="transparent" strokeWidth={12} />
                    <path d={p.d} fill="none" stroke={active ? "var(--color-accent)" : "var(--color-border-strong)"} strokeWidth={active ? 2.5 : 1.5} markerEnd="url(#wi-arrow)" />
                    {e.label && <text x={p.mx} y={p.my - 6} textAnchor="middle" className="fill-[var(--color-muted)] text-[11px]">{e.label}</text>}
                  </g>
                );
              })}
              {steps.map((s) => {
                const meta = STEP_TYPE_META[s.type]!;
                const isSel = selected === s.key;
                const control = s.type === "approval" || s.requiresApproval;
                return (
                  <g
                    key={s.key}
                    transform={`translate(${s.position.x},${s.position.y})`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSel}
                    aria-label={`${meta.label}: ${s.name}${control ? " (human control)" : ""}`}
                    className={cn("cursor-grab outline-none", connectFrom && connectFrom !== s.key && "cursor-crosshair")}
                    onPointerDown={(e) => onNodePointerDown(e, s.key)}
                    onKeyDown={(e) => onNodeKey(e, s.key)}
                  >
                    <rect width={W} height={H} rx={s.type === "decision" ? 18 : 8} fill="var(--color-surface)" stroke={isSel ? "var(--color-accent)" : connectFrom === s.key ? "var(--color-accent)" : "var(--color-border-strong)"} strokeWidth={isSel ? 2.5 : 1.25} />
                    <rect width={6} height={H} rx={3} fill={meta.color} />
                    <text x={16} y={20} className="fill-[var(--color-subtle)] text-[10px] font-semibold tracking-wide">{meta.short}{control ? " · CONTROL" : ""}</text>
                    <text x={16} y={38} className="fill-[var(--color-fg)] text-[12px] font-medium">{s.name.length > 22 ? `${s.name.slice(0, 21)}…` : s.name}</text>
                    <text x={16} y={52} className="fill-[var(--color-muted)] text-[10px]">{[s.role, s.durationMinutes ? `${s.durationMinutes} min` : null].filter(Boolean).join(" · ")}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <CardBody className="flex flex-wrap gap-3 border-t border-border text-xs text-muted">
          {STEP_TYPES.map((t) => (
            <span key={t} className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm" style={{ background: STEP_TYPE_META[t]!.color }} aria-hidden />{STEP_TYPE_META[t]!.label}</span>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={step ? "Step details" : selectedEdge != null ? "Connection" : "Details"} />
        <CardBody>
          {step ? (
            <StepForm step={step} readOnly={readOnly} onChange={(patch) => updateStep(step.key, patch)} />
          ) : selectedEdge != null && edges[selectedEdge] ? (
            <FormField id="edge-label" label={`${edges[selectedEdge]!.from} → ${edges[selectedEdge]!.to}`} hint="Label, e.g. yes / no for a decision">
              {(a) => <Input {...a} disabled={readOnly} value={edges[selectedEdge]!.label ?? ""} onChange={(e) => change(() => setEdges((es) => es.map((x, i) => (i === selectedEdge ? { ...x, label: e.target.value || null } : x))))} />}
            </FormField>
          ) : (
            <p className="text-sm text-muted">Select a step or connection in the diagram. Steps are keyboard-focusable: Tab to a step, Enter to select, arrow keys to move, Delete to remove.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function StepForm({ step, readOnly, onChange }: { step: EditableStep; readOnly: boolean; onChange: (p: Partial<EditableStep>) => void }) {
  const num = (k: keyof EditableStep, label: string, hint?: string, max?: number, stepSize = 1) => (
    <FormField id={`st-${String(k)}`} label={label} hint={hint}>
      {(a) => <Input {...a} type="number" min={0} max={max} step={stepSize} disabled={readOnly} value={String(step[k] ?? 0)} onChange={(e) => onChange({ [k]: Number(e.target.value) } as Partial<EditableStep>)} />}
    </FormField>
  );
  const txt = (k: "owner" | "role" | "system" | "input" | "output", label: string) => (
    <FormField id={`st-${k}`} label={label}>{(a) => <Input {...a} disabled={readOnly} value={step[k] ?? ""} onChange={(e) => onChange({ [k]: e.target.value || null })} />}</FormField>
  );
  return (
    <div className="space-y-3">
      <p className="font-mono text-xs text-subtle">key: {step.key}</p>
      <FormField id="st-name" label="Name">{(a) => <Input {...a} disabled={readOnly} value={step.name} onChange={(e) => onChange({ name: e.target.value })} />}</FormField>
      <FormField id="st-type" label="Type">{(a) => <Select {...a} disabled={readOnly} value={step.type} onChange={(e) => onChange({ type: e.target.value as EditableStep["type"], ...(e.target.value === "approval" ? { requiresApproval: true } : {}) })} options={STEP_TYPES.map((t) => ({ value: t, label: STEP_TYPE_META[t]!.label }))} />}</FormField>
      <FormField id="st-desc" label="Description">{(a) => <Textarea {...a} rows={2} disabled={readOnly} value={step.description} onChange={(e) => onChange({ description: e.target.value })} />}</FormField>
      <div className="grid grid-cols-2 gap-3">
        {txt("owner", "Owner")}
        {txt("role", "Role")}
        {txt("system", "System")}
        {txt("input", "Input")}
        {txt("output", "Output")}
        {num("durationMinutes", "Duration (min)", "Hands-on time")}
        {num("waitMinutes", "Wait (min)", "Queue/idle time")}
        {num("frequencyPerRun", "Runs / execution", undefined, 10000, 0.1)}
        {num("costPerExecution", "Direct cost ($)", "Per run of this step", undefined, 0.01)}
        {num("errorRate", "Error rate", "0–1", 1, 0.01)}
        {num("reworkRate", "Rework rate", "0–1", 1, 0.01)}
        <FormField id="st-risk" label="Risk">{(a) => <Select {...a} disabled={readOnly} value={step.risk} onChange={(e) => onChange({ risk: e.target.value as EditableStep["risk"] })} options={["low", "medium", "high", "critical"].map((v) => ({ value: v, label: v }))} />}</FormField>
        <FormField id="st-auto" label="Automation potential">{(a) => <Select {...a} disabled={readOnly} value={step.automationPotential} onChange={(e) => onChange({ automationPotential: e.target.value as EditableStep["automationPotential"] })} options={["unknown", "none", "low", "medium", "high"].map((v) => ({ value: v, label: v }))} />}</FormField>
      </div>
      <Checkbox label="Requires human approval" description="Marks a control the AI redesign may never remove." disabled={readOnly || step.type === "approval"} checked={step.requiresApproval} onChange={(e) => onChange({ requiresApproval: e.target.checked })} />
    </div>
  );
}
