import { platformErrors, type Database } from "@eaop/db";
import { redactString, type Logger } from "@eaop/observability";
import { isAppError } from "@eaop/shared-types";

/**
 * Error reporter: structured log + persisted record for the health page.
 * Plug an external sink (Sentry, Datadog) via `sinks`.
 */
export interface ErrorReporter {
  report(err: unknown, meta: { source: string; severity?: "warning" | "error" | "critical"; organizationId?: string | null; correlationId?: string; extra?: Record<string, unknown> }): Promise<void>;
}

export type ErrorSink = (err: unknown, meta: Record<string, unknown>) => void;

export function createErrorReporter(deps: { db: Database; logger: Logger; sinks?: ErrorSink[] }): ErrorReporter {
  return {
    async report(err, meta) {
      const severity = meta.severity ?? "error";
      const code = isAppError(err) ? err.code : err instanceof Error ? err.name : "UNKNOWN";
      const message = redactString(err instanceof Error ? err.message : String(err)).slice(0, 2000);
      deps.logger.error("error.reported", { source: meta.source, severity, code, message, stack: err instanceof Error ? err.stack?.split("\n").slice(0, 8).join("\n") : undefined });
      for (const sink of deps.sinks ?? []) {
        try {
          sink(err, meta);
        } catch {
          // a broken sink must never break the request
        }
      }
      try {
        await deps.db.withSystem("errors.report", (tx) =>
          tx.insert(platformErrors).values({ organizationId: meta.organizationId ?? null, severity, source: meta.source, code, message, correlationId: meta.correlationId ?? null, metadata: meta.extra ?? {} }),
        );
      } catch (e) {
        deps.logger.error("error.persist_failed", { error: (e as Error).message });
      }
    },
  };
}
