import { z } from "zod";

/**
 * A strict JSON-Schema subset for action inputs/outputs. Schemas are stored on
 * actions, validated here (pure, no I/O) and published verbatim as tool
 * definitions for AI callers — one schema, three uses.
 *
 * Supported: type object|string|number|integer|boolean|array, properties,
 * required, additionalProperties (default false), enum, minLength, maxLength,
 * pattern, format (email|uri|date|date-time|uuid), minimum, maximum, items,
 * minItems, maxItems, description, default.
 */
export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: Array<string | number>;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "uri" | "date" | "date-time" | "uuid";
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
}

const MAX_DEPTH = 6;

export const jsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(["object", "string", "number", "integer", "boolean", "array"]),
      description: z.string().max(1000).optional(),
      properties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), jsonSchemaSchema).optional(),
      required: z.array(z.string().max(64)).max(100).optional(),
      additionalProperties: z.boolean().optional(),
      enum: z.array(z.union([z.string().max(500), z.number()])).max(200).optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).max(1_000_000).optional(),
      pattern: z.string().max(200).optional(),
      format: z.enum(["email", "uri", "date", "date-time", "uuid"]).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      items: jsonSchemaSchema.optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).max(10_000).optional(),
      default: z.unknown().optional(),
    })
    .strict(),
);

/** Parse a stored/submitted schema; checks regex syntax and nesting depth. */
export function parseJsonSchema(raw: unknown): JsonSchema {
  const s = jsonSchemaSchema.parse(raw);
  const walk = (n: JsonSchema, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`Schema nesting deeper than ${MAX_DEPTH}`);
    if (n.pattern) new RegExp(n.pattern);
    for (const r of n.required ?? []) if (!n.properties?.[r]) throw new Error(`required field "${r}" is not in properties`);
    Object.values(n.properties ?? {}).forEach((c) => walk(c, depth + 1));
    if (n.items) walk(n.items, depth + 1);
  };
  walk(s, 0);
  return s;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^https?:\/\/[^\s]+$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

/**
 * Validate `value` against `schema`. Returns the value with defaults applied
 * (never mutates the input) and a list of issues. Unknown properties are
 * rejected unless additionalProperties is true.
 */
export function validate(schema: JsonSchema, value: unknown, path = ""): { value: unknown; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const at = path || "(root)";
  const push = (message: string) => issues.push({ path: at, message });
  if (value === undefined || value === null) {
    if (schema.default !== undefined) return { value: structuredClone(schema.default), issues };
    return { value, issues };
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        push("must be an object");
        return { value, issues };
      }
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};
      for (const r of schema.required ?? []) {
        const v = src[r];
        if ((v === undefined || v === null || v === "") && props[r]?.default === undefined) issues.push({ path: join(path, r), message: "is required" });
      }
      for (const [k, v] of Object.entries(src)) {
        if (!props[k]) {
          if (schema.additionalProperties) out[k] = v;
          else issues.push({ path: join(path, k), message: "is not an allowed field" });
        }
      }
      for (const [k, child] of Object.entries(props)) {
        const r = validate(child, src[k], join(path, k));
        issues.push(...r.issues);
        if (r.value !== undefined) out[k] = r.value;
      }
      return { value: out, issues };
    }
    case "string": {
      if (typeof value !== "string") {
        push("must be a string");
        break;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) push("has an invalid format");
      if (schema.format && !FORMATS[schema.format]!.test(value)) push(`must be a valid ${schema.format}`);
      if (schema.enum && !schema.enum.includes(value)) push(`must be one of ${schema.enum.join(", ")}`);
      break;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        push(`must be a ${schema.type}`);
        break;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) push("must be an integer");
      if (schema.minimum !== undefined && value < schema.minimum) push(`must be ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) push(`must be ≤ ${schema.maximum}`);
      if (schema.enum && !schema.enum.includes(value)) push(`must be one of ${schema.enum.join(", ")}`);
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") push("must be true or false");
      break;
    case "array": {
      if (!Array.isArray(value)) {
        push("must be an array");
        break;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) push(`must have at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) push(`must have at most ${schema.maxItems} items`);
      if (schema.items) {
        const out = value.map((v, i) => {
          const r = validate(schema.items!, v, `${path}[${i}]`);
          issues.push(...r.issues);
          return r.value;
        });
        return { value: out, issues };
      }
      break;
    }
  }
  return { value, issues };
}

const join = (base: string, key: string) => (base ? `${base}.${key}` : key);

/** Tool definition for AI callers (name, description, JSON schema). */
export function toolDefinition(action: { key: string; name: string; description: string; inputSchema: JsonSchema; risk: string; requiresApproval: boolean }) {
  return {
    name: action.key,
    description: `${action.name}. ${action.description}`.trim() + ` Risk: ${action.risk}.${action.requiresApproval ? " Requires human approval before it runs." : ""}`,
    input_schema: action.inputSchema,
  };
}
