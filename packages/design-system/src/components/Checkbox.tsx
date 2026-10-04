"use client";

import { type InputHTMLAttributes, type ReactNode, type Ref, useEffect, useId, useRef } from "react";
import { cn } from "../lib/cn";
import { focusRing } from "../lib/styles";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Checkbox({ label, description, indeterminate = false, id, className, ref, ...rest }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const innerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const setRef = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };

  const box = (
    <input
      ref={setRef}
      id={inputId}
      type="checkbox"
      aria-describedby={description ? `${inputId}-desc` : rest["aria-describedby"]}
      className={cn(
        "mt-0.5 size-4 shrink-0 cursor-pointer rounded-[4px] border-border-strong accent-accent disabled:cursor-not-allowed disabled:opacity-60",
        focusRing,
        !label && className,
      )}
      {...rest}
    />
  );
  if (!label) return box;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      {box}
      <div className="flex flex-col gap-0.5">
        <label htmlFor={inputId} className="cursor-pointer text-sm font-medium text-fg">
          {label}
        </label>
        {description && (
          <p id={`${inputId}-desc`} className="text-xs text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
