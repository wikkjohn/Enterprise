import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@eaop/shared-types";

/**
 * SSRF guard for tenant-supplied URLs (connectors, webhooks, OIDC issuers).
 * Rejects non-HTTPS (outside development), credentials in URLs, and hosts
 * resolving to private, loopback, link-local or metadata addresses.
 */
export interface UrlGuardOptions {
  allowHttp?: boolean;
  allowPrivateNetworks?: boolean;
  resolve?: (host: string) => Promise<string[]>;
}

export async function assertSafeOutboundUrl(raw: string, opts: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid URL.");
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    throw new AppError("VALIDATION_FAILED", "Only HTTPS URLs are allowed.");
  }
  if (url.username || url.password) throw new AppError("VALIDATION_FAILED", "URLs must not embed credentials.");
  if (opts.allowPrivateNetworks) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : await (opts.resolve ?? (async (h) => (await lookup(h, { all: true })).map((a) => a.address)))(host).catch(() => {
        throw new AppError("VALIDATION_FAILED", "URL host could not be resolved.");
      });
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) throw new AppError("VALIDATION_FAILED", "URL resolves to a private or reserved network address.");
  }
  return url;
}

export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = addr.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}
