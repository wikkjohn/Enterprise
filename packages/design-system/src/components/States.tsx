"use client";

import { type HTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, PackageOpen, RotateCw } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

/* --------------------------------------------------------------- Skeleton */

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Convenience for text lines: renders N stacked bars. */
  lines?: number;
}

export function Skeleton({ lines, className, ...rest }: SkeletonProps) {
  const bar = "rounded-md bg-surface-hover motion-safe:animate-pulse";
  if (lines && lines > 1) {
    return (
      <div aria-hidden="true" className={cn("flex flex-col gap-2", className)} {...rest}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cn(bar, "h-3.5", i === lines - 1 ? "w-3/5" : "w-full")} />
        ))}
      </div>
    );
  }
  return <div aria-hidden="true" className={cn(bar, "h-4 w-full", className)} {...rest} />;
}

/* ------------------------------------------------------------ StateLayout */

function StateFrame({
  icon,
  title,
  children,
  action,
  compact,
  className,
  role,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
  role?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-muted [&_svg]:size-5"
        >
          {icon}
        </div>
      )}
      <div className="flex max-w-md flex-col gap-1">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {children}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- EmptyState */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, description, action, compact, className }: EmptyStateProps) {
  return (
    <StateFrame icon={icon} title={title} action={action} compact={compact} className={className}>
      {description && <p className="text-sm text-muted">{description}</p>}
    </StateFrame>
  );
}

/* ------------------------------------------------------------- ErrorState */

export interface ErrorStateProps {
  title?: ReactNode;
  message?: ReactNode;
  /** Correlation id shown for support. */
  requestId?: string;
  retry?: () => void;
  retryLabel?: string;
  compact?: boolean;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  message = "The request could not be completed. Try again, or contact support if the problem persists.",
  requestId,
  retry,
  retryLabel = "Try again",
  compact,
  className,
}: ErrorStateProps) {
  return (
    <StateFrame
      role="alert"
      icon={<AlertTriangle className="text-danger" />}
      title={title}
      compact={compact}
      className={className}
      action={
        retry && (
          <Button variant="secondary" size="sm" leftIcon={<RotateCw aria-hidden="true" />} onClick={retry}>
            {retryLabel}
          </Button>
        )
      }
    >
      <p className="text-sm text-muted">{message}</p>
      {requestId && (
        <p className="mt-1 text-xs text-subtle">
          Request ID: <code className="select-all font-mono text-muted">{requestId}</code>
        </p>
      )}
    </StateFrame>
  );
}

/* ----------------------------------------------------------- LoadingState */

export interface LoadingStateProps {
  label?: string;
  compact?: boolean;
  className?: string;
}

export function LoadingState({ label = "Loading…", compact, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-2 text-sm text-muted",
        compact ? "py-8" : "py-14",
        className,
      )}
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------ NotInstalledState */

export interface NotInstalledStateProps {
  /** Module display name, e.g. "Contract Intelligence". */
  moduleName?: string;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function NotInstalledState({
  moduleName,
  title,
  description = "This module is not installed for your organization. An administrator can install it from the module catalog.",
  action,
  icon = <PackageOpen />,
  className,
}: NotInstalledStateProps) {
  return (
    <StateFrame
      icon={icon}
      title={title ?? (moduleName ? `${moduleName} is not yet installed` : "Module not yet installed")}
      action={action}
      className={cn("rounded-lg border border-dashed border-border-strong", className)}
    >
      <p className="text-sm text-muted">{description}</p>
    </StateFrame>
  );
}
