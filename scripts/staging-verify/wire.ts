/**
 * Wire capture: wraps globalThis.fetch so the harness sees the exact bytes
 * sent to, and received from, the AI provider. The Anthropic SDK client binds
 * the global fetch when it is constructed (lazily, on the first call for a
 * given key), so the capture must be installed before the first AI call.
 */
export interface WireExchange {
  seq: number;
  url: string;
  method: string;
  requestBody: string;
  status: number;
  requestId: string | null;
  responseBody: string;
  at: string;
}

export interface WireCapture {
  exchanges: WireExchange[];
  /** Exchanges recorded since `mark` (an index previously read from `exchanges.length`). */
  since(mark: number): WireExchange[];
  restore(): void;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function bodyOf(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<string> {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return Buffer.from(b as ArrayBuffer).toString("utf8");
  if (b instanceof URLSearchParams) return b.toString();
  if (b == null && input instanceof Request) return input.clone().text();
  // Streams/FormData are never used by the provider SDKs for messages; record that we could not read it.
  return b == null ? "" : `[unreadable body: ${Object.prototype.toString.call(b)}]`;
}

export function installWireCapture(matches: (url: URL) => boolean): WireCapture {
  const original = globalThis.fetch;
  const exchanges: WireExchange[] = [];
  const wrapped: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || !matches(parsed)) return original(input, init);
    const requestBody = await bodyOf(input, init);
    const at = new Date().toISOString();
    const res = await original(input, init);
    const responseBody = await res.clone().text().catch(() => "");
    exchanges.push({ seq: exchanges.length + 1, url, method: init?.method ?? (input instanceof Request ? input.method : "GET"), requestBody, status: res.status, requestId: res.headers.get("request-id"), responseBody, at });
    return res;
  };
  globalThis.fetch = wrapped;
  return {
    exchanges,
    since: (mark) => exchanges.slice(mark),
    restore: () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    },
  };
}
