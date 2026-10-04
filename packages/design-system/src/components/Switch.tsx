"use client";

import { type ButtonHTMLAttributes, type ReactNode, type Ref, useId } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Visible label. If omitted, pass `aria-label`. */
  label?: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md";
  ref?: Ref<HTMLButtonElement>;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  size = "md",
  disabled,
  id,
  className,
  ref,
  ...rest
}: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const track = size === "sm" ? "h-4 w-7" : "h-5 w-9";
  const thumb = size === "sm" ? "size-3" : "size-4";
  const shift = size === "sm" ? "translate-x-3" : "translate-x-4";

  const control = (
    <button
      ref={ref}
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? `${switchId}-label` : undefined}
      aria-describedby={description ? `${switchId}-desc` : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent p-px transition-colors motion-reduce:transition-none",
        "disabled:cursor-not-allowed disabled:opacity-55",
        checked ? "bg-accent" : "bg-border-strong",
        track,
        focusRing,
        !label && className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block rounded-full bg-surface shadow-sm transition-transform motion-reduce:transition-none",
          thumb,
          checked ? shift : "translate-x-0",
        )}
      />
    </button>
  );
  if (!label) return control;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="flex flex-col gap-0.5">
        <label id={`${switchId}-label`} htmlFor={switchId} className="cursor-pointer text-sm font-medium text-fg">
          {label}
        </label>
        {description && (
          <span id={`${switchId}-desc`} className="text-xs text-muted">
            {description}
          </span>
        )}
      </div>
      {control}
    </div>
  );
}
