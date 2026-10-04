import { ConnectorError, type ConnectorAdapter } from "../types";

/**
 * SIMULATED adapter for development and automated tests. It never contacts
 * an external system, and everything it returns is synthetic and labelled
 * `simulated: true`. It is excluded from the catalog in production.
 */
const store = new Map<string, Array<Record<string, unknown>>>();

export const sandboxAdapter: ConnectorAdapter = {
  type: "sandbox",
  async testConnection(ctx) {
    if (ctx.authType === "api_key" && ctx.credentials?.apiKey === "invalid") return { ok: false, message: "Simulated authentication failure." };
    return { ok: true, message: "Sandbox connector (simulated) is healthy.", latencyMs: 1 };
  },
  async execute(ctx, req) {
    const key = `${ctx.organizationId}:${ctx.connectorId}`;
    const records = store.get(key) ?? [];
    switch (req.capability) {
      case "records.list":
        return { simulated: true, records: [{ id: "sim-1", name: "Simulated record A" }, { id: "sim-2", name: "Simulated record B" }, ...records] };
      case "records.write": {
        const rec = { id: `sim-${records.length + 3}`, ...(req.params.record as object) };
        store.set(key, [...records, rec]);
        return { simulated: true, record: rec };
      }
      case "simulate.failure": {
        const kind = String(req.params.kind ?? "transient");
        if (kind === "auth") throw new ConnectorError("auth", "Simulated auth failure.", undefined, 401);
        if (kind === "rate_limited") throw new ConnectorError("rate_limited", "Simulated rate limit.", 0, 429);
        if (kind === "permanent") throw new ConnectorError("permanent", "Simulated permanent failure.", undefined, 400);
        throw new ConnectorError("transient", "Simulated transient failure.", undefined, 503);
      }
      default:
        throw new ConnectorError("permanent", `Unsupported capability ${req.capability}`);
    }
  },
};
