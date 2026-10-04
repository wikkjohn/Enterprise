import { cn } from "../lib/cn";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Accessible label. When omitted the spinner is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

const sizes = { sm: "size-3.5", md: "size-4", lg: "size-6" } as const;

export function Spinner({ size = "md", label, className }: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0 animate-spin", sizes[size], className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
  if (!label) return svg;
  return (
    <span role="status" className="inline-flex items-center">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
