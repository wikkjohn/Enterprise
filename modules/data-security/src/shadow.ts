/**
 * Shadow AI recognition — pure. A curated catalog of public AI services by
 * domain. Telemetry (proxy / CASB / SSO / browser logs) submitted through the
 * ingestion API is matched against it; domains not in the catalog are only
 * recorded when the telemetry source itself labels them as AI. Without
 * telemetry the module has no visibility into employee AI use — the UI says so.
 */
export const TOOL_CATEGORIES = ["chat_assistant", "coding_assistant", "enterprise_copilot", "model_api", "agent_platform", "image_generation", "meeting_assistant", "writing_assistant", "other"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
export const TOOL_STATUSES = ["approved", "experimental", "unknown", "restricted", "blocked"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export interface CatalogTool {
  key: string;
  vendor: string;
  name: string;
  category: ToolCategory;
  domains: string[];
}

export const AI_TOOL_CATALOG: CatalogTool[] = [
  { key: "openai_chatgpt", vendor: "OpenAI", name: "ChatGPT", category: "chat_assistant", domains: ["chatgpt.com", "chat.openai.com"] },
  { key: "openai_api", vendor: "OpenAI", name: "OpenAI API", category: "model_api", domains: ["api.openai.com"] },
  { key: "anthropic_claude", vendor: "Anthropic", name: "Claude", category: "chat_assistant", domains: ["claude.ai"] },
  { key: "anthropic_api", vendor: "Anthropic", name: "Claude API", category: "model_api", domains: ["api.anthropic.com"] },
  { key: "google_gemini", vendor: "Google", name: "Gemini", category: "chat_assistant", domains: ["gemini.google.com", "bard.google.com"] },
  { key: "google_ai_api", vendor: "Google", name: "Gemini API", category: "model_api", domains: ["generativelanguage.googleapis.com", "aistudio.google.com"] },
  { key: "microsoft_copilot", vendor: "Microsoft", name: "Microsoft Copilot", category: "enterprise_copilot", domains: ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365copilot.com"] },
  { key: "github_copilot", vendor: "GitHub", name: "GitHub Copilot", category: "coding_assistant", domains: ["copilot-proxy.githubusercontent.com", "api.githubcopilot.com"] },
  { key: "perplexity", vendor: "Perplexity", name: "Perplexity", category: "chat_assistant", domains: ["perplexity.ai", "www.perplexity.ai"] },
  { key: "mistral", vendor: "Mistral AI", name: "Le Chat / Mistral API", category: "chat_assistant", domains: ["chat.mistral.ai", "api.mistral.ai"] },
  { key: "deepseek", vendor: "DeepSeek", name: "DeepSeek", category: "chat_assistant", domains: ["chat.deepseek.com", "api.deepseek.com"] },
  { key: "huggingface", vendor: "Hugging Face", name: "Hugging Face", category: "model_api", domains: ["huggingface.co", "api-inference.huggingface.co"] },
  { key: "cursor", vendor: "Anysphere", name: "Cursor", category: "coding_assistant", domains: ["cursor.sh", "api2.cursor.sh", "cursor.com"] },
  { key: "otter", vendor: "Otter.ai", name: "Otter", category: "meeting_assistant", domains: ["otter.ai"] },
  { key: "grammarly", vendor: "Grammarly", name: "Grammarly", category: "writing_assistant", domains: ["grammarly.com", "www.grammarly.com"] },
  { key: "midjourney", vendor: "Midjourney", name: "Midjourney", category: "image_generation", domains: ["midjourney.com", "www.midjourney.com"] },
  { key: "character_ai", vendor: "Character.AI", name: "Character.AI", category: "chat_assistant", domains: ["character.ai"] },
  { key: "poe", vendor: "Quora", name: "Poe", category: "chat_assistant", domains: ["poe.com"] },
];

export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = raw.includes("://") ? new URL(raw).hostname : raw.split("/")[0]!.split(":")[0]!;
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Exact domain or subdomain match. */
export function matchCatalog(domain: string): CatalogTool | null {
  for (const t of AI_TOOL_CATALOG) if (t.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return t;
  return null;
}

const STATUS_WEIGHT: Record<ToolStatus, number> = { approved: 0, experimental: 15, unknown: 30, restricted: 20, blocked: 35 };
const CATEGORY_WEIGHT: Record<string, number> = { credentials: 30, financial: 20, health: 20, regulated: 20, trade_secrets: 20, pii: 15, customer_records: 15, employee: 15, source_code: 12, contracts: 8 };

/** Explainable 0–100 risk for a tool: trust status + data categories seen + population. */
export function toolRisk(t: { status: ToolStatus; dataCategories: string[]; userCount: number }): { score: number; level: "low" | "medium" | "high" | "critical"; factors: string[] } {
  const factors: string[] = [`status ${t.status} (+${STATUS_WEIGHT[t.status]})`];
  let score = STATUS_WEIGHT[t.status];
  const data = t.dataCategories.reduce((n, c) => n + (CATEGORY_WEIGHT[c] ?? 8), 0);
  const dataPts = Math.min(45, data);
  if (dataPts) factors.push(`data categories ${t.dataCategories.join(", ")} (+${dataPts})`);
  score += dataPts;
  const pop = t.userCount >= 100 ? 20 : t.userCount >= 25 ? 12 : t.userCount >= 5 ? 6 : t.userCount > 0 ? 2 : 0;
  if (pop) factors.push(`${t.userCount} user(s) (+${pop})`);
  score += pop;
  if (t.status === "approved") score = Math.min(score, 40);
  score = Math.min(100, score);
  return { score, level: score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low", factors };
}
