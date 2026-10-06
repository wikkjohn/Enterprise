import { z } from "zod";

/**
 * Data transformation: source fields → normalized fields → destination fields.
 * Pure functions; the execution scope is { input, steps, vars, execution }.
 */

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

/** Resolve "input.items[0].sku" against a scope. Unknown paths → undefined. */
export function resolvePath(scope: unknown, path: string): unknown {
  let cur: unknown = scope;
  for (const m of path.trim().matchAll(SEGMENT)) {
    const key = m[1] ?? m[2]!;
    if (FORBIDDEN.has(key)) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const i = Number(key);
      cur = Number.isInteger(i) ? cur[i] : key === "length" ? cur.length : undefined;
    } else cur = Object.prototype.hasOwnProperty.call(cur, key) ? (cur as Record<string, unknown>)[key] : undefined;
  }
  return cur;
}

/** Set a dotted path ("customer.address.city") on a plain object, creating parents. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = target;
  parts.forEach((p, i) => {
    if (FORBIDDEN.has(p)) throw new Error(`Invalid target field "${path}"`);
    if (i === parts.length - 1) cur[p] = value;
    else {
      if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
  });
}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const INLINE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Render a request template. A string that is exactly "{{path}}" becomes the
 * typed value at path; placeholders inside longer strings are interpolated.
 * Objects and arrays are rendered recursively; keys whose value renders to
 * undefined are dropped.
 */
export function render(template: unknown, scope: unknown): unknown {
  if (typeof template === "string") {
    const whole = template.match(WHOLE);
    if (whole) return resolvePath(scope, whole[1]!);
    return template.replace(INLINE, (_, p: string) => {
      const v = resolvePath(scope, p);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => render(t, scope));
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      if (FORBIDDEN.has(k)) continue;
      const r = render(v, scope);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return template;
}

export const TRANSFORMS = {
  trim: (v: unknown) => (typeof v === "string" ? v.trim() : v),
  lowercase: (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v),
  uppercase: (v: unknown) => (typeof v === "string" ? v.toUpperCase() : v),
  round_2: (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : v),
  round_0: (v: unknown) => (typeof v === "number" ? Math.round(v) : v),
  abs: (v: unknown) => (typeof v === "number" ? Math.abs(v) : v),
  split_comma: (v: unknown) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
  join_comma: (v: unknown) => (Array.isArray(v) ? v.join(", ") : v),
  first: (v: unknown) => (Array.isArray(v) ? v[0] : v),
  count: (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "string" ? v.length : v),
  digits_only: (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : v),
} as const;
export type TransformName = keyof typeof TRANSFORMS;

export const FIELD_TYPES = ["string", "number", "integer", "boolean", "date", "datetime", "json"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const mappingSchema = z.object({
  target: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, "target must be a dotted field name").max(200),
  source: z.string().max(300).optional(),
  /** Literal value used instead of a source path. */
  value: z.unknown().optional(),
  /** Arithmetic over two operands (path strings or numbers), e.g. pricing: quantity × unit price. */
  compute: z
    .object({ op: z.enum(["add", "subtract", "multiply", "divide", "percent"]), args: z.tuple([z.union([z.string().max(300), z.number()]), z.union([z.string().max(300), z.number()])]) })
    .optional(),
  transforms: z.array(z.enum(Object.keys(TRANSFORMS) as [TransformName, ...TransformName[]])).max(10).default([]),
  type: z.enum(FIELD_TYPES).optional(),
  required: z.boolean().default(false),
  fallback: z.unknown().optional(),
});
export type Mapping = z.infer<typeof mappingSchema>;
export const mappingsSchema = z.array(mappingSchema).min(1).max(200);

export interface MappingIssue {
  target: string;
  message: string;
}

/** Convert to a field type; returns { ok:false } when impossible (never guesses). */
export function convert(value: unknown, type: FieldType): { ok: true; value: unknown } | { ok: false } {
  switch (type) {
    case "string":
      return { ok: true, value: typeof value === "object" ? JSON.stringify(value) : String(value) };
    case "number":
    case "integer": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.replace(/[,\s]/g, "")) : typeof value === "boolean" ? Number(value) : NaN;
      if (!Number.isFinite(n)) return { ok: false };
      if (type === "integer" && !Number.isInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (typeof value === "number") return value === 0 || value === 1 ? { ok: true, value: value === 1 } : { ok: false };
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (["true", "yes", "y", "1"].includes(s)) return { ok: true, value: true };
        if (["false", "no", "n", "0"].includes(s)) return { ok: true, value: false };
      }
      return { ok: false };
    case "date":
    case "datetime": {
      const d = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
      if (!d || Number.isNaN(d.getTime())) return { ok: false };
      return { ok: true, value: type === "date" ? d.toISOString().slice(0, 10) : d.toISOString() };
    }
    case "json":
      if (typeof value === "string") {
        try {
          return { ok: true, value: JSON.parse(value) };
        } catch {
          return { ok: false };
        }
      }
      return { ok: true, value };
  }
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Apply mappings: resolve → transforms → fallback → type conversion → required check. */
export function applyMappings(mappings: Mapping[], scope: unknown): { output: Record<string, unknown>; issues: MappingIssue[] } {
  const output: Record<string, unknown> = {};
  const issues: MappingIssue[] = [];
  for (const m of mappings) {
    let v = m.compute ? compute(m.compute, scope) : m.value !== undefined ? render(m.value, scope) : m.source ? resolvePath(scope, m.source) : undefined;
    for (const t of m.transforms) v = TRANSFORMS[t](v);
    if (empty(v) && m.fallback !== undefined) v = m.fallback;
    if (empty(v)) {
      if (m.required) issues.push({ target: m.target, message: `is required but ${m.source ? `"${m.source}" is empty` : "no value was given"}` });
      continue;
    }
    if (m.type) {
      const c = convert(v, m.type);
      if (!c.ok) {
        if (m.fallback !== undefined && convert(m.fallback, m.type).ok) v = (convert(m.fallback, m.type) as { value: unknown }).value;
        else {
          issues.push({ target: m.target, message: `cannot convert ${JSON.stringify(v)?.slice(0, 60)} to ${m.type}` });
          continue;
        }
      } else v = c.value;
    }
    setPath(output, m.target, v);
  }
  return { output, issues };
}

/** Arithmetic on two operands; non-numeric operands or division by zero → undefined (never NaN). */
export function compute(c: { op: "add" | "subtract" | "multiply" | "divide" | "percent"; args: [string | number, string | number] }, scope: unknown): number | undefined {
  const num = (a: string | number) => {
    const v = typeof a === "number" ? a : resolvePath(scope, a);
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const [a, b] = [num(c.args[0]), num(c.args[1])];
  if (a === undefined || b === undefined) return undefined;
  const r = c.op === "add" ? a + b : c.op === "subtract" ? a - b : c.op === "multiply" ? a * b : c.op === "divide" ? (b === 0 ? NaN : a / b) : (a * b) / 100;
  return Number.isFinite(r) ? Math.round(r * 1e6) / 1e6 : undefined;
}
