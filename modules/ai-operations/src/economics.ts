import { round2 } from "./budget";

/**
 * Adoption aggregation and unit economics.
 *
 * Privacy: adoption is reported for groups only. A group smaller than
 * MIN_GROUP_SIZE people is suppressed (its numbers are withheld), so the
 * module cannot be used to watch individuals. Nothing here ranks people.
 */

export const MIN_GROUP_SIZE = 5;

export interface DepartmentAdoptionInput {
  department: string;
  members: number;
  licensed: number;
  active: number;
  aiRuns: number;
  trainingRequired: number;
  trainingCompleted: number;
}

export interface DepartmentAdoption {
  department: string;
  suppressed: boolean;
  members: number | null;
  licensed: number | null;
  active: number | null;
  activePct: number | null;
  aiRunsPerActiveUser: number | null;
  trainingCompletionPct: number | null;
}

export function departmentAdoption(rows: DepartmentAdoptionInput[], minGroup = MIN_GROUP_SIZE): DepartmentAdoption[] {
  return rows.map((r) => {
    if (r.members < minGroup) return { department: r.department, suppressed: true, members: null, licensed: null, active: null, activePct: null, aiRunsPerActiveUser: null, trainingCompletionPct: null };
    return {
      department: r.department, suppressed: false, members: r.members, licensed: r.licensed, active: r.active,
      activePct: r.members ? Math.round((r.active / r.members) * 100) : 0,
      aiRunsPerActiveUser: r.active ? Math.round((r.aiRuns / r.active) * 10) / 10 : 0,
      trainingCompletionPct: r.trainingRequired ? Math.round((r.trainingCompleted / r.trainingRequired) * 100) : null,
    };
  }).sort((a, b) => Number(a.suppressed) - Number(b.suppressed) || (b.activePct ?? 0) - (a.activePct ?? 0) || a.department.localeCompare(b.department));
}

export interface CostByBasis { measured: number; estimated: number; allocated: number }
export const emptyCost = (): CostByBasis => ({ measured: 0, estimated: 0, allocated: 0 });
export const addCost = (a: CostByBasis, b: Partial<CostByBasis>): CostByBasis => ({ measured: a.measured + (b.measured ?? 0), estimated: a.estimated + (b.estimated ?? 0), allocated: a.allocated + (b.allocated ?? 0) });
export const totalCost = (c: CostByBasis) => c.measured + c.estimated + c.allocated;

export interface UnitMetric {
  key: string;
  label: string;
  /** What one unit is, e.g. "active user per month". */
  unit: string;
  denominator: number | null;
  denominatorNote: string;
  cost: CostByBasis;
  /** Cost per unit, split by basis. Null when the denominator is missing or zero. */
  perUnit: CostByBasis | null;
  total: number | null;
}

export function unitMetric(key: string, label: string, unit: string, cost: CostByBasis, denominator: number | null, denominatorNote: string): UnitMetric {
  const ok = denominator != null && denominator > 0;
  const per = ok ? { measured: round2(cost.measured / denominator!), estimated: round2(cost.estimated / denominator!), allocated: round2(cost.allocated / denominator!) } : null;
  return { key, label, unit, denominator, denominatorNote, cost: { measured: round2(cost.measured), estimated: round2(cost.estimated), allocated: round2(cost.allocated) }, perUnit: per, total: per ? round2(per.measured + per.estimated + per.allocated) : null };
}

/** Cost per $1 of value: annual cost divided by annual value; uses only measured (realized) value. */
export function costPerValueDollar(annualCost: CostByBasis, realizedAnnualValue: number): UnitMetric {
  return unitMetric("per_value_dollar", "Cost per $1 of realized value", "$1 of measured annual value", annualCost, realizedAnnualValue > 0 ? realizedAnnualValue : null, "Realized annual savings from measured value records");
}
