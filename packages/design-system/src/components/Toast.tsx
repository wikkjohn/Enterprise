"use client";

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "./Button";

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  description?: ReactNode;
  /** ms before auto-dismiss. Default 5000. Pass 0 to persist. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
  tone: ToastTone;
  title: ReactNode;
}

export interface ToastApi {
  success: (title: ReactNode, options?: ToastOptions) => number;
  error: (title: ReactNode, options?: ToastOptions) => number;
  info: (title: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>.");
  return ctx;
}

const icons = {
  success: <CheckCircle2 aria-hidden="true" className="size-4 text-success" />,
  error: <XCircle aria-hidden="true" className="size-4 text-danger" />,
  info: <Info aria-hidden="true" className="size-4 text-info" />,
} as const;

function ToastView({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const duration = toast.duration ?? 5000;

  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(t);
  }, [duration, paused, toast.id, onDismiss]);

  return (
    <li
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-border bg-surface-raised p-3 shadow-overlay"
    >
      <span className="mt-0.5 shrink-0">{icons[toast.tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-sm text-muted">{toast.description}</p>}
      </div>
      <IconButton label="Dismiss notification" size="sm" icon={<X aria-hidden="true" />} onClick={() => onDismiss(toast.id)} className="-my-1 -mr-1 size-7" />
    </li>
  );
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Max toasts visible at once. Default 4. */
  limit?: number;
}

export function ToastProvider({ children, limit = 4 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, title: ReactNode, options?: ToastOptions) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts, { id, tone, title, ...options }].slice(-limit));
      return id;
    },
    [limit],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, o) => push("success", title, o),
      error: (title, o) => push("error", title, o),
      info: (title, o) => push("info", title, o),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section aria-label="Notifications" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-end p-4 sm:bottom-2 sm:right-2 sm:left-auto">
        <ol aria-live="polite" aria-relevant="additions text" className={cn("flex w-full flex-col gap-2 sm:w-96")}>
          {toasts.map((t) => (
            <ToastView key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}
