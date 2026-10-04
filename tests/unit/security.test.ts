import { describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl, base32Decode, base32Encode, checkPasswordPolicy, constantTimeEqual, generateTotpSecret, hashPassword, ipAllowed, isPrivateAddress,
  MemoryRateLimiter, securityHeaders, totpCode, verifyCsrf, verifyPassword, verifyTotp,
} from "../../packages/security/src";
import { redact } from "../../packages/observability/src";

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("a long passphrase here");
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword("a long passphrase here", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
  it("policy: length, common passwords, email name", () => {
    expect(checkPasswordPolicy("short", { minLength: 12 })).toHaveLength(1);
    expect(checkPasswordPolicy("password123", { minLength: 8 })).toContain("Password is too common.");
    expect(checkPasswordPolicy("janedoe-is-great", { minLength: 12 }, { email: "janedoe@x.com" }).length).toBe(1);
    expect(checkPasswordPolicy("correct horse battery", { minLength: 12 })).toEqual([]);
  });
});

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59_000, 30, 8)).toBe("94287082");
    expect(totpCode(secret, 1111111109_000, 30, 8)).toBe("07081804");
  });
  it("verifies within ±1 step and rejects garbage", () => {
    const s = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(s, totpCode(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totpCode(s, now - 120_000), now)).toBe(false);
    expect(verifyTotp(s, "abc123", now)).toBe(false);
    expect(base32Decode(base32Encode(Buffer.from("hi")))).toEqual(Buffer.from("hi"));
  });
});

describe("rate limiter", () => {
  it("token bucket allows bursts up to the limit then refills", async () => {
    let t = 0;
    const rl = new MemoryRateLimiter(() => t);
    const rule = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) expect((await rl.consume("k", rule)).allowed).toBe(true);
    const denied = await rl.consume("k", rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(20);
    t += 20_000;
    expect((await rl.consume("k", rule)).allowed).toBe(true);
    expect((await rl.consume("other", rule)).allowed).toBe(true);
  });
});

describe("CSRF", () => {
  const base = { allowedOrigins: ["https://app.example"], csrfCookie: "tok", csrfHeader: "tok", referer: null };
  it("allows safe methods and matching origin+token", () => {
    expect(verifyCsrf({ ...base, method: "GET", origin: null, csrfHeader: null }).ok).toBe(true);
    expect(verifyCsrf({ ...base, method: "POST", origin: "https://app.example" }).ok).toBe(true);
  });
  it("rejects cross-origin and missing/mismatched tokens", () => {
    expect(verifyCsrf({ ...base, method: "POST", origin: "https://evil.example" })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(verifyCsrf({ ...base, method: "POST", origin: null })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(verifyCsrf({ ...base, method: "DELETE", origin: "https://app.example", csrfHeader: "nope" })).toEqual({ ok: false, reason: "token_mismatch" });
  });
});

describe("SSRF guard", () => {
  const pub = { resolve: async () => ["93.184.216.34"] };
  it("rejects private/reserved addresses, credentials and non-https", async () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    await expect(assertSafeOutboundUrl("http://example.com", pub)).rejects.toThrow(/HTTPS/);
    await expect(assertSafeOutboundUrl("https://u:p@example.com", pub)).rejects.toThrow(/credentials/);
    await expect(assertSafeOutboundUrl("https://internal", { resolve: async () => ["10.1.1.1"] })).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl("https://[::1]/x", pub)).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl("https://example.com/x", pub)).resolves.toBeInstanceOf(URL);
  });
});

describe("misc", () => {
  it("IP allowlists with CIDR", () => {
    expect(ipAllowed("10.2.3.4", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.2.3.4", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("::ffff:192.168.1.9", ["192.168.1.0/24"])).toBe(true);
    expect(ipAllowed(undefined, ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
  });
  it("constant-time compare", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("security headers include CSP, frame denial, HSTS in production", () => {
    const h = securityHeaders({ isProduction: true });
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Strict-Transport-Security"]).toBeTruthy();
    expect(securityHeaders({ isProduction: false })["Strict-Transport-Security"]).toBeUndefined();
  });
  it("log redaction masks sensitive keys and credential-looking values", () => {
    const out = redact({ password: "p", nested: { apiKey: "k", note: "token sk-abcdefghijklmnopqrstu and Bearer abc.def.ghi.jkl" }, ok: 1 }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect(String((out.nested as Record<string, unknown>).note)).not.toMatch(/sk-abc|abc\.def/);
    expect(out.ok).toBe(1);
  });
});
