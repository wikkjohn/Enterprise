/**
 * Starter content for a new organization: implementation patterns and a
 * role-based use-case library. Everything is created as a DRAFT the Center of
 * Excellence reviews and adapts before publishing — none of it is presented
 * as already approved.
 */

export const DEPARTMENTS = ["Sales", "Finance", "HR", "Procurement", "Legal", "Operations", "Customer Support", "IT", "Marketing"] as const;

export interface TemplateSeed {
  key: string;
  name: string;
  category: string;
  businessObjective: string;
  systems: string[];
  data: string;
  aiCapability: string;
  riskLevel: "low" | "medium" | "high";
  risks: string;
  implementation: string[];
  measurement: string[];
}

export const TEMPLATE_SEEDS: TemplateSeed[] = [
  {
    key: "document_summarization", name: "Document summarization", category: "content",
    businessObjective: "Cut the time people spend reading long documents (reports, tickets, case files) to decide what to do next.",
    systems: ["Document store (SharePoint, Google Drive, Box)", "Platform AI layer"], data: "Internal documents; classification decides which models may be used.",
    aiCapability: "Summarization with citations back to the source passages (use Knowledge & Verification for grounded answers).", riskLevel: "low",
    risks: "Summaries can omit important caveats. Keep the source one click away and never use a summary as the record.",
    implementation: ["Pick one document type and its readers", "Define the summary format with them", "Ground summaries in the source (citations)", "Pilot with 10–20 users for two weeks", "Roll out with training on when not to rely on a summary"],
    measurement: ["Minutes spent per document (before/after)", "Reader rating of summary usefulness", "Error reports per 100 summaries"],
  },
  {
    key: "customer_response", name: "Customer response drafting", category: "customer_service",
    businessObjective: "Faster, consistent first responses to customer emails and tickets.",
    systems: ["Ticketing (ServiceNow, Zendesk)", "Knowledge base", "Platform AI layer"], data: "Customer messages (personal data), approved knowledge articles.",
    aiCapability: "Draft generation grounded in approved knowledge; agent reviews and sends.", riskLevel: "medium",
    risks: "Wrong or invented commitments to customers; personal data in prompts. Keep a human sending every response; DLP on prompts.",
    implementation: ["Connect the ticketing system through Integration", "Ground drafts in approved articles only", "Human-in-the-loop send", "Track edits made to drafts"],
    measurement: ["First response time", "Handle time per ticket", "Share of drafts sent with minor edits", "CSAT on AI-assisted tickets"],
  },
  {
    key: "invoice_processing", name: "Invoice processing", category: "finance_ops",
    businessObjective: "Reduce manual keying and exceptions in accounts payable.",
    systems: ["ERP (SAP, Oracle, NetSuite)", "Email / AP inbox", "Integration hub"], data: "Invoices with vendor bank details (confidential).",
    aiCapability: "Field extraction and validation against purchase orders; routing of exceptions.", riskLevel: "medium",
    risks: "Payment fraud via altered bank details; posting errors. Keep approval thresholds and bank-detail change controls outside the AI step.",
    implementation: ["Baseline volume, cycle time and exception rate in Workflow Intelligence", "Extract → validate against PO → route exceptions", "Human approval above thresholds", "Measure for one quarter"],
    measurement: ["Cost per invoice", "Cycle time", "Exception rate", "Touchless rate"],
  },
  {
    key: "knowledge_search", name: "Knowledge search", category: "knowledge",
    businessObjective: "Employees find the current, approved answer instead of asking colleagues or using outdated documents.",
    systems: ["Knowledge & Verification module", "Document sources via connectors"], data: "Policies and procedures with their access permissions.",
    aiCapability: "Permission-aware retrieval, cited answers, claim verification and expert escalation.", riskLevel: "low",
    risks: "Outdated or conflicting sources. Assign owners, set review dates and work the conflict queue.",
    implementation: ["Start with one high-traffic domain (e.g. HR or IT policies)", "Set source authority and owners", "Enable escalation to experts", "Review knowledge gaps monthly"],
    measurement: ["Questions answered without escalation", "Low-confidence share", "Time to answer", "Stale documents"],
  },
  {
    key: "contract_review", name: "Contract review", category: "legal",
    businessObjective: "Faster first-pass review of standard agreements against the playbook.",
    systems: ["Contract repository / CLM", "Platform AI layer (approved high-capability model)"], data: "Contracts (confidential), the legal playbook.",
    aiCapability: "Clause extraction and comparison to playbook positions with risk flags; lawyer decides.", riskLevel: "high",
    risks: "Missed non-standard terms; privilege and confidentiality. Restrict to approved models via a routing policy; lawyer sign-off on every contract.",
    implementation: ["Encode the playbook positions", "Route via a model policy for legal review", "Lawyer reviews flags and the full contract", "Track agreement with lawyer judgement"],
    measurement: ["Hours per contract review", "Turnaround time", "Flags confirmed by lawyers", "Issues found after signature"],
  },
  {
    key: "sales_research", name: "Sales account research", category: "sales",
    businessObjective: "Better-prepared sales conversations with less manual research.",
    systems: ["CRM (Salesforce, HubSpot)", "Approved web research tools"], data: "CRM records (customer personal data), public company information.",
    aiCapability: "Account briefs combining CRM history and public information.", riskLevel: "low",
    risks: "Inaccurate public information; uploading CRM data to unapproved tools. Use only approved tools.",
    implementation: ["Define the brief template with sales leaders", "Connect CRM read access", "Pilot with one team", "Collect feedback after each meeting"],
    measurement: ["Prep time per meeting", "Meetings per rep per week", "Rep rating of brief quality"],
  },
  {
    key: "support_triage", name: "Support ticket triage", category: "customer_service",
    businessObjective: "Route tickets to the right queue with the right priority the first time.",
    systems: ["Ticketing system", "Integration hub"], data: "Ticket text (may include personal data).",
    aiCapability: "Classification of category, priority and language; low-cost model is usually enough.", riskLevel: "low",
    risks: "Misrouted urgent tickets. Keep a confidence threshold and a human queue for uncertain cases.",
    implementation: ["Label a sample of historical tickets", "Use an economy model via a routing policy for classification", "Shadow mode for two weeks, then switch on", "Weekly review of misroutes"],
    measurement: ["Reassignment rate", "Time to first assignment", "Cost per classified ticket"],
  },
];

