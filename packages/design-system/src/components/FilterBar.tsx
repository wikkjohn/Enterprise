"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { Input } from "./Form";

export interface FilterBarProps {
  /** Called with the trimmed query, debounced. */
  onSearchChange?: (query: string) => void;
  /** Initial search value (uncontrolled). */
  defaultSearch?: string;
  searchPlaceholder?: string;
  /** Accessible label for the search box. */
  searchLabel?: string;
  debounceMs?: number;
  /** Filter controls (Selects, toggles, date range…). */
  children?: ReactNode;
  /** Right-aligned actions (e.g. "Create" button). */
  actions?: ReactNode;
  className?: string;
}

export function FilterBar({
  onSearchChange,
  defaultSearch = "",
  searchPlaceholder = "Search…",
  searchLabel = "Search",
  debounceMs = 250,
  children,
  actions,
  className,
}: FilterBarProps) {
  const [value, setValue] = useState(defaultSearch);
  const callbackRef = useRef(onSearchChange);
  const firstRun = useRef(true);
  useEffect(() => {
    callbackRef.current = onSearchChange;
  }, [onSearchChange]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => callbackRef.current?.(value.trim()), debounceMs);
    return () => clearTimeout(t);
  }, [value, debounceMs]);

  return (
    <div role="search" className={cn("flex flex-wrap items-center gap-2", className)}>
      {onSearchChange && (
        <div className="relative w-full sm:w-72">
          <Input
            type="search"
            size="sm"
            aria-label={searchLabel}
            placeholder={searchPlaceholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && value) {
                e.preventDefault();
                setValue("");
              }
            }}
            leftIcon={<Search />}
            className="[&_input]:pr-8 [&_input::-webkit-search-cancel-button]:appearance-none"
          />
          {value && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setValue("")}
              className={cn(
                "absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-subtle hover:text-fg",
                focusRing,
              )}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
