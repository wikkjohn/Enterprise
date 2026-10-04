import { ConnectorError, classifyStatus, type AdapterContext, type ConnectorAdapter } from "../types";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function authHeaders(ctx: AdapterContext, cfg: { apiKeyHeader?: string; apiKeyPrefix?: string }): Record<string, string> {
  const c = ctx.credentials ?? {};
  switch (ctx.authType) {
    case "api_key":
      if (!c.apiKey) throw new ConnectorError("configuration", "API key credential is missing.");
      return { [cfg.apiKeyHeader ?? "Authorization"]: `${cfg.apiKeyPrefix ?? "Bearer "}${c.apiKey}` };
    case "basic":
      if (!c.username || !c.password) throw new ConnectorError("configuration", "Basic credentials are missing.");
      return { Authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` };
    case "oauth2":
      if (!c.accessToken) throw new ConnectorError("auth", "No OAuth access token; refresh required.");
      return { Authorization: `Bearer ${c.accessToken}` };
    default:
      return {};
  }
}

/** Resolve `path` against `baseUrl` while forbidding host changes or path traversal outside the base. */
export function resolveUnder(baseUrl: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new ConnectorError("configuration", "path must be an absolute path under the base URL.");
  const base = new URL(baseUrl);
  const joined = new URL(base.pathname.replace(/\/$/, "") + path, base.origin);
  if (joined.origin !== base.origin) throw new ConnectorError("configuration", "path escapes the base URL.");
  return joined.toString();
}

export const restApiAdapter: ConnectorAdapter = {
  type: "rest_api",

  async testConnection(ctx) {
    const cfg = ctx.config as { baseUrl: string; healthPath?: string; apiKeyHeader?: string; apiKeyPrefix?: string };
    const started = performance.now();
    const res = await ctx.fetch(resolveUnder(cfg.baseUrl, cfg.healthPath ?? "/"), { headers: { accept: "application/json", ...authHeaders(ctx, cfg) } });
    const err = classifyStatus(res.status);
    const latencyMs = Math.round(performance.now() - started);
    if (err) return { ok: false, message: err.message, latencyMs, details: { status: res.status } };
    return { ok: true, message: `Reachable (HTTP ${res.status}).`, latencyMs };
  },

  async execute(ctx, req) {
    if (req.capability !== "http.request") throw new ConnectorError("permanent", `Unsupported capability ${req.capability}`);
    const cfg = ctx.config as { baseUrl: string; apiKeyHeader?: string; apiKeyPrefix?: string };
    const method = String(req.params.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new ConnectorError("configuration", "Unsupported HTTP method.");
    const expected = method === "GET" ? "read" : method === "DELETE" ? "delete" : "write";
    if (req.operation !== expected) throw new ConnectorError("configuration", `Operation "${req.operation}" does not match method ${method}.`);
    const target = new URL(resolveUnder(cfg.baseUrl, String(req.params.path ?? "/")));
    const query = (req.params.query ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) target.searchParams.set(k, String(v));
    const res = await ctx.fetch(target.toString(), {
      method,
      headers: { accept: "application/json", ...(req.params.body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders(ctx, cfg) },
      body: req.params.body !== undefined ? JSON.stringify(req.params.body) : undefined,
    });
    const err = classifyStatus(res.status, res.headers.get("retry-after"));
    if (err) throw err;
    const ct = res.headers.get("content-type") ?? "";
    return { status: res.status, body: ct.includes("json") && res.text ? res.json() : res.text };
  },

  async refreshCredentials(ctx) {
    const cfg = ctx.config as { tokenUrl?: string; oauthScope?: string };
    const c = ctx.credentials ?? {};
    if (ctx.authType !== "oauth2" || !cfg.tokenUrl || !c.clientId || !c.clientSecret) throw new ConnectorError("configuration", "OAuth2 client-credentials are not configured.");
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret });
    if (cfg.oauthScope) body.set("scope", cfg.oauthScope);
    const res = await ctx.fetch(cfg.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    const err = classifyStatus(res.status);
    if (err) throw err.errorClass === "auth" ? new ConnectorError("auth", "Token endpoint rejected the client credentials.") : err;
    const tok = res.json<{ access_token?: string; expires_in?: number }>();
    if (!tok.access_token) throw new ConnectorError("auth", "Token endpoint returned no access_token.");
    return { values: { ...c, accessToken: tok.access_token }, expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : undefined };
  },
};