export interface UseCaseSeed {
  department: string;
  title: string;
  businessProblem: string;
  approvedWorkflow: string;
  instructions: string;
  expectedBenefit: string;
  risks: string;
  successMetric: string;
  templateKey?: string;
}

export const USE_CASE_SEEDS: UseCaseSeed[] = [
  { department: "Sales", title: "Account brief before customer meetings", businessProblem: "Reps spend 30–60 minutes preparing for each meeting.", approvedWorkflow: "Generate a brief from CRM and public sources; rep verifies facts before the meeting.", instructions: "Use the approved research tool; never paste CRM exports into other tools.", expectedBenefit: "Prep time cut by half.", risks: "Stale or wrong public information.", successMetric: "Prep minutes per meeting", templateKey: "sales_research" },
  { department: "Finance", title: "Invoice exception triage", businessProblem: "AP staff key and chase invoices by hand.", approvedWorkflow: "AI extracts and matches to POs; exceptions go to AP with the reason.", instructions: "Never let AI change vendor bank details; follow the change-control process.", expectedBenefit: "Lower cost per invoice and faster cycle time.", risks: "Payment fraud, posting errors.", successMetric: "Touchless invoice rate", templateKey: "invoice_processing" },
  { department: "HR", title: "Policy questions answered with citations", businessProblem: "HR answers the same policy questions every day.", approvedWorkflow: "Employees ask the knowledge layer; low-confidence and sensitive questions go to HR experts.", instructions: "Do not use it for individual employee cases; escalate those.", expectedBenefit: "Fewer repetitive tickets for HR.", risks: "Outdated policies.", successMetric: "Questions resolved without escalation", templateKey: "knowledge_search" },
  { department: "Procurement", title: "Supplier contract summary", businessProblem: "Buyers need key terms from long supplier agreements.", approvedWorkflow: "Summarize obligations, renewal and termination terms with citations; legal reviews anything non-standard.", instructions: "Use only the approved model for confidential documents.", expectedBenefit: "Faster supplier reviews.", risks: "Missed clauses.", successMetric: "Review hours per contract", templateKey: "document_summarization" },
  { department: "Legal", title: "First-pass NDA review", businessProblem: "Standard NDAs take lawyer time that could go to complex matters.", approvedWorkflow: "AI compares the NDA to the playbook and flags deviations; a lawyer decides.", instructions: "Lawyer sign-off is mandatory; routing policy restricts models.", expectedBenefit: "Same-day NDA turnaround.", risks: "Missed non-standard terms.", successMetric: "NDA turnaround time", templateKey: "contract_review" },
  { department: "Operations", title: "Shift handover summaries", businessProblem: "Handovers miss open issues.", approvedWorkflow: "Summarize the shift log into open issues and actions; the outgoing lead confirms.", instructions: "Keep the full log as the record.", expectedBenefit: "Fewer dropped issues.", risks: "Omitted details.", successMetric: "Issues reopened after handover", templateKey: "document_summarization" },
  { department: "Customer Support", title: "Ticket triage and draft replies", businessProblem: "Tickets bounce between queues and first responses are slow.", approvedWorkflow: "AI classifies and routes tickets, then drafts a reply from approved articles; an agent edits and sends.", instructions: "Never send without reading; escalate uncertain classifications.", expectedBenefit: "Faster first response, fewer reassignments.", risks: "Wrong commitments to customers.", successMetric: "First response time", templateKey: "support_triage" },
  { department: "IT", title: "Service desk knowledge answers", businessProblem: "Common how-to questions flood the service desk.", approvedWorkflow: "Employees ask the knowledge layer; unresolved questions become tickets.", instructions: "Keep IT articles owned and reviewed.", expectedBenefit: "Ticket deflection.", risks: "Outdated instructions.", successMetric: "Deflected tickets per month", templateKey: "knowledge_search" },
  { department: "Marketing", title: "Campaign copy variants", businessProblem: "Producing variants for channels and segments is slow.", approvedWorkflow: "Generate variants from an approved brief; brand review before publishing.", instructions: "No customer personal data in prompts; follow brand guidelines.", expectedBenefit: "More tested variants per campaign.", risks: "Off-brand or inaccurate claims.", successMetric: "Variants tested per campaign" },
];
