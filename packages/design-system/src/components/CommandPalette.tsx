"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "../lib/cn";
import { useFocusTrap, useScrollLock } from "../lib/useFocusTrap";
import { useHotkey } from "../lib/useHotkey";
import { Spinner } from "./Spinner";

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon?: ReactNode;
  href?: string;
  /** Extra search terms. */
  keywords?: string[];
  onSelect?: () => void;
}

export interface CommandPaletteProps {
  /** Static items, filtered locally by the query. */
  items: CommandItem[];
  /** Controlled open state. Omit both to let the palette manage itself via ⌘K / Ctrl+K. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Remote search. Called (debounced 200ms) as the query changes; returned items are
   * merged after local matches. Return [] for none.
   */
  onQueryChange?: (query: string, signal: AbortSignal) => Promise<CommandItem[]>;
  /** Called for items with an `href` (e.g. router.push). Defaults to `window.location.assign`. */
  onNavigate?: (href: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  /** Bind ⌘K / Ctrl+K. Default true. */
  hotkey?: boolean;
}

function matches(item: CommandItem, q: string): boolean {
  if (!q) return true;
  const hay = [item.label, item.group, item.hint ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((part) => hay.includes(part));
}

export function CommandPalette({
  items,
  open: openProp,
  onOpenChange,
  onQueryChange,
  onNavigate,
  placeholder = "Search or jump to…",
  emptyMessage = "No results found.",
  hotkey = true,
}: CommandPaletteProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<CommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const queryRef = useRef(onQueryChange);
  useEffect(() => {
    queryRef.current = onQueryChange;
  }, [onQueryChange]);

  useHotkey("k", () => setOpen(!open), { enabled: hotkey });
  useFocusTrap(panelRef, { active: open, onEscape: () => setOpen(false), initialFocusRef: inputRef });
  useScrollLock(open);

  // Reset when closed.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRemote([]);
      setLoading(false);
      setActiveIndex(0);
    }
  }, [open]);

  // Remote search with debounce + abort.
  useEffect(() => {
    const fn = queryRef.current;
    if (!open || !fn) return;
    const q = query.trim();
    if (!q) {
      setRemote([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fn(q, controller.signal)
        .then((res) => {
          if (!controller.signal.aborted) setRemote(res);
        })
        .catch(() => {
          if (!controller.signal.aborted) setRemote([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, open]);

  const results = useMemo(() => {
    const local = items.filter((i) => matches(i, query.trim()));
    const seen = new Set(local.map((i) => i.id));
    const all = [...local, ...remote.filter((r) => !seen.has(r.id))];
    // Group while preserving first-seen group order.
    const groups = new Map<string, CommandItem[]>();
    for (const item of all) {
      const g = groups.get(item.group);
      if (g) g.push(item);
      else groups.set(item.group, [item]);
    }
    const flat: CommandItem[] = [];
    for (const g of groups.values()) flat.push(...g);
    return { groups: Array.from(groups.entries()), flat };
  }, [items, remote, query]);

  const clampedIndex = Math.min(activeIndex, Math.max(results.flat.length - 1, 0));
  const activeItem = results.flat[clampedIndex];
  const optionId = (id: string) => `${baseId}-opt-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  const activeId = activeItem ? optionId(activeItem.id) : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const select = (item: CommandItem) => {
    setOpen(false);
    item.onSelect?.();
    if (item.href) {
      if (onNavigate) onNavigate(item.href);
      else window.location.assign(item.href);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const count = results.flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (count) setActiveIndex((clampedIndex + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count) setActiveIndex((clampedIndex - 1 + count) % count);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActiveIndex(Math.max(count - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeItem) select(activeItem);
    }
  };

  if (!open) return null;

  let flatIndex = -1;
  const showEmpty = results.flat.length === 0 && !loading;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div aria-hidden="true" className="absolute inset-0 bg-overlay" onClick={() => setOpen(false)} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative flex max-h-[min(70dvh,560px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-overlay"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search aria-hidden="true" className="size-4 shrink-0 text-subtle" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label="Search commands"
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
            className="ds-ring h-12 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle focus-visible:outline-none"
          />
          {loading && <Spinner size="sm" className="text-subtle" />}
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-subtle sm:inline">Esc</kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.groups.map(([group, groupItems]) => (
            <li key={group} role="presentation">
              <div className="px-2 pb-1 pt-2 text-xs font-medium text-subtle" aria-hidden="true">
                {group}
              </div>
              <ul role="group" aria-label={group}>
                {groupItems.map((item) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const active = index === clampedIndex;
                  return (
                    <li
                      key={item.id}
                      id={optionId(item.id)}
                      role="option"
                      aria-selected={active}
                      onMouseMove={() => {
                        if (!active) setActiveIndex(index);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => select(item)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm text-fg [&_svg]:size-4",
                        active && "bg-surface-hover",
                      )}
                    >
                      {item.icon && (
                        <span aria-hidden="true" className="flex shrink-0 text-muted">
                          {item.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint && <span className="shrink-0 text-xs text-subtle">{item.hint}</span>}
                      {active && <CornerDownLeft aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        {showEmpty && <p className="px-4 py-8 text-center text-sm text-muted">{emptyMessage}</p>}
        <div aria-live="polite" className="sr-only">
          {loading ? "Searching…" : query ? `${results.flat.length} results` : ""}
        </div>
      </div>
    </div>
  );
}
