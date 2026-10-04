import { type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  /** Columns on wide screens. Default 1 (label | value rows). */
  columns?: 1 | 2;
  className?: string;
}

export function KeyValueList({ items, columns = 1, className }: KeyValueListProps) {
  return (
    <dl className={cn("grid gap-x-8", columns === 2 ? "md:grid-cols-2" : "grid-cols-1", className)}>
      {items.map((item) => (
        <div
          key={item.key}
          className="grid grid-cols-1 gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(120px,1fr)_2fr] sm:gap-4"
        >
          <dt className="text-sm text-muted">{item.label}</dt>
          <dd className="m-0 min-w-0 break-words text-sm text-fg">{item.value ?? <span className="text-subtle">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
