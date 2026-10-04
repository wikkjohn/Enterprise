/**
 * Minimal in-process metrics registry with Prometheus text exposition.
 * Swap for an OpenTelemetry MeterProvider in production by implementing the
 * same `Metrics` interface — call sites do not change.
 */
type Labels = Record<string, string | number | boolean | undefined>;

export interface Metrics {
  increment(name: string, labels?: Labels, value?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
  snapshot(): MetricSnapshot[];
  toPrometheus(): string;
}

export interface MetricSnapshot {
  name: string;
  type: "counter" | "histogram";
  labels: Record<string, string>;
  value: number;
  count?: number;
  sum?: number;
  buckets?: Record<string, number>;
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function key(name: string, labels: Record<string, string>) {
  return name + JSON.stringify(Object.entries(labels).sort());
}
function normalize(labels?: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels ?? {})) if (v !== undefined) out[k] = String(v);
  return out;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, MetricSnapshot>();
  const histos = new Map<string, MetricSnapshot>();

  return {
    increment(name, labels, value = 1) {
      if (!NAME_RE.test(name)) throw new Error(`Invalid metric name ${name}`);
      const l = normalize(labels);
      const k = key(name, l);
      const cur = counters.get(k) ?? { name, type: "counter", labels: l, value: 0 };
      cur.value += value;
      counters.set(k, cur);
    },
    observe(name, value, labels) {
      if (!NAME_RE.test(name)) throw new Error(`Invalid metric name ${name}`);
      const l = normalize(labels);
      const k = key(name, l);
      const cur =
        histos.get(k) ??
        ({ name, type: "histogram", labels: l, value: 0, count: 0, sum: 0, buckets: Object.fromEntries(DEFAULT_BUCKETS.map((b) => [String(b), 0])) } as MetricSnapshot);
      cur.count = (cur.count ?? 0) + 1;
      cur.sum = (cur.sum ?? 0) + value;
      cur.value = value;
      for (const b of DEFAULT_BUCKETS) if (value <= b) cur.buckets![String(b)]! += 1;
      histos.set(k, cur);
    },
    snapshot() {
      return [...counters.values(), ...histos.values()].map((m) => ({ ...m, labels: { ...m.labels } }));
    },
    toPrometheus() {
      const lines: string[] = [];
      const fmt = (l: Record<string, string>) => {
        const e = Object.entries(l);
        return e.length ? `{${e.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",")}}` : "";
      };
      for (const c of counters.values()) lines.push(`${c.name}${fmt(c.labels)} ${c.value}`);
      for (const h of histos.values()) {
        for (const [b, n] of Object.entries(h.buckets ?? {})) lines.push(`${h.name}_bucket${fmt({ ...h.labels, le: b })} ${n}`);
        lines.push(`${h.name}_bucket${fmt({ ...h.labels, le: "+Inf" })} ${h.count}`);
        lines.push(`${h.name}_sum${fmt(h.labels)} ${h.sum}`);
        lines.push(`${h.name}_count${fmt(h.labels)} ${h.count}`);
      }
      return lines.join("\n") + "\n";
    },
  };
}
