import { type EdgeDef, type NodeDef } from "./schema";
import { type JsonSchema } from "./validation";

/**
 * SAMPLE workflow: customer request → AI interpretation → record lookup →
 * pricing → manager approval (large deals) → quote → CRM update → response.
 * It runs entirely against the SIMULATED sandbox connector; swap the actions
 * for real Salesforce / SAP actions to run it against production systems.
 */
export const SAMPLE_ACTIONS = [
  { templateKey: "sandbox.list_records", key: "sample.lookup_customer", name: "Look up customer (sample)" },
  { templateKey: "sandbox.list_records", key: "sample.check_inventory", name: "Check inventory (sample)" },
  { templateKey: "sandbox.create_record", key: "sample.create_quote", name: "Create quote (sample)" },
  { templateKey: "sandbox.create_record", key: "sample.update_crm", name: "Update CRM (sample)" },
] as const;

export const SAMPLE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["customerEmail", "request"],
  properties: {
    customerEmail: { type: "string", format: "email", description: "Customer email" },
    request: { type: "string", minLength: 5, maxLength: 4000, description: "The customer's message" },
  },
};

const at = (col: number, row = 0) => ({ x: 40 + col * 220, y: 60 + row * 150 });

export const SAMPLE_NODES: NodeDef[] = [
  { key: "request", type: "trigger", name: "Customer request", config: {}, position: at(0) },
  {
    key: "interpret",
    type: "ai_step",
    name: "AI interpretation",
    config: {
      instructions: "Extract the product SKU, the quantity requested and the urgency from the customer's message. If a value is missing, use quantity 1 and urgency normal.",
      input: { message: "{{input.request}}" },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sku", "quantity", "urgency"],
        properties: {
          sku: { type: "string", maxLength: 40, default: "SKU-100" },
          quantity: { type: "integer", minimum: 1, maximum: 100000, default: 120 },
          urgency: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
        },
      },
      dataClassification: "internal",
      maxTokens: 500,
    },
    position: at(1),
  },
  { key: "retry_lookup", type: "retry", name: "Retry lookups", config: { maxAttempts: 3, backoffSeconds: 5 }, position: at(2) },
  { key: "lookup", type: "connector_action", name: "CRM lookup", config: { actionKey: "sample.lookup_customer", input: { query: "{{input.customerEmail}}" } }, position: at(3) },
  { key: "inventory", type: "connector_action", name: "Inventory check", config: { actionKey: "sample.check_inventory", input: { query: "{{steps.interpret.sku}}" } }, position: at(4) },
  {
    key: "pricing",
    type: "transform",
    name: "Pricing logic",
    config: {
      mappings: [
        { target: "sku", source: "steps.interpret.sku", type: "string", required: true },
        { target: "quantity", source: "steps.interpret.quantity", type: "integer", required: true },
        { target: "unitPrice", value: 95, type: "number" },
        { target: "subtotal", compute: { op: "multiply", args: ["steps.interpret.quantity", 95] }, type: "number", required: true },
        { target: "discount", compute: { op: "percent", args: ["steps.interpret.quantity", 5] }, type: "number", fallback: 0 },
        { target: "customerEmail", source: "input.customerEmail", transforms: ["trim", "lowercase"], type: "string", required: true },
      ],
    },
    position: at(5),
  },
  { key: "large_deal", type: "condition", name: "Over $10,000?", config: { condition: { field: "context.steps.pricing.subtotal", op: "gt", value: 10000 } }, position: at(6) },
  {
    key: "manager_approval",
    type: "human_approval",
    name: "Manager approval",
    config: { title: "Approve large quote", reason: "Quotes over $10,000 need manager approval.", risk: "high", businessImpact: "Commits pricing to a customer.", payload: { customer: "{{steps.pricing.customerEmail}}", sku: "{{steps.pricing.sku}}", quantity: "{{steps.pricing.quantity}}", subtotal: "{{steps.pricing.subtotal}}" }, expiresHours: 48 },
    position: at(7),
  },
  { key: "quote", type: "connector_action", name: "Generate quote", config: { actionKey: "sample.create_quote", input: { name: "Quote {{steps.pricing.sku}} × {{steps.pricing.quantity}}", amount: "{{steps.pricing.subtotal}}", note: "for {{steps.pricing.customerEmail}}" } }, position: at(8) },
  { key: "crm", type: "connector_action", name: "CRM update", config: { actionKey: "sample.update_crm", input: { name: "Quote sent to {{steps.pricing.customerEmail}}", amount: "{{steps.pricing.subtotal}}" } }, position: at(9) },
  { key: "respond", type: "completion", name: "Customer response", config: { output: { status: "quoted", quote: "{{steps.quote.record}}", subtotal: "{{steps.pricing.subtotal}}", message: "Thank you — your quote for {{steps.pricing.quantity}} × {{steps.pricing.sku}} is ready." } }, position: at(10) },
  { key: "declined", type: "completion", name: "Declined", config: { output: { status: "declined", message: "We will follow up with an alternative offer." } }, position: at(8, 1) },
  { key: "on_error", type: "exception_handler", name: "Handle failure", config: { compensate: true, notify: true }, position: at(9, 1) },
  { key: "failed_response", type: "completion", name: "Apology", config: { output: { status: "error", message: "We could not complete your quote automatically; a representative will contact you." } }, position: at(10, 1) },
];

export const SAMPLE_EDGES: EdgeDef[] = [
  { from: "request", to: "interpret", kind: "next" },
  { from: "interpret", to: "retry_lookup", kind: "next" },
  { from: "retry_lookup", to: "lookup", kind: "next" },
  { from: "lookup", to: "inventory", kind: "next" },
  { from: "inventory", to: "pricing", kind: "next" },
  { from: "pricing", to: "large_deal", kind: "next" },
  { from: "large_deal", to: "manager_approval", kind: "true" },
  { from: "large_deal", to: "quote", kind: "false" },
  { from: "manager_approval", to: "quote", kind: "next" },
  { from: "manager_approval", to: "declined", kind: "rejected" },
  { from: "quote", to: "crm", kind: "next" },
  { from: "crm", to: "respond", kind: "next" },
  { from: "crm", to: "on_error", kind: "error" },
  { from: "on_error", to: "failed_response", kind: "next" },
];
