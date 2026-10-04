import { ConnectorError, classifyStatus, type ConnectorAdapter } from "../types";
import { authHeaders } from "./rest";

export const graphqlAdapter: ConnectorAdapter = {
  type: "graphql",
  async testConnection(ctx) {
    const cfg = ctx.config as { endpoint: string; apiKeyHeader?: string; apiKeyPrefix?: string };
    const started = performance.now();
    const res = await ctx.fetch(cfg.endpoint, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(ctx, cfg) }, body: JSON.stringify({ query: "{ __typename }" }) });
    const err = classifyStatus(res.status);
    return err ? { ok: false, message: err.message, latencyMs: Math.round(performance.now() - started) } : { ok: true, message: "GraphQL endpoint responded.", latencyMs: Math.round(performance.now() - started) };
  },
  async execute(ctx, req) {
    const cfg = ctx.config as { endpoint: string; apiKeyHeader?: string; apiKeyPrefix?: string };
    const query = String(req.params.query ?? "");
    if (!query) throw new ConnectorError("configuration", "query is required.");
    const isMutation = /^\s*mutation\b/.test(query);
    if (req.capability === "graphql.query" && isMutation) throw new ConnectorError("configuration", "Mutations require the graphql.mutation capability.");
    if (req.capability === "graphql.mutation" && !isMutation) throw new ConnectorError("configuration", "graphql.mutation requires a mutation document.");
    const res = await ctx.fetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(ctx, cfg) },
      body: JSON.stringify({ query, variables: req.params.variables ?? {} }),
    });
    const err = classifyStatus(res.status, res.headers.get("retry-after"));
    if (err) throw err;
    const out = res.json<{ data?: unknown; errors?: Array<{ message: string }> }>();
    if (out.errors?.length && !out.data) throw new ConnectorError("permanent", `GraphQL error: ${out.errors[0]!.message.slice(0, 300)}`);
    return out;
  },
};
