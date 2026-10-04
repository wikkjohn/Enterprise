"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { focusRingInset } from "../lib/styles";

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Keyboard shortcut hint (display only). */
  shortcut?: string;
  onSelect?: () => void;
  href?: string;
  tone?: "default" | "danger";
  disabled?: boolean;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
}

export interface MenuTriggerProps {
  ref: (el: HTMLButtonElement | null) => void;
  id: string;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface DropdownMenuProps {
  /** Render the trigger button; spread the provided props onto a <button> (or Button/IconButton). */
  trigger: (props: MenuTriggerProps) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  /** Accessible label for the menu (defaults to being labelled by the trigger). */
  ariaLabel?: string;
  className?: string;
}

export function DropdownMenu({ trigger, items, align = "end", ariaLabel, className }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const openMenu = (focus: "first" | "last") => {
    setOpen(true);
    setActive(focus === "first" ? (enabled[0] ?? -1) : (enabled[enabled.length - 1] ?? -1));
  };

  const close = (restoreFocus = true) => {
    setOpen(false);
    setActive(-1);
    if (restoreFocus) triggerRef.current?.focus();
  };

  // Focus active item.
  useEffect(() => {
    if (!open || active < 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  // Click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActive(-1);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const move = (dir: 1 | -1) => {
    if (!enabled.length) return;
    const pos = enabled.indexOf(active);
    const next = enabled[(pos + dir + enabled.length) % enabled.length];
    if (next !== undefined) setActive(next);
  };

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    close(!item.href);
    item.onSelect?.();
    if (item.href) window.location.assign(item.href);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(enabled[0] ?? -1);
        break;
      case "End":
        e.preventDefault();
        setActive(enabled[enabled.length - 1] ?? -1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        setOpen(false);
        setActive(-1);
        break;
      default:
        // Typeahead: jump to next item starting with the typed character.
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const ch = e.key.toLowerCase();
          const start = enabled.indexOf(active);
          for (let k = 1; k <= enabled.length; k++) {
            const idx = enabled[(start + k) % enabled.length];
            if (idx === undefined) continue;
            const el = menuRef.current?.querySelector<HTMLElement>(`[data-index="${idx}"]`);
            if (el?.textContent?.trim().toLowerCase().startsWith(ch)) {
              setActive(idx);
              break;
            }
          }
        }
    }
  };

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      {trigger({
        ref: (el) => {
          triggerRef.current = el;
        },
        id: triggerId,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
        onClick: () => (open ? close() : openMenu("first")),
        onKeyDown: (e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu("first");
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openMenu("last");
          }
        },
      })}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : triggerId}
          aria-orientation="vertical"
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute top-full z-40 mt-1 min-w-48 rounded-lg border border-border bg-surface-raised p-1 shadow-overlay",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, i) => (
            <div key={item.id} role="none">
              {item.separatorBefore && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
              <div
                role="menuitem"
                data-index={i}
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                onClick={() => choose(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(item);
                  }
                }}
                onMouseMove={() => {
                  if (!item.disabled && active !== i) setActive(i);
                }}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none [&_svg]:size-4 [&_svg]:shrink-0",
                  item.tone === "danger" ? "text-danger" : "text-fg",
                  "focus:bg-surface-hover",
                  item.disabled && "cursor-not-allowed opacity-50",
                  focusRingInset,
                )}
              >
                {item.icon && (
                  <span aria-hidden="true" className={cn("flex", item.tone === "danger" ? "text-danger" : "text-subtle")}>
                    {item.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.shortcut && <kbd className="font-sans text-xs text-subtle">{item.shortcut}</kbd>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Alias for consumers who prefer the shorter name. */
export const Menu = DropdownMenu;
export type MenuProps = DropdownMenuProps;
