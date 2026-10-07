import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { assertSafeOutboundUrl, isPrivateAddress, type UrlGuardOptions } from "@eaop/security";
import { ConnectorError, type GuardedFetch } from "./types";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type NodeLookup = typeof dnsLookup;

/**
 * Connect-time DNS validation. `assertSafeOutboundUrl` validates the address it
 * resolves, but the HTTP client resolves again independently, so a hostname
 * that flips from a public to a private address between the two lookups (DNS
 * rebinding) could still reach an internal service. This lookup runs inside the
 * dispatcher that actually opens the socket and rejects any resolved private /
 * loopback / metadata address, so the address connected to is always the one
 * that was vetted. The hostname is preserved for TLS SNI and the Host header.
 */
export function makeSafeLookup(allowPrivate: boolean, resolveImpl: NodeLookup = dnsLookup): LookupFunction {
  return ((hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean; family?: number };
    resolveImpl(hostname, { ...opts, all: true }, (err, addresses) => {
      const list = (Array.isArray(addresses) ? addresses : []) as LookupAddress[];
      if (err) return callback(err, "", undefined);
      if (!list.length) return callback(Object.assign(new Error(`SSRF guard: ${hostname} did not resolve.`), { code: "ENOTFOUND" }), "", undefined);
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(Object.assign(new Error(`SSRF guard: ${hostname} resolves to a private or reserved address (${bad.address}).`), { code: "EAI_FAIL" }), "", undefined);
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as LookupFunction;
}

/**
 * Outbound HTTP for adapters: SSRF guard on every request (pre-check plus
 * connect-time validation that defeats DNS rebinding), no automatic redirects
 * (each hop would need re-validation), bounded response size, and timeouts via
 * the caller's AbortSignal.
 *
 * When no `fetchImpl` is supplied the undici engine is used with a validating
 * dispatcher; a supplied `fetchImpl` (tests) is used as-is.
 */
export function createGuardedFetch(guard: UrlGuardOptions, signal: AbortSignal, fetchImpl?: typeof fetch): GuardedFetch {
  const dispatcher = fetchImpl ? undefined : new Agent({ connect: { lookup: makeSafeLookup(!!guard.allowPrivateNetworks) } });
  return async (url, init = {}) => {
    await assertSafeOutboundUrl(url, guard).catch((e: Error) => {
      throw new ConnectorError("configuration", e.message);
    });
    let res: Response;
    try {
      if (dispatcher) {
        res = (await undiciFetch(url, { ...(init as Record<string, unknown>), redirect: "manual", signal, dispatcher } as never)) as unknown as Response;
      } else {
        res = await fetchImpl!(url, { ...init, redirect: "manual", signal });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw new ConnectorError("transient", "Upstream request timed out.");
      // A connect-time SSRF rejection surfaces as a network error; keep it permanent, not retryable.
      if (/SSRF guard:/.test((err as Error).message) || (err as { cause?: Error }).cause?.message?.includes?.("SSRF guard:")) {
        throw new ConnectorError("configuration", "Request blocked: host resolves to a private or reserved network address.");
      }
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
