import { type Provenance, type StepType } from "./schema";

/**
 * SAMPLE workflows for demos and evaluation. Loaded only on explicit request,
 * always stored with data_class = 'sample', and never aggregated with
 * production data. Figures are illustrative, not benchmarks.
 */

interface SampleStep {
  key: string;
  type: StepType;
  name: string;
  role?: string;
  system?: string;
  durationMinutes?: number;
  waitMinutes?: number;
  errorRate?: number;
  reworkRate?: number;
  requiresApproval?: boolean;
  automationPotential?: "unknown" | "none" | "low" | "medium" | "high";
  risk?: "low" | "medium" | "high" | "critical";
  position: { x: number; y: number };
}

interface SampleWorkflow {
  key: string;
  workflow: {
    name: string;
    description: string;
    department: string;
    ownerName: string;
    businessSponsor: string;
    frequency: "daily" | "weekly" | "monthly";
    annualVolume: number;
    systems: string[];
    roles: string[];
    riskCategory: "low" | "medium" | "high" | "critical";
    regulatoryCategory?: string;
  };
  steps: SampleStep[];
  edges: Array<{ from: string; to: string; label?: string }>;
  employeesInvolved: number;
  factors: Record<string, { value: number; provenance: Provenance; note?: string }>;
  costs: Array<{ category: "implementation" | "integration" | "software" | "ai_inference" | "support" | "other"; period: "one_time" | "annual" | "per_execution"; amount: number; provenance: Provenance; description: string }>;
}

const col = (i: number, row = 0) => ({ x: 40 + i * 200, y: 60 + row * 140 });

