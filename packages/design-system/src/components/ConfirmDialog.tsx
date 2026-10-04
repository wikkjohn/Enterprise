"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Form";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  /** User must type this exact phrase before confirm is enabled (destructive / emergency actions). */
  requireText?: string;
  /** May return a promise; the dialog shows a loading state until it settles. Throwing keeps the dialog open. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Extra content rendered below the message (e.g. a list of affected resources). */
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  requireText,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const inputId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setPending(false);
    }
  }, [open]);

  const canConfirm = !pending && (!requireText || typed === requireText);

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  const handleCancel = () => {
    if (!pending) onCancel();
  };

  return (
    <Modal
      open={open}
      onClose={handleCancel}
      title={title}
      description={message}
      size="sm"
      alert
      closeOnBackdrop={!pending}
      hideCloseButton
      initialFocusRef={requireText ? inputRef : cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={handleCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => void handleConfirm()}
            disabled={!canConfirm && !pending}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 empty:hidden">
        {children}
        {requireText && (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
          >
            <label htmlFor={inputId} className="text-sm text-fg">
              Type <span className="select-all rounded bg-surface-hover px-1 py-0.5 font-mono text-[13px] font-medium">{requireText}</span> to confirm
            </label>
            <Input
              ref={inputRef}
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={pending}
            />
          </form>
        )}
      </div>
    </Modal>
  );
}
