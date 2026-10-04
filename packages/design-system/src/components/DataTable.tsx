"use client";

import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRingInset } from "../lib/styles";
import { Skeleton } from "./States";

export type SortDirection = "asc" | "desc";
export type SortValue = string | number | boolean | Date | null | undefined;

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  /** Value used for sorting; required for sortable columns unless `cell` returns a primitive. */
  sortValue?: (row: T) => SortValue;
  align?: "left" | "right" | "center";
  /** CSS width, e.g. "120px" or "20%". */
  width?: string;
  /** Hide below the `md` breakpoint. */
  hideOnMobile?: boolean;
}

export interface DataTableSort {
  key: string;
  direction: SortDirection;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Accessible table name (rendered as visually hidden caption). */
  caption?: string;
  onRowClick?: (row: T) => void;
  /** Accessible hint for clickable rows, e.g. row => `Open ${row.name}`. */
  rowLabel?: (row: T) => string;
  emptyState?: ReactNode;
  loading?: boolean;
  skeletonRows?: number;
  defaultSort?: DataTableSort;
  /** Controlled sort. When provided with onSortChange, rows are NOT sorted locally (server-side sort). */
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  /** Max height of the scroll area (enables sticky header within the card). */
  maxHeight?: string;
  density?: "compact" | "comfortable";
  className?: string;
}

function compare(a: SortValue, b: SortValue): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  onRowClick,
  rowLabel,
  emptyState,
  loading = false,
  skeletonRows = 5,
  defaultSort,
  sort: controlledSort,
  onSortChange,
  maxHeight,
  density = "comfortable",
  className,
}: DataTableProps<T>) {
  const [internalSort, setInternalSort] = useState<DataTableSort | null>(defaultSort ?? null);
  const isControlled = controlledSort !== undefined;
  const sort = isControlled ? controlledSort : internalSort;

  const sortedRows = useMemo(() => {
    if (!sort || (isControlled && onSortChange)) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const getValue = col.sortValue ?? ((row: T) => {
      const v = col.cell(row);
      return typeof v === "string" || typeof v === "number" ? v : null;
    });
    const dir = sort.direction === "asc" ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index, value: getValue(row) }))
      .sort((a, b) => {
        // Nulls always last regardless of direction.
        if (a.value == null || b.value == null) return compare(a.value, b.value) || a.index - b.index;
        return compare(a.value, b.value) * dir || a.index - b.index;
      })
      .map((e) => e.row);
  }, [rows, columns, sort, isControlled, onSortChange]);

  const toggleSort = (key: string) => {
    let next: DataTableSort | null;
    if (!sort || sort.key !== key) next = { key, direction: "asc" };
    else if (sort.direction === "asc") next = { key, direction: "desc" };
    else next = null;
    if (!isControlled) setInternalSort(next);
    onSortChange?.(next);
  };

  const cellPad = density === "compact" ? "px-3 py-2" : "px-4 py-3";
  const clickable = Boolean(onRowClick);

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  const showEmpty = !loading && rows.length === 0;

  return (
    <div
      className={cn("relative w-full overflow-auto", className)}
      style={maxHeight ? { maxHeight } : undefined}
      aria-busy={loading || undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sort?.key === col.key ? sort.direction : null;
              const ariaSort = col.sortable ? (active === "asc" ? "ascending" : active === "desc" ? "descending" : "none") : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    "sticky top-0 z-10 whitespace-nowrap border-b border-border bg-surface text-xs font-medium text-muted",
                    alignClass[col.align ?? "left"],
                    col.sortable ? "p-0" : cellPad,
                    col.hideOnMobile && "hidden md:table-cell",
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cn(
                        "inline-flex w-full items-center gap-1 rounded-sm hover:text-fg",
                        col.align === "right" && "flex-row-reverse",
                        col.align === "center" && "justify-center",
                        active && "text-fg",
                        cellPad,
                        focusRingInset,
                      )}
                    >
                      <span>{col.header}</span>
                      {active === "asc" ? (
                        <ArrowUp aria-hidden="true" className="size-3.5" />
                      ) : active === "desc" ? (
                        <ArrowDown aria-hidden="true" className="size-3.5" />
                      ) : (
                        <ChevronsUpDown aria-hidden="true" className="size-3.5 opacity-50" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={`skeleton-${i}`}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn("border-b border-border", cellPad, col.hideOnMobile && "hidden md:table-cell")}
                  >
                    <Skeleton className={cn("h-3.5", i % 2 ? "w-2/3" : "w-4/5", col.align === "right" && "ml-auto")} />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            sortedRows.map((row) => (
              <tr
                key={getRowId(row)}
                tabIndex={clickable ? 0 : undefined}
                aria-label={clickable && rowLabel ? rowLabel(row) : undefined}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={clickable ? (e) => onRowKeyDown(e, row) : undefined}
                className={cn(
                  "group [&:last-child>td]:border-b-0",
                  clickable && cn("cursor-pointer hover:bg-surface-hover", focusRingInset),
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "border-b border-border text-fg",
                      cellPad,
                      alignClass[col.align ?? "left"],
                      col.align === "right" && "tabular-nums",
                      col.hideOnMobile && "hidden md:table-cell",
                    )}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          {showEmpty && (
            <tr>
              <td colSpan={columns.length} className="p-0">
                {emptyState ?? <p className="px-4 py-10 text-center text-sm text-muted">No results.</p>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {loading && <span className="sr-only" role="status">Loading…</span>}
    </div>
  );
}
