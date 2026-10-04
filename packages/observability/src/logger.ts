import { currentCorrelation } from "./correlation";
import { redact } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  write(line: Record<string, unknown>): void;
}

export const stdoutSink: LogSink = {
  write(line) {
    const text = JSON.stringify(line);
    if ((line.level as string) === "error" || (line.level as string) === "warn") process.stderr.write(text + "\n");
    else process.stdout.write(text + "\n");
  },
};

export class MemorySink implements LogSink {
  readonly lines: Record<string, unknown>[] = [];
  write(line: Record<string, unknown>) {
    this.lines.push(line);
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(opts: { level?: LogLevel; sink?: LogSink; bindings?: Record<string, unknown> } = {}): Logger {
  const min = LEVELS[opts.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) ?? "info")] ?? LEVELS.info;
  const sink = opts.sink ?? stdoutSink;
  const bindings = opts.bindings ?? {};

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const corr = currentCorrelation();
    sink.write({
      ts: new Date().toISOString(),
      level,
      msg,
      ...bindings,
      ...(corr ? { correlationId: corr.correlationId, organizationId: corr.organizationId, actorId: corr.actorId } : {}),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    });
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ level: opts.level, sink, bindings: { ...bindings, ...b } }),
  };
}
