"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CodeBlock, FormField, Input, Select, StatusBadge, Switch, Textarea } from "@eaop/design-system";
import { apiFetch } from "@/lib/client";
import { ActionButton, useMutation } from "@/components/actions";

type Security = { mfaRequired: boolean; sessionIdleMinutes: number; sessionMaxHours: number; passwordMinLength: number; allowedEmailDomains: string[]; ipAllowlist: string[]; ssoEnforced: boolean };
type Retention = { auditDays: number; aiPromptRetention: "none" | "metadata" | "full"; aiRunDays: number; notificationDays: number; usageDays: number };
const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function OrganizationSettings({ org, domains, usageLimits, canManage }: { org: { name: string; slug: string; primaryDomain: string | null; environment: string; plan: string }; domains: Array<{ id: string; domain: string; verified: boolean; verificationRecord: string }>; usageLimits: { monthlyAiCostUsd?: number; monthlyAiTokens?: number }; canManage: boolean }) {
  const { run, pending } = useMutation();
  const [name, setName] = useState(org.name);
  const [domain, setDomain] = useState("");
  const [cost, setCost] = useState(usageLimits.monthlyAiCostUsd?.toString() ?? "");
  const [tokens, setTokens] = useState(usageLimits.monthlyAiTokens?.toString() ?? "");
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Profile" description={`Slug ${org.slug} · ${org.environment} · ${org.plan} plan`} />
        <CardBody><FormField id="org-name" label="Organization name">{(a) => <Input {...a} value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />}</FormField></CardBody>
        {canManage && <CardFooter><Button loading={pending} onClick={() => void run(() => apiFetch("/organization", { method: "PATCH", body: { name } }), { success: "Saved" })}>Save</Button></CardFooter>}
      </Card>
      <Card>
        <CardHeader title="Usage limits" description="Crossing a limit notifies usage viewers once per month. Nothing is blocked automatically." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <FormField id="lim-cost" label="Monthly AI cost (USD)">{(a) => <Input {...a} type="number" min={0} value={cost} disabled={!canManage} onChange={(e) => setCost(e.target.value)} />}</FormField>
          <FormField id="lim-tok" label="Monthly AI input tokens">{(a) => <Input {...a} type="number" min={0} value={tokens} disabled={!canManage} onChange={(e) => setTokens(e.target.value)} />}</FormField>
        </CardBody>
        {canManage && <CardFooter><Button loading={pending} onClick={() => void run(() => apiFetch("/organization/settings/usage-limits", { method: "PATCH", body: { ...(cost ? { monthlyAiCostUsd: Number(cost) } : {}), ...(tokens ? { monthlyAiTokens: Number(tokens) } : {}) } }), { success: "Limits saved" })}>Save limits</Button></CardFooter>}
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Domains" description="Verify ownership with a DNS TXT record. Verified domains enable SSO discovery." />
        <CardBody className="space-y-3">
          {domains.length === 0 && <p className="text-sm text-muted">No domains added.</p>}
          {domains.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2 font-medium">{d.domain} <StatusBadge status={d.verified ? "active" : "pending"} label={d.verified ? "Verified" : "Unverified"} /></div>
                {!d.verified && <p className="text-xs text-muted">Add TXT record <code className="font-mono">_eaop-verification.{d.domain}</code> = <code className="font-mono">{d.verificationRecord}</code></p>}
              </div>
              {!d.verified && canManage && <ActionButton size="sm" variant="secondary" path={`/organization/domains/${d.id}/verify`} success="Verification checked">Check DNS</ActionButton>}
            </div>
          ))}
          {canManage && (
            <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => apiFetch("/organization/domains", { body: { domain } }), { success: "Domain added" })) setDomain(""); }}>
              <Input aria-label="Domain" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
              <Button type="submit" variant="secondary" loading={pending}>Add domain</Button>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

