import { assertSafeOutboundUrl, type UrlGuardOptions } from "@eaop/security";
import { ConnectorError, type GuardedFetch } from "./types";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * Outbound HTTP for adapters: SSRF guard on every request, no automatic
 * redirects (each hop would need re-validation), bounded response size,
 * and timeouts via the caller's AbortSignal.
 */
export function createGuardedFetch(guard: UrlGuardOptions, signal: AbortSignal, fetchImpl: typeof fetch = fetch): GuardedFetch {
  return async (url, init = {}) => {
    await assertSafeOutboundUrl(url, guard).catch((e: Error) => {
      throw new ConnectorError("configuration", e.message);
    });
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, redirect: "manual", signal });
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw new ConnectorError("transient", "Upstream request timed out.");
      throw new ConnectorError("transient", `Network error: ${(err as Error).message}`);
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ConnectorError("permanent", "Upstream response exceeded the 5 MB limit.");
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return {
      status: res.status,
      headers: res.headers,
      text,
      json<T>() {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new ConnectorError("permanent", "Upstream returned invalid JSON.");
        }
      },
    };
  };
}
