import { dataSecurityService, type DataSecurityService } from "@eaop/module-data-security";
import { type Platform } from "@eaop/platform";
import { z } from "zod";

/** The Data Security service, built by the module's install hook on the shared platform. */
export const ds = (platform: Platform): DataSecurityService => dataSecurityService(platform);

export const DS_MODULE = "data_security" as const;
export const DS_BASE = "/m/data-security";
export const anyBody = z.record(z.unknown());
const s = (max = 64) => z.string().max(max).optional();
export const listQuery = z.object({ status: s(), severity: s(), kind: s(), classification: s(), exposure: s(), q: s(200), source: s(), category: s(), decision: s(), approval: s(), limit: z.coerce.number().int().min(1).max(500).optional() });