export function SecuritySettings({ security, retention, idps, canManage }: { security: Security; retention: Retention; idps: Array<{ id: string; protocol: string; name: string; status: string; domains: string[]; jitProvisioning: boolean; config: Record<string, unknown> }>; canManage: boolean }) {
  const { run, pending } = useMutation();
  const [s, setS] = useState(security);
  const [domainsText, setDomainsText] = useState(security.allowedEmailDomains.join("\n"));
  const [ipsText, setIpsText] = useState(security.ipAllowlist.join("\n"));
  const [r, setR] = useState(retention);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const [oidc, setOidc] = useState({ name: "", issuer: "", clientId: "", clientSecret: "", domains: "", jitProvisioning: false });
  const num = (v: string) => Number(v) || 0;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Authentication policy" />
        <CardBody className="space-y-4">
          <Switch checked={s.mfaRequired} disabled={!canManage} onCheckedChange={(v) => setS({ ...s, mfaRequired: v })} label="Require multi-factor authentication" description="Members without MFA must enroll before continuing." />
          <Switch checked={s.ssoEnforced} disabled={!canManage} onCheckedChange={(v) => setS({ ...s, ssoEnforced: v })} label="Enforce single sign-on" description="Password sign-in is refused for members (platform administrators excepted)." />
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField id="s-idle" label="Idle timeout (min)">{(a) => <Input {...a} type="number" value={s.sessionIdleMinutes} disabled={!canManage} onChange={(e) => setS({ ...s, sessionIdleMinutes: num(e.target.value) })} />}</FormField>
            <FormField id="s-max" label="Session max (hours)">{(a) => <Input {...a} type="number" value={s.sessionMaxHours} disabled={!canManage} onChange={(e) => setS({ ...s, sessionMaxHours: num(e.target.value) })} />}</FormField>
            <FormField id="s-pw" label="Min password length">{(a) => <Input {...a} type="number" min={12} value={s.passwordMinLength} disabled={!canManage} onChange={(e) => setS({ ...s, passwordMinLength: num(e.target.value) })} />}</FormField>
          </div>
          <FormField id="s-domains" label="Allowed invitation email domains" hint="One per line. Empty allows any domain.">{(a) => <Textarea {...a} rows={3} value={domainsText} disabled={!canManage} onChange={(e) => setDomainsText(e.target.value)} />}</FormField>
          <FormField id="s-ips" label="IP allowlist (IPv4 CIDR or exact IP)" hint="One per line. Empty allows any network. Make sure your own address is included.">{(a) => <Textarea {...a} rows={3} value={ipsText} disabled={!canManage} onChange={(e) => setIpsText(e.target.value)} />}</FormField>
        </CardBody>
        {canManage && <CardFooter><Button loading={pending} onClick={() => void run(() => apiFetch("/organization/settings/security", { method: "PATCH", body: { ...s, allowedEmailDomains: lines(domainsText), ipAllowlist: lines(ipsText) } }), { success: "Security policy saved" })}>Save policy</Button></CardFooter>}
      </Card>
      <Card>
        <CardHeader title="Data retention" description="Applied daily by the worker. Audit retention has a 90-day floor enforced by the database." />
        <CardBody className="space-y-4">
          <FormField id="r-prompt" label="AI prompt & response retention" hint="metadata = hashes and sizes only (default). full = store content.">{(a) => <Select {...a} value={r.aiPromptRetention} disabled={!canManage} onChange={(e) => setR({ ...r, aiPromptRetention: e.target.value as Retention["aiPromptRetention"] })} options={[{ value: "none", label: "None" }, { value: "metadata", label: "Metadata only" }, { value: "full", label: "Full content" }]} />}</FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="r-audit" label="Audit log (days)">{(a) => <Input {...a} type="number" min={90} value={r.auditDays} disabled={!canManage} onChange={(e) => setR({ ...r, auditDays: num(e.target.value) })} />}</FormField>
            <FormField id="r-ai" label="AI runs (days)">{(a) => <Input {...a} type="number" value={r.aiRunDays} disabled={!canManage} onChange={(e) => setR({ ...r, aiRunDays: num(e.target.value) })} />}</FormField>
            <FormField id="r-notes" label="Notifications (days)">{(a) => <Input {...a} type="number" value={r.notificationDays} disabled={!canManage} onChange={(e) => setR({ ...r, notificationDays: num(e.target.value) })} />}</FormField>
            <FormField id="r-usage" label="Usage events (days)">{(a) => <Input {...a} type="number" value={r.usageDays} disabled={!canManage} onChange={(e) => setR({ ...r, usageDays: num(e.target.value) })} />}</FormField>
          </div>
        </CardBody>
        {canManage && <CardFooter><Button loading={pending} onClick={() => void run(() => apiFetch("/organization/settings/retention", { method: "PATCH", body: r }), { success: "Retention saved" })}>Save retention</Button></CardFooter>}
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Single sign-on" description="OIDC is supported. SAML configuration is stored but sign-in is not implemented yet. SCIM provisioning is not available." />
        <CardBody className="space-y-4">
          {idps.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
              <div>
                <div className="flex items-center gap-2 font-medium">{i.name} <Badge>{i.protocol.toUpperCase()}</Badge> <StatusBadge status={i.status} /></div>
                <p className="text-xs text-muted">{String(i.config.issuer ?? i.config.entityId ?? "")} · domains: {i.domains.join(", ") || "none"}{i.jitProvisioning ? " · just-in-time provisioning" : ""}</p>
              </div>
              {canManage && <Button size="sm" variant="secondary" onClick={() => void run(() => apiFetch(`/organization/identity-providers/${i.id}`, { method: "PATCH", body: { status: i.status === "active" ? "disabled" : "active" } }), { success: "Updated" })}>{i.status === "active" ? "Disable" : "Activate"}</Button>}
            </div>
          ))}
          {canManage && (
            <form className="grid gap-3 rounded-md border border-dashed border-border p-4 sm:grid-cols-2" onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => apiFetch("/organization/identity-providers", { body: { protocol: "oidc", name: oidc.name, issuer: oidc.issuer, clientId: oidc.clientId, ...(oidc.clientSecret ? { clientSecret: oidc.clientSecret } : {}), domains: lines(oidc.domains), jitProvisioning: oidc.jitProvisioning } }), { success: "Identity provider added as draft" });
              if (ok) setOidc({ name: "", issuer: "", clientId: "", clientSecret: "", domains: "", jitProvisioning: false });
            }}>
              <h3 className="text-sm font-semibold sm:col-span-2">Add OIDC identity provider</h3>
              <FormField id="o-name" label="Name">{(a) => <Input {...a} value={oidc.name} onChange={(e) => setOidc({ ...oidc, name: e.target.value })} placeholder="Okta" />}</FormField>
              <FormField id="o-iss" label="Issuer URL">{(a) => <Input {...a} type="url" value={oidc.issuer} onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })} placeholder="https://acme.okta.com" />}</FormField>
              <FormField id="o-cid" label="Client ID">{(a) => <Input {...a} value={oidc.clientId} onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })} />}</FormField>
              <FormField id="o-sec" label="Client secret">{(a) => <Input {...a} type="password" autoComplete="off" value={oidc.clientSecret} onChange={(e) => setOidc({ ...oidc, clientSecret: e.target.value })} />}</FormField>
              <FormField id="o-dom" label="Email domains" hint="Comma separated; used for sign-in discovery.">{(a) => <Input {...a} value={oidc.domains} onChange={(e) => setOidc({ ...oidc, domains: e.target.value })} />}</FormField>
              <div className="flex items-end"><Switch checked={oidc.jitProvisioning} onCheckedChange={(v) => setOidc({ ...oidc, jitProvisioning: v })} label="Just-in-time provisioning" /></div>
              <div className="sm:col-span-2"><Button type="submit" variant="secondary" loading={pending}>Add provider</Button></div>
              <p className="text-xs text-muted sm:col-span-2">Redirect URI to register with your IdP: <code className="font-mono">{origin}/api/v1/auth/sso/oidc/callback</code></p>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

