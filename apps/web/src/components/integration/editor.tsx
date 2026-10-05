"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, CheckCircle2, FlaskConical, LayoutGrid, Link2, Pause, Play, Plus, Rocket, Save, Settings2, Trash2, Undo2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, CodeBlock, FormField, Input, Modal, Select, Textarea, cn } from "@eaop/design-system";
import { type ActionView, type EdgeDef, type ExecutionDetail, type GraphIssue, type NodeDef, type WorkflowDetail } from "@eaop/module-integration-hub";
import { useMutation } from "@/components/actions";
import { apiFetch } from "@/lib/client";
import { EDGE_META, IH, JsonField, NODE_META, StatusPill } from "./common";
import { WorkflowSettings } from "./workflows";

const W = 172;
const H = 60;
const NODE_TYPES = Object.keys(NODE_META);
const EDGE_KINDS_FOR: Record<string, string[]> = {
  trigger: ["next"], connector_action: ["next", "error"], ai_step: ["next", "error"], transform: ["next", "error"], condition: ["true", "false"],
  human_approval: ["next", "rejected"], delay: ["next"], retry: ["next"], branch: ["case", "next"], exception_handler: ["next"], completion: [],
};
const DEFAULT_CONFIG: Record<string, Record<string, unknown>> = {
  trigger: {},
  connector_action: { actionKey: "", input: {} },
  ai_step: { instructions: "Describe what the model should extract or decide.", input: { text: "{{input.text}}" }, outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] }, dataClassification: "internal", maxTokens: 1000 },
  transform: { mappings: [{ target: "field", source: "input.field" }] },
  condition: { condition: { field: "context.input.amount", op: "gt", value: 1000 } },
  human_approval: { title: "Approve", reason: "Explain why a person must decide.", risk: "medium", payload: {}, expiresHours: 72 },
  delay: { seconds: 300 },
  retry: { maxAttempts: 3, backoffSeconds: 10 },
  branch: { path: "steps.classify.category" },
  exception_handler: { compensate: false, notify: true },
  completion: { output: {} },
};

type Perms = { create: boolean; manage: boolean; execute: boolean; history: boolean };

