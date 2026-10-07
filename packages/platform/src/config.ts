import { z } from "zod";

const bool = z.enum(["true", "false"]).default("false").transform((v) => v === "true");

export const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** ≥32 random bytes; signs SSO/OAuth state. */
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  DATABASE_URL: z.string().min(1),
  SECRETS_PROVIDER: z.enum(["local", "aws", "azure", "vault", "gcp"]).default("local"),
  LOCAL_SECRETS_KEY: z.string().optional(),
  ALLOW_LOCAL_SECRETS_IN_PRODUCTION: z.string().optional(),
  ALLOW_SELF_SERVE_SIGNUP: bool,
  /** Allow connectors/webhooks to reach private networks (dev / on-prem only). Disables the SSRF guard. */
  ALLOW_PRIVATE_NETWORK_EGRESS: bool,
  /** Explicit acknowledgement required to honour ALLOW_PRIVATE_NETWORK_EGRESS in production. */
  ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION: bool,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  EMAIL_WEBHOOK_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  PLATFORM_NAME: z.string().default("Enterprise AI Operating Platform"),
});
export type PlatformEnv = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): PlatformEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid platform configuration — ${msg}`);
  }
  const env = parsed.data;
  if (env.APP_ENV === "production") {
    if (!env.APP_URL.startsWith("https://")) throw new Error("APP_URL must be https in production");
    // Fail closed: the blanket egress flag turns off SSRF protection platform-wide, so in
    // production it must be acknowledged explicitly rather than silently honoured.
    if (env.ALLOW_PRIVATE_NETWORK_EGRESS && !env.ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION) {
      throw new Error(
        "ALLOW_PRIVATE_NETWORK_EGRESS disables the SSRF guard (private/loopback/metadata egress). In production it also requires ALLOW_PRIVATE_NETWORK_EGRESS_IN_PRODUCTION=true to acknowledge the risk; prefer a per-host allowlist instead.",
      );
    }
    if (env.ALLOW_PRIVATE_NETWORK_EGRESS) console.warn("[eaop] ALLOW_PRIVATE_NETWORK_EGRESS is enabled in production — the SSRF guard is disabled");
  }
  return env;
}
