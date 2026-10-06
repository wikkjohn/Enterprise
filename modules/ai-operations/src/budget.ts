/**
 * Budget periods, threshold checks and forecasts. Pure functions — every date
 * is UTC, every amount is USD.
 */

export const BUDGET_PERIODS = ["monthly", "quarterly", "annual"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export interface PeriodWindow {
  key: string;
  label: string;
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

const utc = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/**
 * The budget period containing `at`. Quarters and years follow the fiscal
 * year, which starts on the first of `fiscalStartMonth` (1–12). Fiscal years
 * are named after the calendar year they end in (FY2027 = Jul 2026–Jun 2027
 * with a July start); with a January start that is simply the calendar year.
 */
export function periodWindow(period: BudgetPeriod, at: Date, fiscalStartMonth = 1): PeriodWindow {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (period === "monthly") {
    const start = utc(y, m);
    return { key: `M:${start.toISOString().slice(0, 7)}`, label: monthLabel(start), start, end: utc(y, m + 1) };
  }
  const fs = Math.min(12, Math.max(1, fiscalStartMonth)) - 1;
  const fyStartYear = m >= fs ? y : y - 1;
  const fyStart = utc(fyStartYear, fs);
  const fyName = fs === 0 ? fyStartYear : fyStartYear + 1;
  if (period === "annual") {
    return { key: `Y:${fyStart.toISOString().slice(0, 7)}`, label: `FY${fyName}`, start: fyStart, end: utc(fyStartYear + 1, fs) };
  }
  const monthsIn = (m - fs + 12) % 12;
  const q = Math.floor(monthsIn / 3);
  const start = utc(fyStartYear, fs + q * 3);
  return { key: `Q:${start.toISOString().slice(0, 7)}`, label: `Q${q + 1} FY${fyName}`, start, end: utc(fyStartYear, fs + q * 3 + 3) };
}

const DAY = 86_400_000;

/** Straight-line projection of period spend from spend so far. */
export function runRateForecast(spent: number, w: Pick<PeriodWindow, "start" | "end">, now: Date): number {
  const total = (w.end.getTime() - w.start.getTime()) / DAY;
  const elapsed = Math.min(total, Math.max(0, (now.getTime() - w.start.getTime()) / DAY));
  if (elapsed < 1) return round2(spent);
  return round2((spent / elapsed) * total);
}

export interface BudgetStatus {
  amount: number;
  spent: number;
  remaining: number;
  pctSpent: number;
  projected: number;
  projectedPct: number;
  /** Alert thresholds (percent of budget) already reached by actual spend. */
  crossed: number[];
  status: "ok" | "at_risk" | "warning" | "exceeded";
}

/**
 * ok        — below every threshold and the run-rate stays within budget
 * at_risk   — below the thresholds, but the run-rate projects an overrun
 * warning   — a threshold below 100 % has been reached
 * exceeded  — spend has reached 100 % of the budget
 */
export function budgetStatus(input: { amount: number; spent: number; projected: number; thresholds: number[] }): BudgetStatus {
  const { amount, spent, projected } = input;
  const pct = amount > 0 ? (spent / amount) * 100 : spent > 0 ? Infinity : 0;
  const projectedPct = amount > 0 ? (projected / amount) * 100 : projected > 0 ? Infinity : 0;
  const thresholds = [...new Set(input.thresholds)].filter((t) => t > 0).sort((a, b) => a - b);
  const crossed = thresholds.filter((t) => pct >= t);
  const status = pct >= 100 ? "exceeded" : crossed.length ? "warning" : projectedPct > 100 ? "at_risk" : "ok";
  return { amount, spent: round2(spent), remaining: round2(amount - spent), pctSpent: round1(pct), projected: round2(projected), projectedPct: round1(projectedPct), crossed, status };
}

export interface TrendForecast {
  method: "linear_trend" | "average";
  values: number[];
  low: number[];
  high: number[];
  /** Explanation shown next to the numbers. */
  note: string;
}

/**
 * Forecast the next `ahead` months from monthly history (oldest first) by an
 * ordinary least-squares line. With fewer than three months of history it
 * falls back to the average. The band is ±1.28 residual standard deviations
 * (roughly an 80 % interval if residuals are normal) and never goes below 0.
 */
export function trendForecast(history: number[], ahead: number): TrendForecast {
  const h = history.map((v) => (Number.isFinite(v) ? v : 0));
  if (h.length < 3) {
    const avg = h.length ? h.reduce((a, b) => a + b, 0) / h.length : 0;
    const values = Array.from({ length: ahead }, () => round2(avg));
    return { method: "average", values, low: values.map((v) => round2(v * 0.8)), high: values.map((v) => round2(v * 1.2)), note: `Average of ${h.length} month(s); too little history for a trend (±20 % band).` };
  }
  const n = h.length;
  const xm = (n - 1) / 2;
  const ym = h.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - xm) * (h[i]! - ym);
    sxx += (i - xm) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = ym - slope * xm;
  const resid = Math.sqrt(h.reduce((a, y, i) => a + (y - (intercept + slope * i)) ** 2, 0) / Math.max(1, n - 2));
  const values: number[] = [];
  const low: number[] = [];
  const high: number[] = [];
  for (let k = 0; k < ahead; k++) {
    const v = Math.max(0, intercept + slope * (n + k));
    values.push(round2(v));
    low.push(round2(Math.max(0, v - 1.28 * resid)));
    high.push(round2(v + 1.28 * resid));
  }
  return { method: "linear_trend", values, low, high, note: `Linear trend over ${n} months (${slope >= 0 ? "+" : ""}${round2(slope)} USD per month); band is ±1.28 × residual spread.` };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Split `amount` across keys proportionally to non-negative weights, to the cent, summing exactly (largest remainder). */
export function allocate(amount: number, weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights).filter(([, w]) => Number.isFinite(w) && w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (!entries.length || total <= 0) return {};
  const cents = Math.round(amount * 100);
  const raw = entries.map(([k, w]) => ({ k, exact: (cents * w) / total }));
  const out = raw.map((r) => ({ k: r.k, c: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let left = cents - out.reduce((a, r) => a + r.c, 0);
  for (const r of [...out].sort((a, b) => b.frac - a.frac || a.k.localeCompare(b.k))) {
    if (left <= 0) break;
    r.c += 1;
    left -= 1;
  }
  return Object.fromEntries(out.map((r) => [r.k, r.c / 100]));
}
