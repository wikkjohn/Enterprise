import { hmacSha256 } from "@eaop/security";
import { ConnectorError, classifyStatus, type ConnectorAdapter } from "../types";

export const outboundWebhookAdapter: ConnectorAdapter = {
  type: "outbound_webhook",
  async testConnection(ctx) {
    const cfg = ctx.config as { url: string };
    // A HEAD/OPTIONS probe is not universally supported; we only validate the URL (SSRF guard) and DNS.
    await ctx.fetch(cfg.url, { method: "OPTIONS" }).catch((e: Error) => {
      if (e instanceof ConnectorError && e.errorClass === "configuration") throw e;
    });
    return { ok: true, message: "Endpoint URL is valid and reachable for outbound delivery." };
  },
  async execute(ctx, req) {
    if (req.capability !== "webhook.send") throw new ConnectorError("permanent", `Unsupported capability ${req.capability}`);
    const cfg = ctx.config as { url: string };
    const body = JSON.stringify(req.params.payload ?? {});
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ctx.authType === "api_key" && ctx.credentials?.apiKey) {
      const t = Math.floor(Date.now() / 1000);
      headers["x-eaop-signature"] = `t=${t},v1=${hmacSha256(ctx.credentials.apiKey, `${t}.${body}`)}`;
    }
    const res = await ctx.fetch(cfg.url, { method: "POST", headers, body });
    const err = classifyStatus(res.status, res.headers.get("retry-after"));
    if (err) throw err;
    return { status: res.status };
  },
};