export function ApiKeysAdmin({ keys, scopes, canManage }: { keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }>; scopes: string[]; canManage: boolean }) {
  const { run, pending } = useMutation();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      {created && (
        <Card><CardHeader title="Copy your new API key" description="It is shown only once. Store it in your secret manager." /><CardBody><CodeBlock code={created} /></CardBody><CardFooter><Button variant="secondary" onClick={() => setCreated(null)}>Done</Button></CardFooter></Card>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {keys.length === 0 && <li className="p-4 text-sm text-muted">No API keys.</li>}
        {keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <div className="flex items-center gap-2 font-medium">{k.name} <code className="font-mono text-xs text-muted">eaop_{k.prefix}_…</code>{k.revokedAt ? <Badge tone="danger">Revoked</Badge> : k.expiresAt && new Date(k.expiresAt) < new Date() ? <Badge tone="warning">Expired</Badge> : <Badge tone="success">Active</Badge>}</div>
              <p className="text-xs text-muted">{k.scopes.join(", ")} · last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}</p>
            </div>
            {canManage && !k.revokedAt && <ActionButton size="sm" variant="ghost" path={`/api-keys/${k.id}`} method="DELETE" success="Key revoked" confirm={{ title: `Revoke ${k.name}?`, message: "Integrations using this key stop working immediately." }}>Revoke</ActionButton>}
          </li>
        ))}
      </ul>
      {canManage && (
        <Card>
          <CardHeader title="Create API key" description="Keys act with exactly the scopes you select — never more than you hold. role.manage and apikey.manage cannot be delegated." />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="k-name" label="Name">{(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} placeholder="CI pipeline" />}</FormField>
              <FormField id="k-days" label="Expires in (days)">{(a) => <Input {...a} type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} />}</FormField>
            </div>
            <fieldset className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted">Scopes</legend>
              {scopes.map((sc) => (
                <label key={sc} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(sc)} onChange={(e) => setSelected(e.target.checked ? [...selected, sc] : selected.filter((x) => x !== sc))} /> <code className="font-mono text-xs">{sc}</code></label>
              ))}
            </fieldset>
          </CardBody>
          <CardFooter><Button loading={pending} disabled={!name || selected.length === 0} onClick={async () => { const r = await run(() => apiFetch<{ key: string }>("/api-keys", { body: { name, scopes: selected, expiresInDays: Number(days) || undefined } }), { success: "API key created" }); if (r) { setCreated(r.key); setName(""); setSelected([]); } }}>Create key</Button></CardFooter>
        </Card>
      )}
    </div>
  );
}

