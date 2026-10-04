"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "./Button";

export interface CodeBlockProps {
  code: string;
  /** Shown as a small header label, e.g. "bash" or "JSON". */
  language?: string;
  /** Hide the copy button. */
  noCopy?: boolean;
  /** Wrap long lines instead of horizontal scroll. */
  wrap?: boolean;
  maxHeight?: string;
  className?: string;
}

export function CodeBlock({ code, language, noCopy, wrap, maxHeight, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={cn("group relative min-w-0 rounded-lg border border-border bg-surface-hover", className)}>
      {language && (
        <div className="border-b border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-subtle">{language}</div>
      )}
      <pre
        tabIndex={0}
        className={cn(
          "ds-ring m-0 overflow-auto rounded-lg p-3 pr-12 font-mono text-[13px] leading-relaxed text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <code>{code}</code>
      </pre>
      {!noCopy && (
        <IconButton
          label={copied ? "Copied" : "Copy to clipboard"}
          size="sm"
          icon={copied ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
          onClick={() => void copy()}
          className={cn("absolute right-1.5 bg-surface", language ? "top-9" : "top-1.5")}
        />
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
