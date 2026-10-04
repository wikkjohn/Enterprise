import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Semantic element to render. Default "div". */
  as?: "div" | "section" | "article";
}

export function Card({ as: Tag = "div", className, ...rest }: CardProps) {
  return <Tag className={cn("min-w-0 rounded-lg border border-border bg-surface", className)} {...rest} />;
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level for the title. Default 3. */
  headingLevel?: 2 | 3 | 4;
}

export function CardHeader({ title, description, actions, headingLevel = 3, className, children, ...rest }: CardHeaderProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <div
      className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4", className)}
      {...rest}
    >
      <div className="min-w-0 flex-1">
        {title && <Heading className="text-sm font-semibold text-fg">{title}</Heading>}
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  /** Remove padding (for full-bleed tables/lists). */
  flush?: boolean;
}

export function CardBody({ flush, className, ...rest }: CardBodyProps) {
  return <div className={cn(!flush && "px-5 py-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3", className)}
      {...rest}
    />
  );
}
