"use client";

import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { useFocusTrap, useScrollLock } from "../lib/useFocusTrap";
import { IconButton } from "./Button";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

const widths = { md: "sm:max-w-md", lg: "sm:max-w-2xl" } as const;
const TRANSITION_MS = 200;

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "md",
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // `mounted` keeps the panel in the DOM during the exit transition; `shown` drives the transform.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setMounted(false), reduce ? 0 : TRANSITION_MS);
    return () => clearTimeout(t);
  }, [open]);

  useFocusTrap(panelRef, { active: open && mounted, onEscape: closeOnEscape ? onClose : undefined, initialFocusRef });
  useScrollLock(open);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 bg-overlay transition-opacity duration-200 motion-reduce:transition-none",
          shown ? "opacity-100" : "opacity-0",
        )}
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-surface-raised shadow-overlay outline-none",
          "transition-transform duration-200 ease-out motion-reduce:transition-none",
          shown ? "translate-x-0" : "translate-x-full",
          widths[width],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" size="sm" icon={<X aria-hidden="true" />} onClick={onClose} className="-mr-1.5" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-fg">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
