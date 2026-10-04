"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button, ConfirmDialog, useToast, type ButtonProps } from "@eaop/design-system";
import { ApiError, apiFetch } from "@/lib/client";

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = (e.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues;
    return issues?.length ? `${e.message} ${issues.map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ")}` : e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** Run a mutation, toast the outcome, refresh server data. */
export function useMutation() {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  async function run<T>(fn: () => Promise<T>, opts: { success?: string; refresh?: boolean } = {}): Promise<T | undefined> {
    setPending(true);
    try {
      const out = await fn();
      if (opts.success) toast.success(opts.success);
      if (opts.refresh !== false) router.refresh();
      return out;
    } catch (e) {
      toast.error("Action failed", { description: errorMessage(e) });
      return undefined;
    } finally {
      setPending(false);
    }
  }
  return { run, pending };
}

/** A button that calls an API endpoint, optionally behind a confirmation dialog. */
export function ActionButton({
  path,
  method = "POST",
  body,
  success,
  confirm,
  children,
  ...button
}: {
  path: string;
  method?: string;
  body?: unknown;
  success?: string;
  confirm?: { title: string; message: ReactNode; confirmLabel?: string; tone?: "danger" | "default"; requireText?: string };
  children: ReactNode;
} & Omit<ButtonProps, "onClick" | "children">) {
  const { run, pending } = useMutation();
  const [open, setOpen] = useState(false);
  const go = () => run(() => apiFetch(path, { method, body }), { success });
  return (
    <>
      <Button {...button} loading={pending} onClick={() => (confirm ? setOpen(true) : void go())}>
        {children}
      </Button>
      {confirm && (
        <ConfirmDialog
          open={open}
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel ?? "Confirm"}
          tone={confirm.tone ?? "danger"}
          requireText={confirm.requireText}
          onCancel={() => setOpen(false)}
          onConfirm={async () => {
            await go();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
