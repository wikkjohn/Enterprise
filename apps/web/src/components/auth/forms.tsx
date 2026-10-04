"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, CodeBlock, ErrorState, FormField, Input, LoadingState } from "@eaop/design-system";
import { apiFetch } from "@/lib/client";
import { errorMessage } from "@/components/actions";

function Alert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sso, setSso] = useState<{ idpId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onEmailBlur() {
    if (!email.includes("@")) return;
    const r = await apiFetch<{ sso: boolean; idpId?: string; name?: string }>("/auth/sso/discover", { body: { email } }).catch(() => null);
    setSso(r?.sso && r.idpId ? { idpId: r.idpId, name: r.name ?? "your identity provider" } : null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const r = await apiFetch<{ status: string }>("/auth/login", { body: { email, password } });
      router.push(r.status === "mfa_required" ? "/mfa" : "/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h1 className="text-lg font-semibold">Sign in</h1>
      <Alert message={error} />
      <FormField id="email" label="Work email" required>
        {(a) => <Input {...a} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={onEmailBlur} required />}
      </FormField>
      {sso && (
        <a className="block" href={`/api/v1/auth/sso/start?idp=${encodeURIComponent(sso.idpId)}`}>
          <Button type="button" variant="secondary" fullWidth tabIndex={-1}>
            Continue with {sso.name}
          </Button>
        </a>
      )}
      <FormField id="password" label="Password" required>
        {(a) => <Input {...a} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
      </FormField>
      <Button type="submit" fullWidth loading={pending}>
        Sign in
      </Button>
      <p className="text-center text-sm">
        <Link className="text-accent hover:underline" href="/forgot-password">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}

export function MfaVerifyForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch("/auth/mfa/verify", { body: { code } });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Two-step verification</h1>
      <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
      <Alert message={error} />
      <FormField id="code" label="Verification code" required>
        {(a) => <Input {...a} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />}
      </FormField>
      <Button type="submit" fullWidth loading={pending} disabled={code.length !== 6}>
        Verify
      </Button>
    </form>
  );
}

export function MfaEnrollForm({ required }: { required: boolean }) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    apiFetch<{ secret: string; otpauthUri: string }>("/auth/mfa/enroll", { method: "POST" })
      .then(setEnrollment)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await apiFetch("/auth/mfa/confirm", { body: { code } });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  if (error && !enrollment) return <ErrorState title="Could not start enrollment" message={error} />;
  if (!enrollment) return <LoadingState label="Preparing enrollment…" />;
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Set up two-step verification</h1>
      {required && <p className="text-sm text-muted">Your organization requires multi-factor authentication.</p>}
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>Open your authenticator app and add an account using this setup key (or the otpauth link).</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <CodeBlock code={enrollment.secret} />
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Show otpauth link</summary>
        <CodeBlock code={enrollment.otpauthUri} wrap />
      </details>
      <Alert message={error} />
      <FormField id="code" label="Verification code" required>
        {(a) => <Input {...a} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}
      </FormField>
      <Button type="submit" fullWidth loading={pending} disabled={code.length !== 6}>
        Turn on verification
      </Button>
    </form>
  );
}

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [info, setInfo] = useState<{ email: string; organizationName: string; userExists: boolean } | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    apiFetch<{ email: string; organizationName: string; userExists: boolean }>(`/auth/invitations/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setLoadError(errorMessage(e)));
  }, [token]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/auth/invitations/${encodeURIComponent(token)}`, { body: { name: name || info!.email, password } });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  if (loadError) return <ErrorState title="Invitation unavailable" message={loadError} />;
  if (!info) return <LoadingState label="Checking invitation…" />;
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Join {info.organizationName}</h1>
      <p className="text-sm text-muted">
        Invitation for <strong>{info.email}</strong>.{" "}
        {info.userExists ? "Enter your existing password to accept." : "Create your account to accept."}
      </p>
      <Alert message={error} />
      {!info.userExists && (
        <FormField id="name" label="Full name" required>
          {(a) => <Input {...a} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />}
        </FormField>
      )}
      <FormField id="password" label="Password" required hint={info.userExists ? undefined : "At least 12 characters. A passphrase works well."}>
        {(a) => <Input {...a} type="password" autoComplete={info.userExists ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />}
      </FormField>
      <Button type="submit" fullWidth loading={pending}>
        Accept invitation
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    await apiFetch("/auth/password/forgot", { body: { email } }).catch(() => undefined);
    setPending(false);
    setSent(true);
  }
  if (sent) return <p className="text-sm">If an account exists for {email}, a reset link has been sent. It expires in 30 minutes.</p>;
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <FormField id="email" label="Work email" required>
        {(a) => <Input {...a} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
      </FormField>
      <Button type="submit" fullWidth loading={pending}>
        Send reset link
      </Button>
    </form>
  );
}

export function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await apiFetch("/auth/password/reset", { body: { token, password } });
      router.push("/login");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <Alert message={error} />
      <FormField id="password" label="New password" required hint="At least 12 characters.">
        {(a) => <Input {...a} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
      </FormField>
      <Button type="submit" fullWidth loading={pending} disabled={!token}>
        Update password
      </Button>
    </form>
  );
}
