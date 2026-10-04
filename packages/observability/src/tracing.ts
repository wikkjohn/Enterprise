import { randomBytes } from "node:crypto";
import { type Logger } from "./logger";
import { type Metrics } from "./metrics";

/**
 * Tracing-ready span helper. Records duration as a histogram metric and a
 * debug log line. The interface intentionally mirrors OpenTelemetry's
 * `startActiveSpan` so an OTel tracer can be dropped in behind `Tracer`.
 */
export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  setAttribute(key: string, value: string | number | boolean): void;
  recordError(err: unknown): void;
}

export interface Tracer {
  span<T>(name: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, string | number | boolean>): Promise<T>;
}

export function createTracer(deps: { logger: Logger; metrics: Metrics }): Tracer {
  return {
    async span(name, fn, attributes = {}) {
      const attrs: Record<string, string | number | boolean> = { ...attributes };
      let error: unknown;
      const span: Span = {
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        name,
        setAttribute: (k, v) => {
          attrs[k] = v;
        },
        recordError: (e) => {
          error = e;
        },
      };
      const started = performance.now();
      try {
        return await fn(span);
      } catch (e) {
        error = e;
        throw e;
      } finally {
        const ms = performance.now() - started;
        const outcome = error ? "error" : "ok";
        deps.metrics.observe("eaop_span_duration_ms", ms, { span: name, outcome });
        deps.logger.debug("span", { span: name, durationMs: Math.round(ms), outcome, ...attrs });
      }
    },
  };
}
