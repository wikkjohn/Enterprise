"use client";

import { type ReactNode, type RefObject, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { useFocusTrap, useScrollLock } from "../lib/useFocusTrap";
import { IconButton } from "./Button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Close when the backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Hide the × button (e.g. while an action is pending). */
  hideCloseButton?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Use role="alertdialog" (for confirmations). */
  alert?: boolean;
  className?: string;
}

const sizes = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl" } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  closeOnEscape = true,
  hideCloseButton = false,
  initialFocusRef,
  alert = false,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panelRef, { active: open, onEscape: closeOnEscape ? onClose : undefined, initialFocusRef });
  useScrollLock(open);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-overlay"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[min(90dvh,100%)] w-full flex-col overflow-hidden rounded-t-lg border border-border bg-surface-raised shadow-overlay outline-none sm:rounded-lg",
          sizes[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              {title}
            </h2>
            {description && (
              <div id={descId} className="mt-1 text-sm text-muted">
                {description}
              </div>
            )}
          </div>
          {!hideCloseButton && (
            <IconButton label="Close" size="sm" icon={<X aria-hidden="true" />} onClick={onClose} className="-mr-1.5 -mt-1" />
          )}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 text-sm text-fg">{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