export const SAMPLE_WORKFLOWS: SampleWorkflow[] = [
  {
    key: "invoice",
    workflow: {
      name: "Supplier invoice processing",
      description: "Receive supplier invoices, match to POs and receipts, resolve exceptions, approve and post for payment.",
      department: "Finance",
      ownerName: "AP Manager (sample)",
      businessSponsor: "CFO (sample)",
      frequency: "daily",
      annualVolume: 24000,
      systems: ["Email", "ERP", "Document storage"],
      roles: ["AP clerk", "AP manager"],
      riskCategory: "medium",
      regulatoryCategory: "SOX",
    },
    steps: [
      { key: "receive", type: "trigger", name: "Invoice received", system: "Email", position: col(0) },
      { key: "key_in", type: "human_task", name: "Key invoice data", role: "AP clerk", system: "ERP", durationMinutes: 8, errorRate: 0.04, reworkRate: 0.03, automationPotential: "high", position: col(1) },
      { key: "match", type: "human_task", name: "3-way match to PO and receipt", role: "AP clerk", system: "ERP", durationMinutes: 6, errorRate: 0.02, automationPotential: "high", position: col(2) },
      { key: "matched", type: "decision", name: "Match within tolerance?", role: "AP clerk", durationMinutes: 1, position: col(3) },
      { key: "exception", type: "exception", name: "Resolve mismatch with buyer", role: "AP clerk", durationMinutes: 35, waitMinutes: 1440, automationPotential: "low", position: col(3, 1) },
      { key: "approve", type: "approval", name: "Manager approval", role: "AP manager", system: "ERP", durationMinutes: 3, requiresApproval: true, risk: "medium", position: col(4) },
      { key: "post", type: "system_action", name: "Post for payment", system: "ERP", position: col(5) },
      { key: "done", type: "completion", name: "Invoice posted", position: col(6) },
    ],
    edges: [
      { from: "receive", to: "key_in" }, { from: "key_in", to: "match" }, { from: "match", to: "matched" },
      { from: "matched", to: "approve", label: "yes" }, { from: "matched", to: "exception", label: "no" }, { from: "exception", to: "approve" },
      { from: "approve", to: "post" }, { from: "post", to: "done" },
    ],
    employeesInvolved: 6,
    factors: {
      repetitiveness: { value: 5, provenance: "fact" },
      decision_complexity: { value: 2, provenance: "assumption" },
      human_judgment: { value: 2, provenance: "assumption" },
      data_availability: { value: 4, provenance: "fact", note: "PDF invoices plus ERP PO data" },
      data_quality: { value: 3, provenance: "assumption" },
      integration_availability: { value: 4, provenance: "fact", note: "ERP has a REST API" },
      error_tolerance: { value: 3, provenance: "assumption" },
      security_sensitivity: { value: 3, provenance: "assumption" },
      regulatory_exposure: { value: 3, provenance: "fact", note: "SOX-relevant control" },
    },
    costs: [
      { category: "implementation", period: "one_time", amount: 60000, provenance: "assumption", description: "Build & integrate extraction and matching" },
      { category: "software", period: "annual", amount: 12000, provenance: "assumption", description: "Document AI licence" },
    ],
  },
  {
    key: "tickets",
    workflow: {
      name: "Customer support ticket triage",
      description: "Classify inbound tickets, route to the right queue, draft first responses.",
      department: "Customer Service",
      ownerName: "Support lead (sample)",
      businessSponsor: "VP Customer Experience (sample)",
      frequency: "daily",
      annualVolume: 120000,
      systems: ["Helpdesk", "CRM", "Knowledge base"],
      roles: ["Tier 1 agent", "Tier 2 agent"],
      riskCategory: "low",
    },
    steps: [
      { key: "ticket", type: "trigger", name: "Ticket created", system: "Helpdesk", position: col(0) },
      { key: "read", type: "human_task", name: "Read and categorize", role: "Tier 1 agent", system: "Helpdesk", durationMinutes: 3, errorRate: 0.08, automationPotential: "high", position: col(1) },
      { key: "lookup", type: "human_task", name: "Look up customer & history", role: "Tier 1 agent", system: "CRM", durationMinutes: 2, automationPotential: "high", position: col(2) },
      { key: "route", type: "decision", name: "Route to queue", role: "Tier 1 agent", durationMinutes: 1, automationPotential: "medium", position: col(3) },
      { key: "respond", type: "human_task", name: "Draft first response", role: "Tier 2 agent", system: "Helpdesk", durationMinutes: 7, automationPotential: "medium", position: col(4) },
      { key: "closed", type: "completion", name: "First response sent", position: col(5) },
    ],
    edges: [{ from: "ticket", to: "read" }, { from: "read", to: "lookup" }, { from: "lookup", to: "route" }, { from: "route", to: "respond" }, { from: "respond", to: "closed" }],
    employeesInvolved: 25,
    factors: {
      repetitiveness: { value: 4, provenance: "fact" },
      decision_complexity: { value: 2, provenance: "assumption" },
      human_judgment: { value: 2, provenance: "assumption" },
      data_availability: { value: 5, provenance: "fact" },
      data_quality: { value: 4, provenance: "assumption" },
      integration_availability: { value: 5, provenance: "fact" },
      error_tolerance: { value: 4, provenance: "assumption" },
      security_sensitivity: { value: 2, provenance: "assumption" },
      regulatory_exposure: { value: 1, provenance: "assumption" },
    },
    costs: [
      { category: "implementation", period: "one_time", amount: 45000, provenance: "assumption", description: "Classifier + helpdesk integration" },
      { category: "support", period: "annual", amount: 8000, provenance: "assumption", description: "Prompt and model maintenance" },
    ],
  },
  {
    key: "credit",
    workflow: {
      name: "Commercial credit limit review",
      description: "Annual review of customer credit limits using financials, payment history and external ratings.",
      department: "Risk",
      ownerName: "Credit manager (sample)",
      businessSponsor: "Chief Risk Officer (sample)",
      frequency: "weekly",
      annualVolume: 1500,
      systems: ["ERP", "Credit bureau", "Spreadsheet", "Document storage", "CRM"],
      roles: ["Credit analyst", "Credit manager", "Sales"],
      riskCategory: "high",
      regulatoryCategory: "Credit risk policy",
    },
    steps: [
      { key: "due", type: "trigger", name: "Review due", system: "ERP", position: col(0) },
      { key: "gather", type: "human_task", name: "Gather financials & bureau report", role: "Credit analyst", system: "Credit bureau", durationMinutes: 60, automationPotential: "high", position: col(1) },
      { key: "analyze", type: "human_task", name: "Spread financials and analyze", role: "Credit analyst", system: "Spreadsheet", durationMinutes: 120, errorRate: 0.05, automationPotential: "medium", position: col(2) },
      { key: "sales", type: "human_task", name: "Consult account owner", role: "Sales", durationMinutes: 20, waitMinutes: 2880, position: col(3) },
      { key: "recommend", type: "decision", name: "Recommend limit", role: "Credit analyst", durationMinutes: 30, automationPotential: "low", risk: "high", position: col(4) },
      { key: "approve", type: "approval", name: "Credit manager approval", role: "Credit manager", durationMinutes: 15, requiresApproval: true, risk: "high", position: col(5) },
      { key: "update", type: "system_action", name: "Update limit in ERP", system: "ERP", position: col(6) },
      { key: "done", type: "completion", name: "Review complete", position: col(7) },
    ],
    edges: [{ from: "due", to: "gather" }, { from: "gather", to: "analyze" }, { from: "analyze", to: "sales" }, { from: "sales", to: "recommend" }, { from: "recommend", to: "approve" }, { from: "approve", to: "update" }, { from: "update", to: "done" }],
    employeesInvolved: 8,
    factors: {
      repetitiveness: { value: 3, provenance: "assumption" },
      decision_complexity: { value: 4, provenance: "assumption" },
      human_judgment: { value: 4, provenance: "assumption" },
      data_availability: { value: 3, provenance: "assumption" },
      data_quality: { value: 2, provenance: "assumption", note: "Customer financials arrive as PDFs" },
      integration_availability: { value: 2, provenance: "assumption" },
      error_tolerance: { value: 1, provenance: "fact" },
      security_sensitivity: { value: 4, provenance: "fact" },
      regulatory_exposure: { value: 4, provenance: "fact" },
    },
    costs: [
      { category: "implementation", period: "one_time", amount: 150000, provenance: "assumption", description: "Financial spreading + bureau integration" },
      { category: "integration", period: "one_time", amount: 30000, provenance: "assumption", description: "Credit bureau API" },
      { category: "software", period: "annual", amount: 20000, provenance: "assumption", description: "Bureau data feed" },
    ],
  },
];
