import type { NextConfig } from "next";
import { securityHeaders } from "@eaop/security";

const isProduction = process.env.APP_ENV === "production";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@eaop/ai", "@eaop/api", "@eaop/audit", "@eaop/auth", "@eaop/connectors", "@eaop/db", "@eaop/design-system", "@eaop/events", "@eaop/jobs",
    "@eaop/module-registry", "@eaop/notifications", "@eaop/observability", "@eaop/organizations", "@eaop/platform", "@eaop/policies", "@eaop/rbac",
    "@eaop/search", "@eaop/secrets", "@eaop/security", "@eaop/shared-types", "@eaop/usage",
    "@eaop/module-workflow-intelligence", "@eaop/module-integration-hub", "@eaop/module-agent-governance", "@eaop/module-data-security",
    "@eaop/module-knowledge-verification", "@eaop/module-ai-operations",
  ],
  serverExternalPackages: ["pg", "@anthropic-ai/sdk"],
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  async headers() {
    return [{ source: "/:path*", headers: Object.entries(securityHeaders({ isProduction })).map(([key, value]) => ({ key, value })) }];
  },
};

export default config;
