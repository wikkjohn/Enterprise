# Internal penetration test — findings and remediation

Scope: login/sessions/MFA, CSRF, API keys, SSO/OIDC, SSRF on the REST connector,
file-upload parsing, privilege escalation through module APIs, and confirmation
that per-organization database isolation holds under the production (NOSUPERUSER
NOBYPASSRLS) role. White-box review plus black-box testing against a
production-mode build. This is a point-in-time assessment of the user's own
code, run before first production deploy; no third parties or external systems
were touched.

Each finding has an executable regression test under `tests/security/**` that
asserts the **secure** behaviour, so the tests for open findings fail today and
will pass once the finding is fixed. Run them with `pnpm test:security`. The
`Security` CI workflow (`.github/workflows/security.yml`) runs them in a
non-blocking job, and adds dependency-audit (blocking on high/critical shipped
deps) and secret-scanning (gitleaks) jobs.

Severity key: **Critical** — cross-tenant compromise reachable by a tenant;
**High** — account/tenant compromise or guard bypass with a realistic path;
**Medium** — control bypass needing a precondition or limited blast radius;
**Low/Info** — hardening.

---

## Summary

| # | Sev | Finding | Area | Test (expected red) |
|---|-----|---------|------|---------------------|
| 1 | Critical | SSO JIT provisioning takes over any existing account and pivots across tenants | SSO | `tests/security/security-sso.test.ts` |
| 2 | High | SSO `defaultRoleKey` lets `org.security.manage` mint `org_admin` | SSO / RBAC | `security-sso.test.ts` (defaultRoleKey) |
| 3 | High | SSRF guard bypass: IPv4-mapped IPv6 hex form reaches loopback / metadata | SSRF | `tests/security/security-ssrf.test.ts` |
| 4 | High | SSRF via DNS rebinding — no IP pinning between check and fetch; leaks connector credentials | SSRF | `security-ssrf.test.ts` (pins the resolved address) |
| 5 | High | PDF parser ReDoS hangs the event loop (worker-wide DoS), run inline | Upload | `tests/security/security-upload.test.ts` |
| 6 | Medium | Zip-bomb aggregate-memory guard trusts the attacker-declared uncompressed size | Upload | (documented; no executable PoC — see note) |
| 7 | Medium | Separation-of-duties bypass via invitation / SSO JIT | RBAC | `tests/security/security-rbac.test.ts` |
| 8 | Medium | MFA (TOTP) verification has no per-account brute-force lockout | Auth | (documented) |
| 9 | Medium | `ALLOW_PRIVATE_NETWORK_EGRESS` is a global SSRF kill-switch only *warned* in production | Config | (documented) |
| 10 | Low | Transitive dependency advisories (`postcss` via `next`, 2×high) | Deps | CI `dependency-audit` job |

**Verified secure** (held under testing — see the bottom section), including the
database-role deliverable: all per-org isolation checks pass under the runtime
role (`tests/integration/security-db-isolation.test.ts`, 8/8).

---

## 1. Critical — SSO JIT account takeover and cross-tenant pivot

`packages/auth/src/sso.ts` · `completeOidc` (JIT branch ~`:254-266`).

`completeOidc` looks up an existing user by the id_token's `email` and, under
JIT provisioning, **attaches a membership to that pre-existing account and
issues a session as that user** — with no proof that the organization owns the
email domain. Three compounding problems:

- The organization's `domains` are self-declared (`configureOidc`), never
  verified; and when `domains` is empty the domain check is skipped entirely
  (`sso.ts:244`: `if (idp.domains.length && !idp.domains.includes(domain))`).
- `email_verified` is only rejected when explicitly `false`; an IdP that omits
  it passes.
