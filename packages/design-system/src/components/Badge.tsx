import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-hover text-muted border-border",
  accent: "bg-accent-subtle text-accent border-transparent",
  success: "bg-success-subtle text-success border-transparent",
  warning: "bg-warning-subtle text-warning border-transparent",
  danger: "bg-danger-subtle text-danger border-transparent",
  info: "bg-info-subtle text-info border-transparent",
};

const dotClasses: Record<Tone, string> = {
  neutral: "bg-subtle",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading status dot. */
  dot?: boolean;
  icon?: ReactNode;
}

export function Badge({ tone = "neutral", dot, icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 text-xs font-medium leading-none [&_svg]:size-3",
        toneClasses[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dotClasses[tone])} />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface StatusDotProps {
  tone?: Tone;
  /** Accessible label; when omitted the dot is decorative. */
  label?: string;
  className?: string;
}

export function StatusDot({ tone = "neutral", label, className }: StatusDotProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-2 shrink-0 rounded-full", dotClasses[tone], className)}
    />
  );
}

/* ------------------------------------------------------------ StatusBadge */

export const STATUS_MAP = {
  healthy: { tone: "success", label: "Healthy" },
  degraded: { tone: "warning", label: "Degraded" },
  unhealthy: { tone: "danger", label: "Unhealthy" },
  unknown: { tone: "neutral", label: "Unknown" },
  not_configured: { tone: "neutral", label: "Not configured" },
  active: { tone: "success", label: "Active" },
  inactive: { tone: "neutral", label: "Inactive" },
  suspended: { tone: "warning", label: "Suspended" },
  draft: { tone: "neutral", label: "Draft" },
  published: { tone: "accent", label: "Published" },
  archived: { tone: "neutral", label: "Archived" },
  connected: { tone: "success", label: "Connected" },
  disconnected: { tone: "neutral", label: "Disconnected" },
  failed: { tone: "danger", label: "Failed" },
  error: { tone: "danger", label: "Error" },
  disabled: { tone: "neutral", label: "Disabled" },
  enabled: { tone: "success", label: "Enabled" },
  installed: { tone: "success", label: "Installed" },
  not_installed: { tone: "neutral", label: "Not installed" },
  pending: { tone: "info", label: "Pending" },
  queued: { tone: "info", label: "Queued" },
  running: { tone: "accent", label: "Running" },
  in_progress: { tone: "accent", label: "In progress" },
  succeeded: { tone: "success", label: "Succeeded" },
  completed: { tone: "success", label: "Completed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  blocked: { tone: "danger", label: "Blocked" },
  dead: { tone: "danger", label: "Dead" },
  expired: { tone: "warning", label: "Expired" },
  revoked: { tone: "danger", label: "Revoked" },
  invited: { tone: "info", label: "Invited" },
} as const satisfies Record<string, { tone: Tone; label: string }>;

export type KnownStatus = keyof typeof STATUS_MAP;

function humanize(status: string): string {
  const s = status.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "Unknown";
}

/** Resolve tone + readable label for any status string (unknown values fall back to neutral). */
export function statusMeta(status: string): { tone: Tone; label: string } {
  const key = status.toLowerCase() as KnownStatus;
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, key) ? STATUS_MAP[key] : { tone: "neutral", label: humanize(status) };
}

export interface StatusBadgeProps extends Omit<BadgeProps, "tone" | "children"> {
  status: KnownStatus | (string & {});
  /** Override the label. */
  label?: ReactNode;
  /** Override the tone. */
  tone?: Tone;
}

export function StatusBadge({ status, label, tone, dot = true, ...rest }: StatusBadgeProps) {
  const meta = statusMeta(status);
  return (
    <Badge tone={tone ?? meta.tone} dot={dot} {...rest}>
      {label ?? meta.label}
    </Badge>
  );
}
