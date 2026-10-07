import { describe, expect, it } from "vitest";
import { assertSafeOutboundUrl, isPrivateAddress } from "../../packages/security/src/url-guard";

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

  // DNS rebinding / TOCTOU: the guard validates the resolved IP but returns a URL with the
  // hostname intact, and the caller's fetch re-resolves it independently. A guard that pins
  // the checked address would expose it on the returned URL (host = the vetted IP literal).
  it("pins the resolved address so the fetch cannot be rebound to a private IP", async () => {
    const seen: string[] = [];
    const url = await assertSafeOutboundUrl("https://rebind.example/path", {
      resolve: async (h) => {
        seen.push(h);
        return ["203.0.113.10"]; // first resolution: public
      },
    });
    // Secure behaviour: the returned URL targets the vetted IP, not the re-resolvable hostname.
    expect(url.hostname).toBe("203.0.113.10");
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
