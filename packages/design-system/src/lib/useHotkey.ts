"use client";

import { useEffect, useRef } from "react";

export interface HotkeyOptions {
  /** Require ⌘ on macOS / Ctrl elsewhere. Default true. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  enabled?: boolean;
  /** Fire even when focus is in an input/textarea/contenteditable. Default true when `mod` is set. */
  allowInInputs?: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Global keyboard shortcut. `useHotkey("k", open)` binds ⌘K / Ctrl+K.
 * Pass `{ mod: false }` for a bare key (ignored while typing in inputs).
 */
export function useHotkey(key: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}): void {
  const { mod = true, shift = false, alt = false, enabled = true } = options;
  const allowInInputs = options.allowInInputs ?? mod;
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      const modPressed = e.metaKey || e.ctrlKey;
      if (mod !== modPressed) return;
      if (shift !== e.shiftKey || alt !== e.altKey) return;
      if (!allowInInputs && isEditable(e.target)) return;
      e.preventDefault();
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, mod, shift, alt, enabled, allowInInputs]);
}