- The issued session is the **victim's** identity, so `switchOrganization`
  (which trusts the victim's real memberships) lets the attacker pivot into the
  victim's other tenants.

**Proof (PoC test, run end to end):** an attacker-controlled IdP (own signing
key, own token endpoint) mints an id_token for a victim's email. The test shows
`completeOidc` returns `{ organizationId, token }` as the victim, and
`switchOrganization(token, victimOrg)` **succeeds**. With empty `domains`, any
email is accepted.

```
tests/security/security-sso.test.ts
  × refuses to issue a session as a pre-existing user … (takeover succeeds today)
  × if a session is somehow issued, it must not pivot into the victim's org (pivot succeeds today)
  × an empty domains list must not mean 'accept every email domain'
  ✓ control: a genuine member with a matching owned domain can sign in
```

**Impact:** any tenant administrator (every tenant admin is untrusted w.r.t.
other tenants) can take over any existing user account on the platform and reach
that user's other organizations. Full multi-tenant compromise.

**Fix (direction, `completeOidc`):**
- Never auto-link JIT to a pre-existing user that has a password or a membership
  elsewhere. JIT may create a *new* user for a *verified-owned* domain only;
  linking an existing account requires an explicit invitation/consent step.
- Require `email_verified === true` when provisioning.
- Treat an empty `domains` list as deny for JIT (require at least one verified
  domain). Add domain-ownership verification (DNS TXT, mirroring
  `organization_domains`) before an IdP's `domains` take effect.

```diff
--- a/packages/auth/src/sso.ts
+++ b/packages/auth/src/sso.ts
@@ completeOidc
-      if (!email || payload.email_verified === false) throw new AppError("UNAUTHENTICATED", "The identity provider did not return a verified email.");
+      if (!email || payload.email_verified !== true) throw new AppError("UNAUTHENTICATED", "The identity provider did not return a verified email.");
       const domain = email.split("@")[1]!;
-      if (idp.domains.length && !idp.domains.includes(domain)) throw new AppError("FORBIDDEN", "Your email domain is not permitted for this identity provider.");
+      // JIT requires at least one verified-owned domain, and the email must match it.
+      if (!idp.domains.length || !idp.domains.includes(domain)) throw new AppError("FORBIDDEN", "Your email domain is not permitted for this identity provider.");
@@ JIT branch
-      } else if (idp.jitProvisioning && (!member || member.status === "invited")) {
-        if (!user) {
+      } else if (idp.jitProvisioning && (!member || member.status === "invited")) {
+        // Never silently adopt a pre-existing account that the org has not been invited into.
+        if (user) throw new AppError("FORBIDDEN", "An account with this email already exists; it must accept an invitation to join via SSO.");
+        {
```
(Plus: gate IdP `domains` behind verified ownership — reuse the
`organization_domains` TXT-verification flow.)

---

## 2. High — SSO `defaultRoleKey` privilege escalation to `org_admin`

`packages/auth/src/sso.ts` — `configureOidc` (`defaultRoleKey` unvalidated,
schema `:29`), `completeOidc:266` → `roles.grantInternal(ctx, m.id, idp.defaultRoleKey)`.
`packages/rbac/src/role-service.ts:249-255` — `grantInternal` performs **no**
anti-escalation / SoD / self / last-admin checks; it only blocks `platform_admin`.

Configuring and activating an OIDC IdP requires only `org.security.manage`.
`security_admin` holds that but **not** `role.manage`, so it cannot assign
`org_admin` through the role service (anti-escalation would block it). The SSO
path has no such guard: set `defaultRoleKey: "org_admin"`, JIT-provision a fresh
attacker-owned email, and the new membership is granted `org_admin`.

**Proof:** `tests/security/security-sso.test.ts` → "JIT provisioning must not
grant a privileged role chosen in the IdP config" (fails today; the JIT member
receives `org_admin`).

**Fix:** validate `defaultRoleKey` at `configureOidc` time against the
configurer's held permissions (the same holds-check `invite` uses) and reject
system/admin roles for JIT; and/or make `grantInternal` take an explicit
hard-coded key only (route tenant-influenced keys through a checked grant).

```diff
--- a/packages/auth/src/sso.ts
+++ b/packages/auth/src/sso.ts
@@ async configureOidc(ctx, raw) {
       await authorizer.require(ctx, "org.security.manage");
       const input = configureOidcSchema.parse(raw);
+      // The provisioning role may not exceed what the configurer holds, and never a system/admin role.
+      const held = await authorizer.effective(ctx);
+      const role = (await deps.roles.listRoles(ctx)).find((r) => r.key === input.defaultRoleKey);
+      if (!role) throw new AppError("VALIDATION_FAILED", `Unknown role "${input.defaultRoleKey}".`);
+      if (role.permissions.some((p) => !held.orgWide.has(p))) throw forbidden(`You cannot set "${role.name}" as the JIT role.`);
```

