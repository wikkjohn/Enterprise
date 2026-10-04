import { type ReactNode, useId } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";
import { type RenderLink, defaultRenderLink } from "./Link";

export interface NavSectionProps {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function NavSection({ title, children, className }: NavSectionProps) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={title ? id : undefined} className={cn("flex flex-col gap-0.5", className)}>
      {title && (
        <div id={id} className="px-2.5 pb-1 pt-3 text-xs font-medium text-subtle">
          {title}
        </div>
      )}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

export interface NavItemProps {
  href: string;
  label: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  /** Trailing badge/count. */
  badge?: ReactNode;
  renderLink?: RenderLink;
  onClick?: () => void;
  className?: string;
}

export function NavItem({ href, label, icon, active = false, badge, renderLink = defaultRenderLink, onClick, className }: NavItemProps) {
  return (
    <li>
      {renderLink({
        href,
        onClick,
        "aria-current": active ? "page" : undefined,
        className: cn(
          "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0",
          active ? "bg-surface-hover font-medium text-fg" : "text-muted hover:bg-surface-hover hover:text-fg",
          focusRing,
          className,
        ),
        children: (
          <>
            {icon && (
              <span aria-hidden="true" className={cn("flex", active ? "text-accent" : "text-subtle")}>
                {icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {badge && <span className="shrink-0">{badge}</span>}
          </>
        ),
      })}
    </li>
  );
}
