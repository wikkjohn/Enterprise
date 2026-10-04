import {
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";
import { controlBase } from "../lib/styles";

/* ------------------------------------------------------------------ Label */

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  ref?: Ref<HTMLLabelElement>;
}

export function Label({ required, className, children, ref, ...rest }: LabelProps) {
  return (
    <label ref={ref} className={cn("text-sm font-medium text-fg", className)} {...rest}>
      {children}
      {required && (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );
}

/* -------------------------------------------------------------- fieldA11y */

export interface FieldA11yOptions {
  hint?: ReactNode;
  error?: ReactNode;
}

export interface FieldA11yProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/** Aria props for a control rendered inside `FormField` with the same id/hint/error. */
export function fieldA11y(id: string, { hint, error }: FieldA11yOptions = {}): FieldA11yProps {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    id,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
  };
}

/* -------------------------------------------------------------- FormField */

export interface FormFieldProps {
  /** Id of the control; hint/error get `${id}-hint` / `${id}-error`. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Control element, or a render function receiving the aria props to spread. */
  children: ReactNode | ((a11y: FieldA11yProps) => ReactNode);
  className?: string;
}

export function FormField({ id, label, hint, error, required, children, className }: FormFieldProps) {
  const a11y = fieldA11y(id, { hint, error });
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {typeof children === "function" ? children(a11y) : children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Input */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  /** Decorative icon rendered inside the left edge. */
  leftIcon?: ReactNode;
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ size = "md", leftIcon, invalid, className, ref, ...rest }: InputProps) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || rest["aria-invalid"] || undefined}
      className={cn(
        controlBase,
        size === "sm" ? "h-8 px-2.5" : "h-9 px-3",
        leftIcon ? (size === "sm" ? "pl-8" : "pl-9") : null,
        !leftIcon && className,
      )}
      {...rest}
    />
  );
  if (!leftIcon) return input;
  return (
    <div className={cn("relative", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 flex items-center text-subtle [&_svg]:size-4",
          size === "sm" ? "pl-2.5" : "pl-3",
        )}
      >
        {leftIcon}
      </span>
      {input}
    </div>
  );
}

/* --------------------------------------------------------------- Textarea */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ invalid, className, rows = 4, ref, ...rest }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || rest["aria-invalid"] || undefined}
      className={cn(controlBase, "min-h-20 resize-y px-3 py-2 leading-relaxed", className)}
      {...rest}
    />
  );
}

/* ----------------------------------------------------------------- Select */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md";
  /** Convenience: render options from data. `children` <option>s are also supported. */
  options?: SelectOption[];
  placeholder?: string;
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ size = "md", options, placeholder, invalid, className, children, ref, ...rest }: SelectProps) {
  return (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        aria-invalid={invalid || rest["aria-invalid"] || undefined}
        className={cn(controlBase, "appearance-none pr-8", size === "sm" ? "h-8 pl-2.5" : "h-9 pl-3")}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
      />
    </div>
  );
}