---

## 3. High — SSRF guard bypass: IPv4-mapped IPv6 in hex-group form

`packages/security/src/url-guard.ts` · `isPrivateAddress:52-56`.

`isPrivateAddress` only recurses on the **dotted** mapped form (`::ffff:127.0.0.1`).
`node:net.isIP` also accepts the hex-group form `::ffff:7f00:1`; `slice(7)` yields
`"7f00:1"`, which is not recognised as IPv4 and falls through every v6 check →
treated as public. So `https://[::ffff:7f00:1]/` (127.0.0.1) and
`https://[::ffff:a9fe:a9fe]/` (169.254.169.254, cloud metadata) pass the guard.
Separately, the link-local check matches only `fe80::`, missing the rest of
`fe80::/10` (`fe90::`–`febf::`).

**Proof:** `tests/security/security-ssrf.test.ts` — `isPrivateAddress("::ffff:7f00:1")`,
`("::ffff:a9fe:a9fe")`, `("fe90::1")`, `("febf::1")`, and the end-to-end
`https://[::ffff:7f00:1]/` all fail the secure assertion today.

**Fix:**

```diff
--- a/packages/security/src/url-guard.ts
+++ b/packages/security/src/url-guard.ts
@@ export function isPrivateAddress(addr: string): boolean {
   const v6 = addr.toLowerCase();
-  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
-  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
+  if (v6.startsWith("::ffff:")) {
+    const mapped = v6.slice(7);
+    if (isIP(mapped) === 4) return isPrivateAddress(mapped);
+    // Hex-group form, e.g. ::ffff:7f00:1 — convert the last two groups to dotted IPv4.
+    const groups = mapped.split(":");
+    if (groups.length === 2) {
+      const hi = parseInt(groups[0]!, 16), lo = parseInt(groups[1]!, 16);
+      if (Number.isFinite(hi) && Number.isFinite(lo)) return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
+    }
+    return true; // unpar----seable mapped form: fail closed
+  }
+  // fe80::/10 is fe80..febf.
+  const hextet = parseInt(v6.split(":")[0] || "0", 16);
+  const linkLocal = hextet >= 0xfe80 && hextet <= 0xfebf;
+  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || linkLocal;
```

---

## 4. High — SSRF via DNS rebinding (no IP pinning); leaks connector credentials

`packages/security/src/url-guard.ts:30-38` validates the **resolved** IP but
returns a `URL` with the **hostname** intact; the caller's fetch
(`packages/connectors/src/http.ts:18`) re-resolves that hostname independently.
An attacker-controlled domain answers a public IP to the guard's lookup and
`169.254.169.254` / `127.0.0.1` to the fetch's lookup (or flips on a short TTL).
Because the REST adapter attaches connector credentials on every call
(`packages/connectors/src/adapters/rest.ts:57`), a rebind leaks the connector's
API key / bearer / basic token to the attacker-chosen internal host. Applies to
connectors, webhooks, OIDC and the OAuth token endpoint.

**Proof:** `tests/security/security-ssrf.test.ts` — "pins the resolved address
so the fetch cannot be rebound" (the guard returns the hostname, not the vetted
IP).

**Fix:** pin the address that was vetted. Return the resolved IP (or expose it)
and have the guarded fetch connect to that IP with the original `Host` header
(or pass a fixed `lookup` to undici that returns only the vetted address). Do
not resolve the hostname a second time.

---

## 5. High — PDF parser ReDoS hangs the worker (inline, synchronous)

`modules/knowledge-verification/src/extract.ts` · `pdfToText` text-operator
regex (~`:235`). The nested-quantifier group
`(?:\([^)]*(?:\\\)[^)]*)*\)|[^\]])*` exhibits catastrophic backtracking.
Extraction runs **inline and synchronously** in the ingest request
(`service.ts:319-325`, `:685`); the surrounding `try/catch` catches thrown
errors but not an event-loop hang, so one uploaded document wedges the whole web
/ worker process.

