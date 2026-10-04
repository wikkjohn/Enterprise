/**
 * Rate limiting abstraction. The in-memory implementation is correct for a
 * single instance; multi-instance deployments plug in a Redis-backed limiter
 * implementing the same interface (see docs/SECURITY.md).
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until a token becomes available. */
  retryAfterSeconds: number;
  limit: number;
}

export interface RateLimiter {
  consume(key: string, rule: RateLimitRule, cost?: number): Promise<RateLimitResult>;
}

export interface RateLimitRule {
  /** Sustained requests per window. */
  limit: number;
  windowSeconds: number;
}

/** Token bucket: capacity = limit, refill = limit / window. */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 100_000) {}

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitResult> {
    const t = this.now();
    const rate = rule.limit / (rule.windowSeconds * 1000);
    const b = this.buckets.get(key) ?? { tokens: rule.limit, updated: t };
    b.tokens = Math.min(rule.limit, b.tokens + (t - b.updated) * rate);
    b.updated = t;
    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;
    if (this.buckets.size >= this.maxKeys && !this.buckets.has(key)) {
      const first = this.buckets.keys().next().value;
      if (first !== undefined) this.buckets.delete(first);
    }
    this.buckets.set(key, b);
    return {
      allowed,
      remaining: Math.max(0, Math.floor(b.tokens)),
      retryAfterSeconds: allowed ? 0 : Math.ceil((cost - b.tokens) / rate / 1000),
      limit: rule.limit,
    };
  }
}

export const RATE_LIMITS = {
  /** Per-IP login attempts. */
  login: { limit: 10, windowSeconds: 300 },
  /** Per-actor general API traffic. */
  api: { limit: 600, windowSeconds: 60 },
  /** Per-actor AI calls. */
  ai: { limit: 60, windowSeconds: 60 },
  /** Per-connector outbound calls (default when the connector declares none). */
  connector: { limit: 120, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;
