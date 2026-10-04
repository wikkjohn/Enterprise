"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { type RenderLink, defaultRenderLink } from "./Link";

export interface TabItem {
  value: string;
  label: ReactNode;
  /**
   * Render as a link (route-based tabs). When any item has an href the whole list renders
   * as a `nav` of links with aria-current="page" (correct semantics for navigation);
   * panels are then rendered by the route, not `TabPanel`.
   */
  href?: string;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange?: (value: string) => void;
  /** Accessible label for the tab list. */
  ariaLabel: string;
  renderLink?: RenderLink;
  /** Stable id prefix used to link tabs and panels (pass the same to TabPanel). */
  idPrefix?: string;
  className?: string;
}

export function tabIds(prefix: string, value: string) {
  const v = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return { tab: `${prefix}-tab-${v}`, panel: `${prefix}-panel-${v}` };
}

export function Tabs({ items, value, onChange, ariaLabel, renderLink = defaultRenderLink, idPrefix, className }: TabsProps) {
  const autoId = useId();
  const prefix = idPrefix ?? autoId;
  const listRef = useRef<HTMLDivElement>(null);
  const isLinkTabs = items.some((i) => i.href);

  const selector = isLinkTabs ? "[data-tab-link] > a" : '[role="tab"]:not([aria-disabled="true"])';

  const focusTab = (index: number) => {
    const tabs = listRef.current?.querySelectorAll<HTMLElement>(selector);
    if (!tabs?.length) return;
    const el = tabs[(index + tabs.length) % tabs.length];
    el?.focus();
    if (!isLinkTabs && el?.dataset.value) onChange?.(el.dataset.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(listRef.current?.querySelectorAll<HTMLElement>(selector) ?? []);
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    if (e.key === "ArrowRight") focusTab(current + 1);
    else if (e.key === "ArrowLeft") focusTab(current - 1);
    else if (e.key === "Home") focusTab(0);
    else if (e.key === "End") focusTab(tabs.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={listRef}
      // Route tabs are links in a <nav> (aria-current="page"); button tabs use the ARIA tabs pattern.
      role={isLinkTabs ? "navigation" : "tablist"}
      aria-label={ariaLabel}
      aria-orientation={isLinkTabs ? undefined : "horizontal"}
      onKeyDown={onKeyDown}
      className={cn("-mb-px flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]", className)}
    >
      {items.map((item) => {
        const selected = item.value === value;
        const ids = tabIds(prefix, item.value);
        const cls = cn(
          "relative inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md px-3 text-sm font-medium transition-colors motion-reduce:transition-none",
          "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
          selected ? "text-fg after:bg-accent" : "text-muted hover:text-fg after:bg-transparent",
          item.disabled && "pointer-events-none opacity-50",
          focusRing,
        );
        const content = (
          <>
            {item.label}
            {item.badge}
          </>
        );
        if (isLinkTabs) {
          return (
            <span key={item.value} data-tab-link="" className="contents">
              {item.href && !item.disabled ? (
                renderLink({
                  href: item.href,
                  className: cls,
                  children: content,
                  "aria-current": selected ? "page" : undefined,
                })
              ) : (
                <span aria-disabled="true" className={cls}>
                  {content}
                </span>
              )}
            </span>
          );
        }
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={selected}
            aria-controls={ids.panel}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            data-value={item.value}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange?.(item.value)}
            className={cls}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  value: string;
  /** Currently selected value; the panel renders only when it matches. */
  selected: string;
  idPrefix: string;
  children: ReactNode;
  className?: string;
}

/** Panel for button tabs. Use the same `idPrefix` on `Tabs`. */
export function TabPanel({ value, selected, idPrefix, children, className }: TabPanelProps) {
  if (value !== selected) return null;
  const ids = tabIds(idPrefix, value);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} className={cn("pt-4 outline-none", className)}>
      {children}
    </div>
  );
}
