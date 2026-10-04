"use client";

import { useState } from "react";
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, FormField, Input, Switch } from "@eaop/design-system";
import { type NotificationView } from "@eaop/notifications";
import { apiFetch } from "@/lib/client";
import { ActionButton, useMutation } from "@/components/actions";

export function NotificationsList({ items, prefs }: { items: NotificationView[]; prefs: Array<{ type: string; description: string; channel: string; enabled: boolean; mandatory: boolean }> }) {
  const { run } = useMutation();
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Inbox" actions={<ActionButton size="sm" variant="ghost" path="/notifications/read" body={{ ids: "all" }} success="All marked read">Mark all read</ActionButton>} />
        <CardBody flush>
          <ul className="divide-y divide-border">
            {items.length === 0 && <li className="p-6 text-center text-sm text-muted">No notifications.</li>}
            {items.map((n) => (
              <li key={n.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${n.readAt ? "" : "bg-accent-subtle/40"}`}>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 text-sm font-medium">{n.title}<Badge tone={n.priority === "critical" ? "danger" : n.priority === "high" ? "warning" : "neutral"}>{n.priority}</Badge></div>
                  {n.body && <p className="text-sm text-muted">{n.body}</p>}
                  <p className="text-xs text-subtle">{n.moduleId} · {new Date(n.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {n.actionUrl && <a className="text-sm text-accent" href={n.actionUrl}>Open</a>}
                  {!n.readAt && <Button size="sm" variant="ghost" onClick={() => void run(() => apiFetch("/notifications/read", { body: { ids: [n.id] } }))}>Mark read</Button>}
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Preferences" description="Mandatory security notifications cannot be turned off." />
        <CardBody className="space-y-3">
          {prefs.map((p) => (
            <Switch key={`${p.type}:${p.channel}`} size="sm" checked={p.enabled} disabled={p.mandatory} label={<span className="text-sm">{p.description}</span>} description={`${p.channel.replace("_", "-")}${p.mandatory ? " · required" : ""}`} onCheckedChange={(v) => void run(() => apiFetch("/notifications/preferences", { method: "PUT", body: { type: p.type, channel: p.channel, enabled: v } }))} />
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

export function ProfileSecurity({ mfaEnabled, sessions }: { mfaEnabled: boolean; sessions: Array<{ id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; authMethod: string; current: boolean }> }) {
  const { run, pending } = useMutation();
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [code, setCode] = useState("");
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Password" description="Changing your password signs out your other sessions." />
        <CardBody className="space-y-3">
          <FormField id="pw-cur" label="Current password">{(a) => <Input {...a} type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />}</FormField>
          <FormField id="pw-new" label="New password" hint="At least 12 characters (your organization may require more).">{(a) => <Input {...a} type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />}</FormField>
        </CardBody>
        <CardFooter><Button loading={pending} onClick={async () => { if (await run(() => apiFetch("/auth/password/change", { body: pw }), { success: "Password changed" })) setPw({ currentPassword: "", newPassword: "" }); }}>Change password</Button></CardFooter>
      </Card>
      <Card>
        <CardHeader title="Two-step verification" actions={mfaEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>} />
        <CardBody className="space-y-3 text-sm">
          {mfaEnabled ? (
            <>
              <p>Enter a current code to turn off two-step verification.</p>
              <Input aria-label="Verification code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <Button variant="danger" size="sm" loading={pending} disabled={code.length !== 6} onClick={() => void run(() => apiFetch("/auth/mfa/disable", { body: { code } }), { success: "Two-step verification turned off" })}>Turn off</Button>
            </>
          ) : (
            <>
              <p>Protect your account with an authenticator app.</p>
              <a className="text-accent" href="/mfa/enroll">Set up two-step verification</a>
            </>
          )}
        </CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Active sessions" />
        <CardBody flush>
          <ul className="divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div><div className="font-medium">{s.userAgent?.slice(0, 80) ?? "Unknown device"} {s.current && <Badge tone="accent">This session</Badge>}</div><div className="text-xs text-muted">{s.ip ?? "unknown IP"} · {s.authMethod} · last active {new Date(s.lastSeenAt).toLocaleString()}</div></div>
                {!s.current && <ActionButton size="sm" variant="ghost" path={`/auth/sessions/${s.id}`} method="DELETE" success="Session signed out">Sign out</ActionButton>}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