**Proof:** `tests/security/security-upload.test.ts` runs the real `pdfToText`
**out of process with a 4s hard kill** on a crafted content stream
(`(z)Tj [(a\)(a\)…`). Measured ~2.5s at 18 groups; it hangs past the budget at
≥22. The benign control extracts correctly.

**Fix:** replace the regex text-operator scanner with a linear tokenizer (walk
the content stream, no backtracking), and/or move extraction into a background
job / worker thread with a CPU-time and memory bound so a bad document fails one
ingest instead of the process.

---

## 6. Medium — Zip-bomb aggregate-memory guard trusts the declared size

`modules/knowledge-verification/src/extract.ts` · `readZip:130`.
Per-entry inflation is correctly capped at 50 MB
(`inflateRawSync(..., { maxOutputLength: MAX_ENTRY_BYTES })`), but the aggregate
guard uses the **central-directory's attacker-declared** uncompressed size
(`usize = buf.readUInt32LE(p + 24)`), not the bytes actually produced:
`if (usize > MAX_ENTRY_BYTES || (total += usize) > MAX_ENTRY_BYTES * 2) throw …`.
Declaring `usize = 1` slips past the ~100 MB aggregate cap while each of up to
5000 entries still inflates to the real 50 MB and is retained in the in-memory
`Map` — multiple GB resident → OOM. Inline execution (as in #5) means it kills
the process.

> No executable PoC is shipped: a faithful OOM reproduction allocates hundreds
> of MB and would destabilise shared CI. The code path and crafted input are
> precise enough to fix and unit-test against the *actual* inflated size.

**Fix:** accumulate the real inflated byte count returned by `inflateRawSync`
against the aggregate cap (ignore `usize` for enforcement), lower the entry-count
cap, and fail closed when the cap is hit.

```diff
--- a/modules/knowledge-verification/src/extract.ts
+++ b/modules/knowledge-verification/src/extract.ts
@@ readZip
-    if (usize > MAX_ENTRY_BYTES || (total += usize) > MAX_ENTRY_BYTES * 2) throw new Error("ZIP package is too large when inflated.");
     if (!/\.xml$|\.rels$/.test(name)) continue;
     const lnlen = buf.readUInt16LE(local + 26);
     const lelen = buf.readUInt16LE(local + 28);
     const data = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
     if (method === 0) out.set(name, Buffer.from(data));
-    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
+    else if (method === 8) {
+      const inflated = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
+      if ((total += inflated.length) > MAX_ENTRY_BYTES * 2) throw new Error("ZIP package is too large when inflated.");
+      out.set(name, inflated);
+    }
```

---

## 7. Medium — Separation-of-duties bypass via invitation / SSO JIT

SoD constraints (`auditor ⊥ org_admin`, `auditor ⊥ security_admin`,
`packages/rbac/src/roles.ts:104-107`) are enforced only in `roles.assign()`
(`role-service.ts:188-197`). The invitation path grants each role via the
check-free `grantInternal` (`auth-service.ts:111-113`, `:254`) and validates only
domain + anti-escalation, not SoD. An `org_admin` can invite
`roleKeys: ["auditor","org_admin"]` and the accepted member holds both — the
exact combination `assign()` forbids.

**Proof:** `tests/security/security-rbac.test.ts` — "an invitation cannot grant
auditor + org_admin together" fails today; the "assign() blocks a conflicting
pair" control passes.

**Fix:** run `SOD_CONSTRAINTS` against the full requested role set in
`organizations.invite` (and the SSO JIT role), and centralise SoD / last-admin /
self checks in a shared grant helper rather than leaving `grantInternal`
check-free.

---

## 8. Medium — MFA (TOTP) verification has no per-account lockout

`apps/web/src/app/api/v1/auth/mfa/verify/route.ts` is rate-limited **per IP**
(10 / 5 min) only; `packages/auth/src/auth-service.ts` `verifyMfa` has no
per-account or per-session failure counter. A distributed attacker (or one
spoofing `X-Forwarded-For` where the app is directly exposed — the documented
last-XFF behaviour, `packages/api/src/http.ts:71`) gets 10 attempts per 5 min
*per IP* against a single pending session, with no account-side cap. Over time,
with the TOTP acceptance window, this is a feasible brute force.

**Fix:** track a failure count on the `mfaPending` session (or the user) and
revoke the pending session / lock after N failed codes (mirroring the password
lockout), independent of IP.

---

## 9. Medium — `ALLOW_PRIVATE_NETWORK_EGRESS` is a global kill-switch, only warned in production

`packages/security/src/url-guard.ts:27` early-returns before any host check when
`allowPrivateNetworks` is set, disabling the SSRF defense platform-wide
(connectors, webhooks, SSO, OpenAI-compatible providers). In production this only
emits `console.warn` (`packages/platform/src/config.ts:34`) and still runs. A
single misconfiguration silently opens SSRF to `169.254.169.254` and all internal
services.

**Fix:** in production, do not honour a blanket `allowPrivateNetworks`; require an
explicit per-host allowlist for the on-prem targets that need it, or hard-fail
startup unless a second explicit acknowledgement variable is set.

---

## 10. Low — Transitive dependency advisories

`pnpm audit --prod --audit-level high` reports 2 high advisories in `postcss`
(pulled transitively by `next`): path-traversal in source-map autoloading and a
related parser issue (`GHSA-r28c-9q8g-f849`, `GHSA-6g55-p6wh-862q`). Low runtime
impact (build-time tooling) but real, and the new CI `dependency-audit` job fails
on them. Remediate by forcing a patched version:

```diff
--- a/package.json
+++ b/package.json
@@
   "pnpm": {
+    "overrides": { "postcss@<8.5.18": ">=8.5.18" }
   }
```
(or bump `next` to a release that pins patched `postcss`).

---

## Verified secure (held under testing)

- **Per-organization database isolation under the production role** — the runtime
  role is `NOSUPERUSER`/`NOBYPASSRLS`, owns no table (cannot `DISABLE`/`NO FORCE`
  RLS), every one of the 112 `organization_id` tables has RLS **enabled and
  forced** with a policy, identity tables (`users`, `sessions`, `auth_tokens`,
  `memberships`) are owner/co-member scoped, tenant scope returns only the
  tenant's rows, and a hypothetical leaked session-level `app.system_context`
  GUC is overridden by the per-transaction reset. `tests/integration/security-db-isolation.test.ts` (8/8 pass) — this is a durable regression guard in the default suite.
- **`platform.admin` is unreachable by tenants** — short-circuited to the context
  flag; never grantable via roles, API keys, scoped grants, or the `system` actor
  (`authorizer.ts:83-85`, `role-service.ts:137,154,181,251`, `api-keys.ts:28`).
- **Anti-escalation** on role create/update/assign and invitations; **IDOR** —
  org/user/membership ids come only from the authenticated context, never the
  body; role/permission writes re-authorize in the service, not just at the route.
- **API keys** cannot exceed the creating actor and exclude non-delegable scopes;
  enforced on every request.
- **Module entitlement** is enforced in the authorizer by permission-owner, so a
  module service is unreachable for a tenant that has not enabled it even if a
  route omits the `module` option; cross-module caller-naming grants no data.
- **CSRF** — origin/referer allowlist + constant-time double-submit token, plus
  login-CSRF origin rejection on public mutations; **sessions** — 256-bit opaque
  token minted fresh on login (no fixation), SHA-256 at rest, idle + absolute
  timeouts, revoke on password change/reset and on membership loss; **login** —
  per-account lockout, timing equalization, generic errors, no enumeration.
- **Upload parsing** — XXE (the parser is string-based; no DTD/entity resolution)
  and zip-slip (entries never touch the filesystem) are not exploitable;
  per-entry inflation is hard-capped; malformed files fail closed.

## Running the suite

```
pnpm test:security          # the findings' regression tests (expected red until fixed)
pnpm test                   # the normal suite, incl. the passing RLS isolation guard
pnpm audit --prod --audit-level high   # dependency gate (as CI runs it)
```