export function WebhooksAdmin({ hooks, events }: { hooks: Array<{ id: string; url: string; description: string | null; eventTypes: string[]; status: string; consecutiveFailures: number; lastDeliveryAt: string | null; lastDeliveryStatus: number | null }>; events: Array<{ type: string; owner: string; description: string; externallyVisible: boolean }> }) {
  const { run, pending } = useMutation();
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const visible = events.filter((e) => e.externallyVisible);
  return (
    <div className="space-y-6">
      {secret && <Card><CardHeader title="Signing secret" description="Shown once. Verify the x-eaop-signature header: t=<unix>,v1=HMAC-SHA256(secret, `${t}.${body}`)." /><CardBody><CodeBlock code={secret} /></CardBody><CardFooter><Button variant="secondary" onClick={() => setSecret(null)}>Done</Button></CardFooter></Card>}
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {hooks.length === 0 && <li className="p-4 text-sm text-muted">No webhooks.</li>}
        {hooks.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium"><span className="truncate">{h.url}</span> <StatusBadge status={h.status} /></div>
              <p className="text-xs text-muted">{h.eventTypes.join(", ")} · last delivery {h.lastDeliveryAt ? `${new Date(h.lastDeliveryAt).toLocaleString()} (${h.lastDeliveryStatus || "network error"})` : "never"}{h.consecutiveFailures ? ` · ${h.consecutiveFailures} consecutive failures` : ""}</p>
            </div>
            <ActionButton size="sm" variant="ghost" path={`/webhooks/${h.id}`} method="DELETE" success="Webhook deleted" confirm={{ title: "Delete webhook?", message: h.url }}>Delete</ActionButton>
          </li>
        ))}
      </ul>
      <Card>
        <CardHeader title="Add webhook" description="Events are delivered at least once with retries; make your endpoint idempotent using the event id." />
        <CardBody className="space-y-4">
          <FormField id="wh-url" label="Endpoint URL (HTTPS)">{(a) => <Input {...a} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />}</FormField>
          <fieldset className="grid max-h-72 gap-1 overflow-y-auto rounded-md border border-border p-3 md:grid-cols-2">
            <legend className="px-1 text-xs font-semibold text-muted">Events</legend>
            {visible.map((ev) => (
              <label key={ev.type} className="flex items-start gap-2 text-sm" title={ev.description}><input className="mt-1" type="checkbox" checked={types.includes(ev.type)} onChange={(e) => setTypes(e.target.checked ? [...types, ev.type] : types.filter((x) => x !== ev.type))} /> <span><code className="font-mono text-xs">{ev.type}</code> <span className="text-xs text-muted">{ev.owner}</span></span></label>
            ))}
          </fieldset>
        </CardBody>
        <CardFooter><Button loading={pending} disabled={!url || types.length === 0} onClick={async () => { const r = await run(() => apiFetch<{ signingSecret: string }>("/webhooks", { body: { url, eventTypes: types } }), { success: "Webhook created" }); if (r) { setSecret(r.signingSecret); setUrl(""); setTypes([]); } }}>Add webhook</Button></CardFooter>
      </Card>
    </div>
  );
}
