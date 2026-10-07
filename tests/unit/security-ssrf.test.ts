import { describe, expect, it } from "vitest";
import { assertSafeOutboundUrl, isPrivateAddress } from "../../packages/security/src/url-guard";
import { makeSafeLookup } from "../../packages/connectors/src/http";

/** Drive the connect-time lookup with an injected resolver and collect its callback. */
function connectLookup(allowPrivate: boolean, addresses: string[]): Promise<{ err: Error | null; result?: unknown }> {
  const fakeResolve = ((_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
    cb(null, addresses.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })))) as never;
  return new Promise((resolve) => {
    makeSafeLookup(allowPrivate, fakeResolve)("host.example", { all: true } as never, ((err: Error | null, result: unknown) => resolve({ err, result })) as never);
  });
}

/**
 * SECURITY: SSRF guard bypasses (packages/security/src/url-guard.ts).
 *
 * The tests in "bypasses" assert the SECURE behaviour and therefore FAIL
 * against today's code — each documents a way tenant-supplied connector /
 * webhook / OIDC URLs can still reach loopback or the cloud metadata service.
 * The "already blocked" and "still works" blocks assert controls that hold
 * today and must keep holding after the fix.
 */
describe("SSRF guard — isPrivateAddress: currently-blocked vectors (must stay blocked)", () => {
  for (const addr of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    it(`blocks ${addr}`, () => expect(isPrivateAddress(addr)).toBe(true));
  }
  it("allows a genuine public address", () => expect(isPrivateAddress("8.8.8.8")).toBe(false));
});

describe("SSRF guard — bypasses that must be closed", () => {
  // IPv4-mapped IPv6 in hex-group form: isIP() accepts it, slice(7) is not dotted-decimal,
  // so it falls through every v6 check and is treated as public.
  it("blocks ::ffff:7f00:1 (= 127.0.0.1 in hex-mapped form)", () => expect(isPrivateAddress("::ffff:7f00:1")).toBe(true));
  it("blocks ::ffff:a9fe:a9fe (= 169.254.169.254, cloud metadata)", () => expect(isPrivateAddress("::ffff:a9fe:a9fe")).toBe(true));

  // fe80::/10 is link-local, but only the fe80:: block is matched; fe90–febf are missed.
  it("blocks the whole fe80::/10 link-local range (fe90::1)", () => expect(isPrivateAddress("fe90::1")).toBe(true));
  it("blocks the whole fe80::/10 link-local range (febf::1)", () => expect(isPrivateAddress("febf::1")).toBe(true));

  // End-to-end through the guard: a literal hex-mapped loopback host must be rejected.
  it("rejects https://[::ffff:7f00:1]/ end to end", async () => {
    await expect(assertSafeOutboundUrl("https://[::ffff:7f00:1]/")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  // DNS rebinding / TOCTOU: the address actually connected to must be validated, so a host
  // that resolves to a private address at connect time is rejected inside the dispatcher —
  // not only at the earlier pre-check (which the socket's own resolution could bypass).
  it("connect-time lookup rejects a host that resolves to a private/metadata address", async () => {
    expect((await connectLookup(false, ["169.254.169.254"])).err).toBeTruthy();
    expect((await connectLookup(false, ["10.0.0.5"])).err).toBeTruthy();
    expect((await connectLookup(false, ["::ffff:7f00:1"])).err).toBeTruthy();
  });
  it("connect-time lookup allows a genuine public address", async () => {
    const r = await connectLookup(false, ["93.184.216.34"]);
    expect(r.err).toBeNull();
    expect(r.result).toHaveLength(1);
  });
});

describe("SSRF guard — controls that must keep working", () => {
  it("allows a public HTTPS URL", async () => {
    const u = await assertSafeOutboundUrl("https://api.example.com/v1", { resolve: async () => ["93.184.216.34"] });
    expect(u.protocol).toBe("https:");
  });
  it("rejects plain HTTP by default", async () => {
    await expect(assertSafeOutboundUrl("http://api.example.com/")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("rejects embedded credentials", async () => {
    await expect(assertSafeOutboundUrl("https://user:pass@api.example.com/", { resolve: async () => ["93.184.216.34"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("rejects a hostname that resolves to a private address", async () => {
    await expect(assertSafeOutboundUrl("https://sneaky.example/", { resolve: async () => ["10.0.0.5"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