export function autoLayout(nodes: NodeDef[], edges: EdgeDef[]): NodeDef[] {
  const indeg = new Map(nodes.map((n) => [n.key, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const layer = new Map<string, number>();
  const queue = nodes.filter((n) => n.type === "trigger" || !indeg.get(n.key)).map((n) => n.key);
  queue.forEach((k) => layer.set(k, 0));
  for (let guard = 0; queue.length && guard < 5000; guard++) {
    const k = queue.shift()!;
    for (const e of edges.filter((x) => x.from === k)) {
      const l = (layer.get(k) ?? 0) + 1;
      if ((layer.get(e.to) ?? -1) < l && l < nodes.length) {
        layer.set(e.to, l);
        queue.push(e.to);
      }
    }
  }
  const rows = new Map<number, number>();
  return nodes.map((n) => {
    const l = layer.get(n.key) ?? 0;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    return { ...n, position: { x: 40 + l * (W + 56), y: 40 + r * (H + 60) } };
  });
}

export function WorkflowEditor({ workflow, actions, eventTypes, perms }: { workflow: WorkflowDetail; actions: ActionView[]; eventTypes: string[]; perms: Perms }) {
  const router = useRouter();
  const [nodes, setNodes] = useState<NodeDef[]>(workflow.nodes);
  const [edges, setEdges] = useState<EdgeDef[]>(workflow.edges);
  const [issues, setIssues] = useState<GraphIssue[]>(workflow.issues);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [connect, setConnect] = useState<{ from: string; kind: string } | null>(null);
  const [newType, setNewType] = useState("connector_action");
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [settings, setSettings] = useState(false);
  const [testing, setTesting] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ key: string; dx: number; dy: number } | null>(null);
  const { run, pending } = useMutation();
  const readOnly = !perms.create || workflow.status === "archived";

  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const node = selected ? byKey.get(selected) : undefined;
  const issueNodes = new Set(issues.map((i) => i.node).filter(Boolean));
  const maxX = Math.max(640, ...nodes.map((n) => n.position.x + W + 60));
  const maxY = Math.max(280, ...nodes.map((n) => n.position.y + H + 70));

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
  };
  const updateNode = (key: string, patch: Partial<NodeDef>) => change(() => setNodes((ns) => ns.map((n) => (n.key === key ? { ...n, ...patch } : n))));
  const updateConfig = (key: string, patch: Record<string, unknown>) => change(() => setNodes((ns) => ns.map((n) => (n.key === key ? { ...n, config: { ...n.config, ...patch } } : n))));

  function toSvg(e: { clientX: number; clientY: number }) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  }
  function addEdge(from: string, to: string, kind: string) {
    setConnect(null);
    if (from === to || edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return;
    change(() => setEdges((es) => [...es, { from, to, kind: kind as EdgeDef["kind"], label: kind === "case" ? "value" : null }]));
    if (kind === "case") setSelectedEdge(edges.length);
  }
  function onNodeDown(e: ReactPointerEvent, key: string) {
    e.stopPropagation();
    if (connect && connect.from !== key) return addEdge(connect.from, key, connect.kind);
    setSelected(key);
    setSelectedEdge(null);
    if (readOnly) return;
    const n = byKey.get(key)!;
    const p = toSvg(e);
    drag.current = { key, dx: p.x - n.position.x, dy: p.y - n.position.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: ReactPointerEvent) {
    if (!drag.current) return;
    const p = toSvg(e);
    const { key, dx, dy } = drag.current;
    setNodes((ns) => ns.map((n) => (n.key === key ? { ...n, position: { x: Math.max(0, Math.round((p.x - dx) / 10) * 10), y: Math.max(0, Math.round((p.y - dy) / 10) * 10) } } : n)));
    setDirty(true);
  }
  function addNode() {
    let i = nodes.filter((n) => n.type === newType).length + 1;
    while (byKey.has(`${newType}_${i}`)) i++;
    const key = `${newType}_${i}`;
    const anchor = node ?? nodes[nodes.length - 1];
    change(() => setNodes((ns) => [...ns, { key, type: newType as NodeDef["type"], name: NODE_META[newType]!.label, config: structuredClone(DEFAULT_CONFIG[newType] ?? {}), position: anchor ? { x: anchor.position.x + W + 56, y: anchor.position.y + 20 } : { x: 40, y: 40 } }]));
    setSelected(key);
    setSelectedEdge(null);
  }
  function remove() {
    if (selectedEdge != null) {
      change(() => setEdges((es) => es.filter((_, i) => i !== selectedEdge)));
      setSelectedEdge(null);
    } else if (selected) {
      const k = selected;
      change(() => {
        setNodes((ns) => ns.filter((n) => n.key !== k));
        setEdges((es) => es.filter((e) => e.from !== k && e.to !== k));
      });
      setSelected(null);
    }
  }
  async function save() {
    const r = await run(() => apiFetch<{ version: number; issues: GraphIssue[] }>(`${IH}/workflows/${workflow.id}/graph`, { method: "PUT", body: { nodes, edges, changeNote: note || undefined } }), { success: "Saved as a new version" });
    if (r) {
      setIssues(r.issues);
      setDirty(false);
      setNote("");
    }
  }
  const edgePath = (a: NodeDef, b: NodeDef, i: number) => {
    const x1 = a.position.x + W;
    const y1 = a.position.y + H / 2;
    const x2 = b.position.x;
    const y2 = b.position.y + H / 2;
    if (x2 > x1 + 20) {
      const c = (x2 - x1) / 2;
      return { d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
    }
    const yb = Math.max(a.position.y, b.position.y) + H + 28 + (i % 3) * 10;
    return { d: `M${x1},${y1} C${x1 + 60},${y1} ${x1 + 60},${yb} ${(x1 + x2) / 2},${yb} S${x2 - 60},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: yb };
  };
  const sourceKinds = node ? EDGE_KINDS_FOR[node.type] ?? [] : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={workflow.status} />
        <Badge>v{workflow.currentVersion}{workflow.publishedVersion ? ` · live v${workflow.publishedVersion}` : " · not published"}</Badge>
        <Badge>trigger: {workflow.triggerType}{workflow.triggerType === "event" ? ` (${String(workflow.triggerConfig.eventType)})` : ""}</Badge>
        {workflow.isSample && <Badge tone="warning">Sample · simulated connector</Badge>}
        <span className="ml-auto flex flex-wrap gap-2">
          {perms.create && <Button size="sm" variant="secondary" leftIcon={<Settings2 className="size-4" />} onClick={() => setSettings(true)}>Settings</Button>}
          {perms.execute && <Button size="sm" variant="secondary" leftIcon={<FlaskConical className="size-4" />} disabled={dirty} onClick={() => setTesting(true)}>Test run</Button>}
          {perms.manage && workflow.status === "active" && <Button size="sm" variant="secondary" leftIcon={<Pause className="size-4" />} loading={pending} onClick={() => run(() => apiFetch(`${IH}/workflows/${workflow.id}/status`, { body: { status: "paused" } }), { success: "Paused" })}>Pause</Button>}
          {perms.manage && workflow.status === "paused" && <Button size="sm" variant="secondary" leftIcon={<Play className="size-4" />} loading={pending} onClick={() => run(() => apiFetch(`${IH}/workflows/${workflow.id}/status`, { body: { status: "active" } }), { success: "Activated" })}>Activate</Button>}
          {perms.manage && workflow.status !== "archived" && (
            <Button size="sm" leftIcon={<Rocket className="size-4" />} disabled={dirty || issues.length > 0} loading={pending} title={issues.length ? "Fix the issues first" : dirty ? "Save first" : undefined}
              onClick={() => run(() => apiFetch(`${IH}/workflows/${workflow.id}/publish`, { method: "POST" }), { success: `Published v${workflow.currentVersion}` })}>
              Publish v{workflow.currentVersion}
            </Button>
          )}
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <Select size="sm" aria-label="Node type to add" value={newType} onChange={(e) => setNewType(e.target.value)} options={NODE_TYPES.map((t) => ({ value: t, label: NODE_META[t]!.label }))} />
              <Button size="sm" variant="secondary" leftIcon={<Plus className="size-4" />} onClick={addNode}>Add</Button>
              <span className="flex items-center gap-1">
                <Button size="sm" variant={connect ? "primary" : "secondary"} leftIcon={<Link2 className="size-4" />} disabled={!node || sourceKinds.length === 0} onClick={() => setConnect(connect ? null : { from: node!.key, kind: sourceKinds[0]! })}>
                  {connect ? "Click the target… (Esc)" : "Connect"}
                </Button>
                {connect && sourceKinds.length > 1 && (
                  <Select size="sm" aria-label="Edge kind" value={connect.kind} onChange={(e) => setConnect({ ...connect, kind: e.target.value })} options={sourceKinds.map((k) => ({ value: k, label: EDGE_META[k]!.label }))} />
                )}
              </span>
              <Button size="sm" variant="secondary" leftIcon={<Trash2 className="size-4" />} disabled={!selected && selectedEdge == null} onClick={remove}>Delete</Button>
              <Button size="sm" variant="secondary" leftIcon={<LayoutGrid className="size-4" />} onClick={() => change(() => setNodes((ns) => autoLayout(ns, edges)))}>Auto-layout</Button>
              <span className="ml-auto flex flex-wrap items-center gap-2">
                {dirty && <Badge tone="warning">Unsaved</Badge>}
                <Input size="sm" aria-label="Change note" placeholder="Change note" className="w-40" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button size="sm" variant="ghost" leftIcon={<Undo2 className="size-4" />} disabled={!dirty} onClick={() => { setNodes(workflow.nodes); setEdges(workflow.edges); setDirty(false); setSelected(null); }}>Discard</Button>
                <Button size="sm" leftIcon={<Save className="size-4" />} disabled={!dirty} loading={pending} onClick={save}>Save</Button>
              </span>
            </div>
          )}
          <div className="overflow-auto" onKeyDown={(e) => e.key === "Escape" && setConnect(null)}>
            <svg ref={svgRef} role="group" aria-label="Workflow editor canvas" width={maxX} height={maxY} viewBox={`0 0 ${maxX} ${maxY}`} className="touch-none select-none"
              onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerDown={() => { setSelected(null); setSelectedEdge(null); }}>
              <defs>
                {Object.entries(EDGE_META).map(([k, m]) => (
                  <marker key={k} id={`ih-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill={m.color} />
                  </marker>
                ))}
              </defs>
              {edges.map((e, i) => {
                const a = byKey.get(e.from);
                const b = byKey.get(e.to);
                if (!a || !b) return null;
                const p = edgePath(a, b, i);
                const m = EDGE_META[e.kind] ?? EDGE_META.next!;
                const label = e.kind === "case" ? `= ${e.label ?? "?"}` : e.kind === "next" ? null : m.label;
                return (
                  <g key={`${e.from}-${e.to}-${e.kind}`} className="cursor-pointer" onPointerDown={(ev) => { ev.stopPropagation(); setSelectedEdge(i); setSelected(null); }}>
                    <path d={p.d} fill="none" stroke="transparent" strokeWidth={12} />
                    <path d={p.d} fill="none" stroke={selectedEdge === i ? "var(--color-accent)" : m.color} strokeWidth={selectedEdge === i ? 2.5 : 1.5} strokeDasharray={m.dash} markerEnd={`url(#ih-arrow-${e.kind})`} />
                    {label && <text x={p.mx} y={p.my - 6} textAnchor="middle" className="fill-[var(--color-muted)] text-[11px]">{label}</text>}
                  </g>
                );
              })}
              {nodes.map((n) => {
                const meta = NODE_META[n.type]!;
                const isSel = selected === n.key;
                const bad = issueNodes.has(n.key);
                const sub = n.type === "connector_action" ? String(n.config.actionKey || "choose an action") : n.type === "delay" ? `${String(n.config.seconds)} s` : n.type === "retry" ? `${String(n.config.maxAttempts)}× / ${String(n.config.backoffSeconds)} s` : n.key;
                return (
                  <g key={n.key} transform={`translate(${n.position.x},${n.position.y})`} role="button" tabIndex={0} aria-pressed={isSel} aria-label={`${meta.label}: ${n.name}${bad ? " (has issues)" : ""}`}
                    className={cn("cursor-grab outline-none", connect && connect.from !== n.key && "cursor-crosshair")}
                    onPointerDown={(e) => onNodeDown(e, n.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (connect && connect.from !== n.key) addEdge(connect.from, n.key, connect.kind);
                        else setSelected(n.key);
                      }
                    }}>
                    <rect width={W} height={H} rx={n.type === "condition" || n.type === "branch" ? 20 : 8} fill="var(--color-surface)" stroke={isSel ? "var(--color-accent)" : bad ? "var(--color-danger)" : "var(--color-border-strong)"} strokeWidth={isSel || bad ? 2.5 : 1.25} />
                    <rect width={6} height={H} rx={3} fill={meta.color} />
                    <text x={16} y={19} className="fill-[var(--color-subtle)] text-[10px] font-semibold tracking-wide">{meta.short}</text>
                    <text x={16} y={37} className="fill-[var(--color-fg)] text-[12px] font-medium">{n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}</text>
                    <text x={16} y={52} className="fill-[var(--color-muted)] text-[10px]">{sub.length > 28 ? `${sub.slice(0, 27)}…` : sub}</text>
                  </g>
                );
              })}
            </svg>
          </div>
          <CardBody className="flex flex-wrap gap-3 border-t border-border text-xs text-muted">
            {Object.entries(EDGE_META).filter(([k]) => k !== "exhausted").map(([k, m]) => (
              <span key={k} className="inline-flex items-center gap-1"><svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke={m.color} strokeWidth="2" strokeDasharray={m.dash} /></svg>{m.label}</span>
            ))}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title={node ? NODE_META[node.type]!.label : selectedEdge != null ? "Connection" : "Inspector"} description={node ? NODE_META[node.type]!.help : undefined} />
            <CardBody>
              {node ? (
                <NodeForm key={node.key} node={node} actions={actions} readOnly={readOnly} onName={(name) => updateNode(node.key, { name })} onConfig={(p) => updateConfig(node.key, p)} />
              ) : selectedEdge != null && edges[selectedEdge] ? (
                <EdgeForm edge={edges[selectedEdge]!} sourceType={byKey.get(edges[selectedEdge]!.from)?.type ?? "trigger"} readOnly={readOnly} onChange={(patch) => change(() => setEdges((es) => es.map((e, i) => (i === selectedEdge ? { ...e, ...patch } : e))))} />
              ) : (
                <p className="text-sm text-muted">Select a node or connection. Nodes are keyboard-focusable: Tab to a node and press Enter to select it (or to finish a connection).</p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={issues.length ? `${issues.length} issue(s) block publishing` : "Ready to publish"} />
            <CardBody className="space-y-1 text-sm">
              {issues.length === 0 ? (
                <p className="flex items-center gap-2 text-success"><CheckCircle2 className="size-4" aria-hidden />The saved graph is valid.</p>
              ) : (
                issues.map((i, k) => (
                  <button key={k} type="button" className="flex w-full items-start gap-2 text-left text-danger hover:underline" onClick={() => i.node && byKey.has(i.node) && setSelected(i.node)}>
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{i.node ? <strong>{i.node}: </strong> : null}{i.message}</span>
                  </button>
                ))
              )}
              {dirty && <p className="text-xs text-muted">Issues reflect the last saved version.</p>}
            </CardBody>
          </Card>
        </div>
      </div>

      {settings && <WorkflowSettings mode="edit" workflow={workflow} eventTypes={eventTypes} onClose={() => { setSettings(false); router.refresh(); }} />}
      {testing && <TestRun workflow={workflow} canLive={workflow.status === "active"} canHistory={perms.history} onClose={() => setTesting(false)} />}
    </div>
  );
}

function EdgeForm({ edge, sourceType, readOnly, onChange }: { edge: EdgeDef; sourceType: string; readOnly: boolean; onChange: (p: Partial<EdgeDef>) => void }) {
  return (
    <div className="space-y-3">
      <p className="font-mono text-xs">{edge.from} → {edge.to}</p>
      <FormField id="edge-kind" label="Kind">{(a) => <Select {...a} disabled={readOnly} value={edge.kind} onChange={(e) => onChange({ kind: e.target.value as EdgeDef["kind"] })} options={(EDGE_KINDS_FOR[sourceType] ?? ["next"]).map((k) => ({ value: k, label: EDGE_META[k]!.label }))} />}</FormField>
      {edge.kind === "case" && <FormField id="edge-label" label="Case value" hint="Matched against the branch value (as text).">{(a) => <Input {...a} disabled={readOnly} value={edge.label ?? ""} onChange={(e) => onChange({ label: e.target.value })} />}</FormField>}
    </div>
  );
}

function NodeForm({ node, actions, readOnly, onName, onConfig }: { node: NodeDef; actions: ActionView[]; readOnly: boolean; onName: (n: string) => void; onConfig: (p: Record<string, unknown>) => void }) {
  const c = node.config;
  const num = (k: string, label: string, hint?: string) => (
    <FormField id={`n-${k}`} label={label} hint={hint}>{(a) => <Input {...a} type="number" min={1} disabled={readOnly} value={String(c[k] ?? "")} onChange={(e) => onConfig({ [k]: Number(e.target.value) })} />}</FormField>
  );
  const action = actions.find((a) => a.key === c.actionKey);
  return (
    <div className="space-y-3">
      <p className="font-mono text-xs text-subtle">key: {node.key}</p>
      <FormField id="n-name" label="Name">{(a) => <Input {...a} disabled={readOnly} value={node.name} onChange={(e) => onName(e.target.value)} />}</FormField>
      {node.type === "connector_action" && (
        <>
          <FormField id="n-action" label="Action">{(a) => <Select {...a} disabled={readOnly} value={String(c.actionKey ?? "")} onChange={(e) => onConfig({ actionKey: e.target.value })} options={[{ value: "", label: "Choose…" }, ...actions.filter((x) => x.status === "active").map((x) => ({ value: x.key, label: `${x.name} (${x.key})` }))]} />}</FormField>
          {action && (
            <div className="space-y-1 rounded-md border border-border p-2 text-xs">
              <p><strong>{action.connectorName}</strong> · {action.capability} · {action.operation} · {action.risk} risk{action.requiresApproval ? " · approval required" : ""}</p>
              <p className="text-muted">Inputs: {Object.entries(action.inputSchema.properties ?? {}).map(([k]) => `${k}${action.inputSchema.required?.includes(k) ? "*" : ""}`).join(", ") || "none"}</p>
            </div>
          )}
          <JsonField id="n-input" label="Input template — use {{input.x}}, {{steps.node.field}}" value={c.input} onValid={(v) => onConfig({ input: v })} disabled={readOnly} rows={6} />
          <p className="text-xs text-muted">Retries: {action ? `${action.retry.maxAttempts}× from ${action.retry.backoffSeconds}s (action default) — precede with a Retry node to override.` : "set on the action, or with a Retry node."}</p>
        </>
      )}
      {node.type === "ai_step" && (
        <>
          <FormField id="n-instr" label="Instructions">{(a) => <Textarea {...a} rows={4} disabled={readOnly} value={String(c.instructions ?? "")} onChange={(e) => onConfig({ instructions: e.target.value })} />}</FormField>
          <JsonField id="n-ai-input" label="Input template" value={c.input} onValid={(v) => onConfig({ input: v })} disabled={readOnly} rows={4} />
          <JsonField id="n-ai-out" label="Output schema (validated)" value={c.outputSchema} onValid={(v) => onConfig({ outputSchema: v })} disabled={readOnly} rows={6} />
          <FormField id="n-class" label="Data classification" hint="Passed to the shared AI layer's routing and policy.">{(a) => <Select {...a} disabled={readOnly} value={String(c.dataClassification ?? "internal")} onChange={(e) => onConfig({ dataClassification: e.target.value })} options={["public", "internal", "confidential", "restricted"].map((v) => ({ value: v, label: v }))} />}</FormField>
          {num("maxTokens", "Max output tokens")}
        </>
      )}
      {node.type === "transform" && <MappingEditor value={(c.mappings as MappingRow[]) ?? []} readOnly={readOnly} onChange={(mappings) => onConfig({ mappings })} />}
      {node.type === "condition" && <ConditionEditor value={c.condition} readOnly={readOnly} onChange={(condition) => onConfig({ condition })} />}
      {node.type === "branch" && <FormField id="n-path" label="Value path" hint="e.g. steps.classify.category">{(a) => <Input {...a} disabled={readOnly} value={String(c.path ?? "")} onChange={(e) => onConfig({ path: e.target.value })} />}</FormField>}
      {node.type === "human_approval" && (
        <>
          <FormField id="n-title" label="Title">{(a) => <Input {...a} disabled={readOnly} value={String(c.title ?? "")} onChange={(e) => onConfig({ title: e.target.value })} />}</FormField>
          <FormField id="n-reason" label="Reason shown to approvers">{(a) => <Textarea {...a} rows={2} disabled={readOnly} value={String(c.reason ?? "")} onChange={(e) => onConfig({ reason: e.target.value })} />}</FormField>
          <FormField id="n-impact" label="Business impact">{(a) => <Input {...a} disabled={readOnly} value={String(c.businessImpact ?? "")} onChange={(e) => onConfig({ businessImpact: e.target.value })} />}</FormField>
          <FormField id="n-risk" label="Risk">{(a) => <Select {...a} disabled={readOnly} value={String(c.risk ?? "medium")} onChange={(e) => onConfig({ risk: e.target.value })} options={["low", "medium", "high", "critical"].map((v) => ({ value: v, label: v }))} />}</FormField>
          <JsonField id="n-payload" label="Proposed payload shown to approvers" value={c.payload} onValid={(v) => onConfig({ payload: v })} disabled={readOnly} rows={5} />
          {num("expiresHours", "Expires after (hours)")}
        </>
      )}
      {node.type === "delay" && num("seconds", "Delay (seconds)", "Up to 30 days. Skipped in test runs.")}
      {node.type === "retry" && (
        <>
          {num("maxAttempts", "Max attempts", "Applies to the next node")}
          {num("backoffSeconds", "Initial backoff (s)", "Doubles each attempt; never shorter than the system's Retry-After")}
        </>
      )}
      {node.type === "exception_handler" && (
        <>
          <Checkbox label="Run compensating actions" description="Best effort, newest first. External systems are not transactional; steps without a compensating action are reported as not reversible." disabled={readOnly} checked={!!c.compensate} onChange={(e) => onConfig({ compensate: e.target.checked })} />
          <Checkbox label="Notify the initiator" disabled={readOnly} checked={c.notify !== false} onChange={(e) => onConfig({ notify: e.target.checked })} />
        </>
      )}
      {node.type === "completion" && <JsonField id="n-output" label="Output template" value={c.output} onValid={(v) => onConfig({ output: v })} disabled={readOnly} rows={6} />}
      {node.type === "trigger" && <p className="text-sm text-muted">The run input is available as <code>{"{{input.…}}"}</code>. Configure the trigger type and input schema under Settings.</p>}
    </div>
  );
}

type MappingRow = { target: string; source?: string; value?: unknown; compute?: { op: string; args: [string | number, string | number] }; transforms?: string[]; type?: string; required?: boolean; fallback?: unknown };
const TRANSFORMS = ["trim", "lowercase", "uppercase", "round_2", "round_0", "abs", "split_comma", "join_comma", "first", "count", "digits_only"];

export function MappingEditor({ value, readOnly, onChange }: { value: MappingRow[]; readOnly: boolean; onChange: (v: MappingRow[]) => void }) {
  const set = (i: number, p: Partial<MappingRow>) => onChange(value.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const [sample, setSample] = useState<unknown>({ input: {} });
  const [preview, setPreview] = useState<{ output: unknown; issues: unknown[] } | null>(null);
  const { run, pending } = useMutation();
  return (
    <div className="space-y-3">
      {value.map((m, i) => {
        const kind = m.compute ? "compute" : m.value !== undefined ? "value" : "source";
        return (
          <div key={i} className="space-y-2 rounded-md border border-border p-2">
            <div className="grid grid-cols-2 gap-2">
              <Input size="sm" aria-label="Target field" placeholder="target.field" disabled={readOnly} value={m.target} onChange={(e) => set(i, { target: e.target.value })} />
              <Select size="sm" aria-label="Value kind" disabled={readOnly} value={kind}
                onChange={(e) => set(i, e.target.value === "compute" ? { compute: { op: "multiply", args: ["input.a", 1] }, source: undefined, value: undefined } : e.target.value === "value" ? { value: "", source: undefined, compute: undefined } : { source: "input.", value: undefined, compute: undefined })}
                options={[{ value: "source", label: "From path" }, { value: "value", label: "Literal / template" }, { value: "compute", label: "Compute" }]} />
            </div>
            {kind === "source" && <Input size="sm" aria-label="Source path" placeholder="input.customer.email" disabled={readOnly} value={m.source ?? ""} onChange={(e) => set(i, { source: e.target.value })} />}
            {kind === "value" && <Input size="sm" aria-label="Literal value or template" disabled={readOnly} value={String(m.value ?? "")} onChange={(e) => set(i, { value: e.target.value })} />}
            {kind === "compute" && m.compute && (
              <div className="grid grid-cols-3 gap-2">
                <Input size="sm" aria-label="Left operand" disabled={readOnly} value={String(m.compute.args[0])} onChange={(e) => set(i, { compute: { ...m.compute!, args: [isNaN(Number(e.target.value)) || e.target.value === "" ? e.target.value : Number(e.target.value), m.compute!.args[1]] } })} />
                <Select size="sm" aria-label="Operation" disabled={readOnly} value={m.compute.op} onChange={(e) => set(i, { compute: { ...m.compute!, op: e.target.value } })} options={["add", "subtract", "multiply", "divide", "percent"].map((o) => ({ value: o, label: o }))} />
                <Input size="sm" aria-label="Right operand" disabled={readOnly} value={String(m.compute.args[1])} onChange={(e) => set(i, { compute: { ...m.compute!, args: [m.compute!.args[0], isNaN(Number(e.target.value)) || e.target.value === "" ? e.target.value : Number(e.target.value)] } })} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Select size="sm" aria-label="Type" disabled={readOnly} value={m.type ?? ""} onChange={(e) => set(i, { type: e.target.value || undefined })} options={[{ value: "", label: "Keep type" }, ...["string", "number", "integer", "boolean", "date", "datetime", "json"].map((t) => ({ value: t, label: t }))]} />
              <Input size="sm" aria-label="Fallback value" placeholder="Fallback" disabled={readOnly} value={m.fallback === undefined ? "" : String(m.fallback)} onChange={(e) => set(i, { fallback: e.target.value === "" ? undefined : e.target.value })} />
            </div>
            <Input size="sm" aria-label="Transforms" placeholder={`Transforms: ${TRANSFORMS.slice(0, 4).join(", ")}…`} disabled={readOnly} value={(m.transforms ?? []).join(", ")} onChange={(e) => set(i, { transforms: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            <div className="flex items-center justify-between">
              <Checkbox label="Required" disabled={readOnly} checked={!!m.required} onChange={(e) => set(i, { required: e.target.checked })} />
              {!readOnly && <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</Button>}
            </div>
          </div>
        );
      })}
      {!readOnly && <Button size="sm" variant="secondary" leftIcon={<Plus className="size-4" />} onClick={() => onChange([...value, { target: "", source: "input." }])}>Add mapping</Button>}
      <details className="text-sm">
        <summary className="cursor-pointer text-accent">Preview with sample data</summary>
        <div className="mt-2 space-y-2">
          <JsonField id="map-sample" label="Sample scope ({ input, steps, vars })" value={sample} onValid={setSample} rows={5} />
          <Button size="sm" variant="secondary" loading={pending} onClick={async () => { const r = await run(() => apiFetch<{ output: unknown; issues: unknown[] }>(`${IH}/transformations/preview`, { body: { mappings: value, sample } }), { refresh: false }); if (r) setPreview(r); }}>Preview</Button>
          {preview && <CodeBlock code={JSON.stringify(preview, null, 2)} language="json" maxHeight="240px" />}
        </div>
      </details>
    </div>
  );
}

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "contains", "exists", "starts_with", "matches"];
function ConditionEditor({ value, readOnly, onChange }: { value: unknown; readOnly: boolean; onChange: (v: unknown) => void }) {
  const simple = value && typeof value === "object" && "field" in (value as object) ? (value as { field: string; op: string; value?: unknown }) : null;
  const [advanced, setAdvanced] = useState(!simple);
  if (advanced || !simple) {
    return (
      <div className="space-y-2">
        <JsonField id="n-cond" label="Condition (all / any / not / {field, op, value})" value={value} onValid={onChange} disabled={readOnly} rows={8} />
        {simple === null && !readOnly && <Button size="sm" variant="ghost" onClick={() => { onChange({ field: "context.input.amount", op: "gt", value: 0 }); setAdvanced(false); }}>Switch to a single comparison</Button>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <FormField id="c-field" label="Field" hint="context.input.…, context.steps.<node>.…">{(a) => <Input {...a} disabled={readOnly} value={simple.field} onChange={(e) => onChange({ ...simple, field: e.target.value })} />}</FormField>
      <FormField id="c-op" label="Operator">{(a) => <Select {...a} disabled={readOnly} value={simple.op} onChange={(e) => onChange({ ...simple, op: e.target.value })} options={OPS.map((o) => ({ value: o, label: o }))} />}</FormField>
      <FormField id="c-value" label="Value" hint="Numbers are compared as numbers.">{(a) => <Input {...a} disabled={readOnly} value={simple.value === undefined ? "" : typeof simple.value === "string" ? simple.value : JSON.stringify(simple.value)} onChange={(e) => { let v: unknown = e.target.value; try { v = JSON.parse(e.target.value); } catch { /* plain string */ } onChange({ ...simple, value: v }); }} />}</FormField>
      {!readOnly && <Button size="sm" variant="ghost" onClick={() => setAdvanced(true)}>Advanced (combine conditions)</Button>}
    </div>
  );
}

function TestRun({ workflow, canLive, canHistory, onClose }: { workflow: WorkflowDetail; canLive: boolean; canHistory: boolean; onClose: () => void }) {
  const [input, setInput] = useState<unknown>(() => sampleInput(workflow));
  const [mode, setMode] = useState<"test" | "live">("test");
  const [result, setResult] = useState<ExecutionDetail | null>(null);
  const { run, pending } = useMutation();
  return (
    <Modal open onClose={onClose} size="lg" title="Run workflow" description="Test mode runs the current draft: only simulated (sandbox) connectors are really called; other actions are validated and dry-run, approvals and delays are skipped, and AI steps use the configured provider (or schema samples if only the simulated provider exists)."
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={pending} onClick={async () => { const r = await run(() => apiFetch<ExecutionDetail>(`${IH}/workflows/${workflow.id}/executions`, { body: { input, mode, wait: true }, idempotencyKey: crypto.randomUUID() }), { refresh: false }); if (r) setResult(r); }}>Run</Button></>}>
      <div className="space-y-3">
        <FormField id="run-mode" label="Mode">{(a) => <Select {...a} value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")} options={[{ value: "test", label: "Test (sandbox / dry run)" }, ...(canLive ? [{ value: "live", label: `Live (published v${workflow.publishedVersion})` }] : [])]} />}</FormField>
        <JsonField id="run-input" label="Input" value={input} onValid={setInput} rows={8} />
        {result && (
          <div className="space-y-2 rounded-md border border-border p-3 text-sm" role="status">
            <p className="flex items-center gap-2">Result: <StatusPill status={result.status} />{result.errorMessage && <span className="text-danger">{result.errorMessage}</span>}</p>
            <CodeBlock code={JSON.stringify(result.output ?? result.steps.map((s) => ({ step: s.nodeKey, status: s.status })), null, 2)} language="json" maxHeight="240px" />
            {canHistory && <Link className="text-accent hover:underline" href={`${IH}/executions/${result.id}`}>Open the full execution history →</Link>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function sampleInput(w: WorkflowDetail): unknown {
  const props = w.inputSchema?.properties ?? {};
  return Object.fromEntries(Object.entries(props).map(([k, s]) => [k, s.format === "email" ? "customer@example.com" : s.type === "number" || s.type === "integer" ? (s.minimum ?? 1) : s.type === "boolean" ? false : s.enum?.[0] ?? "sample text for a test run"]));
}
