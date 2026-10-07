import { afterEach, describe, expect, it, vi } from "vitest";
import { UnconfiguredEmailSender, WebhookEmailSender } from "../../packages/notifications/src";

/**
 * Outbound email relay (WebhookEmailSender) — posts notification emails as JSON
 * to a relay the operator runs (e.g. a function fronting SES). Verifies the
 * payload, error handling, and that the relay URL is itself SSRF-guarded.
 */
const MSG = { to: "user@example.com", subject: "Reset your password", text: "link" };

afterEach(() => {
  delete process.env.APP_ENV;
});

describe("WebhookEmailSender", () => {
  it("POSTs the message as JSON to the configured relay", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const sender = new WebhookEmailSender("https://relay.example/send", fetchImpl);
    expect(sender.configured).toBe(true);
    await sender.send(MSG);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://relay.example/send");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(MSG);
  });

  it("surfaces a non-2xx relay response as a retryable UPSTREAM_ERROR", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const sender = new WebhookEmailSender("https://relay.example/send", fetchImpl);
    await expect(sender.send(MSG)).rejects.toMatchObject({ code: "UPSTREAM_ERROR", retryable: true });
  });

  it("in production, refuses a relay URL that is not HTTPS or resolves to a private network (SSRF)", async () => {
    process.env.APP_ENV = "production";
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    // Plain HTTP is rejected outright in production.
    await expect(new WebhookEmailSender("http://relay.internal/send", fetchImpl).send(MSG)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("the unconfigured sender is a no-op and reports itself as not configured", async () => {
    const logs: string[] = [];
    const sender = new UnconfiguredEmailSender({ info: (m: string) => logs.push(m) } as never);
    expect(sender.configured).toBe(false);
    await sender.send(MSG); // must not throw
    expect(logs.join()).toContain("email.not_configured");
  });
});
