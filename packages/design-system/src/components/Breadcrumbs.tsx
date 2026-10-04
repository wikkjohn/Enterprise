import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { type RenderLink, defaultRenderLink } from "./Link";

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page (last item). */
  href?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  renderLink?: RenderLink;
  className?: string;
}

export function Breadcrumbs({ items, renderLink = defaultRenderLink, className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <Fragment key={`${item.label}-${i}`}>
              <li className="flex min-w-0 items-center">
                {isLast || !item.href ? (
                  <span aria-current={isLast ? "page" : undefined} className={cn("truncate", isLast && "font-medium text-fg")}>
                    {item.label}
                  </span>
                ) : (
                  renderLink({
                    href: item.href,
                    className: cn("truncate rounded-sm hover:text-fg", focusRing),
                    children: item.label,
                  })
                )}
              </li>
              {!isLast && (
                <li aria-hidden="true" className="flex items-center text-subtle">
                  <ChevronRight className="size-3.5" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
