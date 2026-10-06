import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "@eaop/db";
import { conflict, notFound, type TenantContext } from "@eaop/shared-types";
import { addDays, BASE, daysBetween, iso, isoDay, parse, text, today, usdAmount, type Base } from "./base";
import { aiTools, aiToolLicenses, aiVendorContracts, aiVendors, CLASSIFICATION, REVIEW_STATUSES, TOOL_CATEGORIES, TOOL_STATUSES, VENDOR_REVIEW_STATUSES } from "./schema";

const toolSchema = z.object({
  name: text(160).min(1), vendorId: z.string().uuid().nullish(), contractId: z.string().uuid().nullish(), category: z.enum(TOOL_CATEGORIES).default("other"), purpose: text(2000).default(""),
  status: z.enum(TOOL_STATUSES).default("experimental"), businessOwnerUserId: z.string().uuid().nullish(), departments: z.array(text(120).min(1)).max(50).default([]),
  licensedSeats: z.number().int().min(0).max(10_000_000).default(0), annualCost: usdAmount.default(0), renewalDate: isoDay.nullish(),
  securityReview: z.enum(REVIEW_STATUSES).default("not_started"), privacyReview: z.enum(REVIEW_STATUSES).default("not_started"), maxDataClassification: z.enum(CLASSIFICATION).default("internal"),
  platformProviderKey: text(120).nullish(), platformModelKeys: z.array(text(200)).max(50).default([]), relatedModules: z.array(text(60)).max(10).default([]), usageKey: text(120).nullish(), website: z.string().url().max(500).nullish(),
});
const vendorSchema = z.object({
  name: text(160).min(1), website: z.string().url().max(500).nullish(), platformProviderKeys: z.array(text(120)).max(20).default([]), businessOwnerUserId: z.string().uuid().nullish(),
  contacts: z.array(z.object({ name: text(160).min(1), email: z.string().email().max(320).optional(), role: text(120).optional(), phone: text(60).optional() })).max(20).default([]),
  securityStatus: z.enum(VENDOR_REVIEW_STATUSES).default("not_reviewed"), privacyStatus: z.enum(VENDOR_REVIEW_STATUSES).default("not_reviewed"), status: z.enum(["active", "inactive"]).default("active"), notes: text(4000).default(""),
});
const contractSchema = z.object({
  vendorId: z.string().uuid(), name: text(200).min(1), contractNumber: text(120).nullish(), status: z.enum(["draft", "active", "expired", "terminated"]).default("active"),
  startDate: isoDay.nullish(), endDate: isoDay.nullish(), renewalDate: isoDay.nullish(), autoRenew: z.boolean().default(false), noticeDays: z.number().int().min(0).max(365).default(30),
  annualValue: usdAmount.default(0), committedAnnualSpend: usdAmount.default(0), billingFrequency: z.enum(["monthly", "quarterly", "annual", "usage"]).default("annual"),
  ownerUserId: z.string().uuid().nullish(), documentUrl: z.string().url().max(1000).nullish(), notes: text(4000).default(""),
});

type ToolRow = typeof aiTools.$inferSelect;

export function makeInventory(b: Base, settings: (orgId: string) => Promise<{ unusedLicenseDays: number; renewalNoticeDays: number }>) {
  const { deps } = b;

  /** License activity per tool: last activity from imports/SSO, or platform usage when the tool is linked to a platform provider. */
  async function licenseActivity(orgId: string, days: number, toolIds?: string[]) {
    const rows = await b.orgScope(orgId, (tx) => tx.execute(sql`
      with lic as (
        select l.tool_id, l.user_id,
          greatest(l.last_active_at, (select max(e.occurred_at) from usage_events e where e.organization_id = l.organization_id and e.user_id = l.user_id and t.platform_provider_key is not null and e.ai_provider = t.platform_provider_key and e.metric = 'ai.runs')) as last_active
        from ai_tool_licenses l join ai_tools t on t.id = l.tool_id
        where l.organization_id = ${orgId} and l.status = 'active' ${toolIds ? sql`and l.tool_id = any(${`{${toolIds.join(",")}}`}::uuid[])` : sql``}
      )
      select tool_id,
        count(*) filter (where last_active >= now() - make_interval(days => ${days}))::int as active,
        count(*) filter (where last_active is null or last_active < now() - make_interval(days => ${days}))::int as unused,
        count(*) filter (where last_active is null)::int as never_used
      from lic group by tool_id`));
    return (rows.rows as Array<{ tool_id: string; active: number; unused: number; never_used: number }>).map((r) => ({ toolId: r.tool_id, active: r.active, unused: r.unused, neverUsed: r.never_used }));
  }

  async function toolView(ctx: TenantContext, rows: ToolRow[]) {
    const costs = await b.can(ctx, "ai_ops.cost.read");
    const st = await settings(b.org(ctx));
    const activity = rows.length ? await licenseActivity(b.org(ctx), st.unusedLicenseDays, rows.map((r) => r.id)) : [];
    const vendorIds = [...new Set(rows.map((r) => r.vendorId).filter((x): x is string => !!x))];
    const ownerIds = [...new Set(rows.map((r) => r.businessOwnerUserId).filter((x): x is string => !!x))];
    const [vendors, owners] = await b.tenant(ctx, async (tx) => [
      vendorIds.length ? await tx.select({ id: aiVendors.id, name: aiVendors.name }).from(aiVendors).where(inArray(aiVendors.id, vendorIds)) : [],
      ownerIds.length ? ((await tx.execute(sql`select id, name from users where id = any(${`{${ownerIds.join(",")}}`}::uuid[])`)).rows as Array<{ id: string; name: string }>) : [],
    ] as const);
    return rows.map((t) => {
      const a = activity.find((x) => x.toolId === t.id);
      return {
        id: t.id, name: t.name, vendorId: t.vendorId, vendorName: vendors.find((v) => v.id === t.vendorId)?.name ?? null, contractId: t.contractId, category: t.category, purpose: t.purpose, status: t.status,
        businessOwnerUserId: t.businessOwnerUserId, businessOwner: owners.find((o) => o.id === t.businessOwnerUserId)?.name ?? null, departments: t.departments,
        licensedSeats: t.licensedSeats, assignedLicenses: a ? a.active + a.unused : 0, activeUsers: a?.active ?? 0, unusedLicenses: a?.unused ?? 0,
        annualCost: costs ? t.annualCost : null, renewalDate: t.renewalDate, securityReview: t.securityReview, privacyReview: t.privacyReview, maxDataClassification: t.maxDataClassification,
        platformProviderKey: t.platformProviderKey, platformModelKeys: t.platformModelKeys, relatedModules: t.relatedModules, usageKey: t.usageKey, website: t.website, source: t.source, requestId: t.requestId,
        createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
      };
    });
  }

  async function createTool(ctx: TenantContext, input: z.output<typeof toolSchema>, extra: { source?: ToolRow["source"]; requestId?: string | null } = {}) {
    const row = await b.tenant(ctx, async (tx) => {
      await b.assertMember(tx, b.org(ctx), input.businessOwnerUserId, "Business owner");
      const [dup] = await tx.select({ id: aiTools.id }).from(aiTools).where(and(eq(aiTools.organizationId, b.org(ctx)), sql`lower(${aiTools.name}) = lower(${input.name})`)).limit(1);
      if (dup) throw conflict(`A tool named "${input.name}" already exists.`);
      return (await tx.insert(aiTools).values({ ...input, organizationId: b.org(ctx), source: extra.source ?? "manual", requestId: extra.requestId ?? null, createdBy: b.userId(ctx) }).returning())[0]!;
    });
    await deps.bus.publish(ctx, "ai_ops.tool.added", { toolId: row.id, status: row.status, source: row.source });
    await b.record(ctx, "ai_ops.tool_added", "ai_tool", row.id, { after: { name: row.name, status: row.status, vendorId: row.vendorId, annualCost: row.annualCost } });
    return row;
  }

  return {
    licenseActivity, createTool, toolSchema,

    async listTools(ctx: TenantContext, q: { status?: string; q?: string } = {}) {
      await b.require(ctx, "ai_ops.read");
      const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiTools).where(and(eq(aiTools.organizationId, b.org(ctx)), q.status ? eq(aiTools.status, q.status as ToolRow["status"]) : undefined, like ? sql`${aiTools.name} ilike ${like}` : undefined)).orderBy(asc(aiTools.name)).limit(2000));
      return toolView(ctx, rows);
    },
    async getTool(ctx: TenantContext, id: string) {
      await b.require(ctx, "ai_ops.read");
      b.uuidOr404(id, "Tool");
      const [row] = await b.tenant(ctx, (tx) => tx.select().from(aiTools).where(and(eq(aiTools.organizationId, b.org(ctx)), eq(aiTools.id, id))).limit(1));
      if (!row) throw notFound("Tool", id);
      const [view] = await toolView(ctx, [row]);
      const canLicenses = await b.can(ctx, "ai_ops.tool.manage");
      const licenses = canLicenses ? await b.tenant(ctx, async (tx) => (await tx.execute(sql`
        select l.id, l.user_id, u.name, u.email, m.department, l.status, l.source, l.assigned_at, l.last_active_at, l.activity_days_30
        from ai_tool_licenses l join users u on u.id = l.user_id left join memberships m on m.user_id = l.user_id and m.organization_id = l.organization_id
        where l.tool_id = ${id} order by l.status, u.name limit 2000`)).rows as Array<Record<string, unknown>>) : null;
      const contract = row.contractId && (await b.can(ctx, "ai_ops.cost.read")) ? (await b.tenant(ctx, (tx) => tx.select().from(aiVendorContracts).where(eq(aiVendorContracts.id, row.contractId!)).limit(1)))[0] ?? null : null;
      return {
        ...view!,
        licenses: licenses?.map((l) => ({ id: String(l.id), userId: String(l.user_id), name: String(l.name), email: String(l.email), department: (l.department as string) ?? null, status: String(l.status), source: String(l.source), assignedAt: new Date(l.assigned_at as string).toISOString(), lastActiveAt: l.last_active_at ? new Date(l.last_active_at as string).toISOString() : null, activityDays30: Number(l.activity_days_30) })) ?? null,
        contract: contract ? { id: contract.id, name: contract.name, renewalDate: contract.renewalDate, annualValue: contract.annualValue, status: contract.status } : null,
      };
    },
    async addTool(ctx: TenantContext, raw: unknown) {
      await b.require(ctx, "ai_ops.tool.manage");
      const row = await createTool(ctx, parse(toolSchema, raw));
      return (await toolView(ctx, [row]))[0]!;
    },
    async updateTool(ctx: TenantContext, id: string, raw: unknown) {
      await b.require(ctx, "ai_ops.tool.manage");
      b.uuidOr404(id, "Tool");
      const input = parse(toolSchema.partial(), raw);
      const res = await b.tenant(ctx, async (tx) => {
        const [before] = await tx.select().from(aiTools).where(and(eq(aiTools.organizationId, b.org(ctx)), eq(aiTools.id, id))).limit(1);
        if (!before) throw notFound("Tool", id);
        await b.assertMember(tx, b.org(ctx), input.businessOwnerUserId, "Business owner");
        const [after] = await tx.update(aiTools).set({ ...input, updatedAt: new Date() }).where(eq(aiTools.id, id)).returning();
        return { before, after: after! };
      });
      const changed = Object.fromEntries(Object.keys(input).map((k) => [k, (res.before as Record<string, unknown>)[k]]));
      await b.record(ctx, "ai_ops.tool_updated", "ai_tool", id, { before: changed, after: input });
      return (await toolView(ctx, [res.after]))[0]!;
    },

    // ── Licenses ──────────────────────────────────────────────────────────
    async assignLicenses(ctx: TenantContext, toolId: string, raw: unknown) {
      await b.require(ctx, "ai_ops.tool.manage");
      b.uuidOr404(toolId, "Tool");
      const input = parse(z.object({ users: z.array(text(320).min(1)).min(1).max(5000), source: z.enum(["manual", "import", "sso"]).default("manual") }), raw);
      const res = await b.tenant(ctx, async (tx) => {
        const [t] = await tx.select({ id: aiTools.id }).from(aiTools).where(and(eq(aiTools.organizationId, b.org(ctx)), eq(aiTools.id, toolId))).limit(1);
        if (!t) throw notFound("Tool", toolId);
        const { members, unknown } = await b.resolveMembers(tx, b.org(ctx), input.users);
        let assigned = 0;
        for (const m of members) {
          const [r] = await tx.insert(aiToolLicenses).values({ organizationId: b.org(ctx), toolId, userId: m.id, source: input.source })
            .onConflictDoUpdate({ target: [aiToolLicenses.toolId, aiToolLicenses.userId], set: { status: "active", revokedAt: null }, where: sql`${aiToolLicenses.status} = 'revoked'` }).returning({ id: aiToolLicenses.id });
          if (r) assigned++;
        }
        return { assigned, alreadyAssigned: members.length - assigned, unknown };
      });
      await b.record(ctx, "ai_ops.licenses_assigned", "ai_tool", toolId, { metadata: { assigned: res.assigned, unknown: res.unknown.length } });
      return res;
    },
    async revokeLicense(ctx: TenantContext, toolId: string, licenseId: string) {
      await b.require(ctx, "ai_ops.tool.manage");
      b.uuidOr404(licenseId, "License");
      const [r] = await b.tenant(ctx, (tx) => tx.update(aiToolLicenses).set({ status: "revoked", revokedAt: new Date() }).where(and(eq(aiToolLicenses.organizationId, b.org(ctx)), eq(aiToolLicenses.toolId, toolId), eq(aiToolLicenses.id, licenseId), eq(aiToolLicenses.status, "active"))).returning());
      if (!r) throw notFound("License", licenseId);
      await b.record(ctx, "ai_ops.license_revoked", "ai_tool", toolId, { metadata: { licenseId, userId: r.userId } });
      return { ok: true };
    },
    /** Activity feed from a vendor admin export or SSO: last active date and active days, per user. */
    async recordActivity(ctx: TenantContext, toolId: string, raw: unknown) {
      await b.require(ctx, "ai_ops.tool.manage");
      b.uuidOr404(toolId, "Tool");
      const input = parse(z.object({ activity: z.array(z.object({ user: text(320).min(1), lastActiveAt: z.coerce.date(), activeDays30: z.number().int().min(0).max(31).default(0) })).min(1).max(10_000) }), raw);
      const res = await b.tenant(ctx, async (tx) => {
        const { members, unknown } = await b.resolveMembers(tx, b.org(ctx), input.activity.map((a) => a.user));
        let updated = 0;
        for (const a of input.activity) {
          const m = members.find((x) => x.id === a.user || x.email === a.user.trim().toLowerCase());
          if (!m) continue;
          const r = await tx.update(aiToolLicenses).set({ lastActiveAt: sql`greatest(${aiToolLicenses.lastActiveAt}, ${a.lastActiveAt.toISOString()}::timestamptz)`, activityDays30: a.activeDays30 })
            .where(and(eq(aiToolLicenses.organizationId, b.org(ctx)), eq(aiToolLicenses.toolId, toolId), eq(aiToolLicenses.userId, m.id))).returning({ id: aiToolLicenses.id });
          updated += r.length;
        }
        return { updated, unknown, withoutLicense: input.activity.length - updated - unknown.length };
      });
      await b.record(ctx, "ai_ops.license_activity_recorded", "ai_tool", toolId, { metadata: { updated: res.updated } });
      return res;
    },

    // ── Vendors & contracts ───────────────────────────────────────────────
    async listVendors(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.read");
      const costs = await b.can(ctx, "ai_ops.cost.read");
      return b.tenant(ctx, async (tx) => {
        const rows = await tx.select().from(aiVendors).where(eq(aiVendors.organizationId, b.org(ctx))).orderBy(asc(aiVendors.name));
        const contracts = await tx.select().from(aiVendorContracts).where(eq(aiVendorContracts.organizationId, b.org(ctx)));
        const tools = await tx.select({ id: aiTools.id, vendorId: aiTools.vendorId, name: aiTools.name, status: aiTools.status, annualCost: aiTools.annualCost }).from(aiTools).where(eq(aiTools.organizationId, b.org(ctx)));
        return rows.map((v) => {
          const cs = contracts.filter((c) => c.vendorId === v.id && c.status === "active");
          const nextRenewal = cs.map((c) => c.renewalDate).filter((d): d is string => !!d).sort()[0] ?? null;
          return {
            id: v.id, name: v.name, website: v.website, platformProviderKeys: v.platformProviderKeys, businessOwnerUserId: v.businessOwnerUserId, securityStatus: v.securityStatus, privacyStatus: v.privacyStatus, status: v.status,
            products: tools.filter((t) => t.vendorId === v.id).map((t) => ({ id: t.id, name: t.name, status: t.status })), activeContracts: cs.length, nextRenewal,
            annualContractValue: costs ? cs.reduce((a, c) => a + c.annualValue, 0) : null,
          };
        });
      });
    },
    async getVendor(ctx: TenantContext, id: string) {
      await b.require(ctx, "ai_ops.read");
      b.uuidOr404(id, "Vendor");
      const costs = await b.can(ctx, "ai_ops.cost.read");
      const manage = await b.can(ctx, "ai_ops.vendor.manage");
      return b.tenant(ctx, async (tx) => {
        const [v] = await tx.select().from(aiVendors).where(and(eq(aiVendors.organizationId, b.org(ctx)), eq(aiVendors.id, id))).limit(1);
        if (!v) throw notFound("Vendor", id);
        const contracts = costs || manage ? await tx.select().from(aiVendorContracts).where(eq(aiVendorContracts.vendorId, id)).orderBy(desc(aiVendorContracts.renewalDate)) : [];
        const tools = await tx.select().from(aiTools).where(eq(aiTools.vendorId, id)).orderBy(asc(aiTools.name));
        const providers = v.platformProviderKeys.length ? ((await tx.execute(sql`select key, name, kind, status from ai_providers where (organization_id is null or organization_id = ${b.org(ctx)}) and key = any(${`{${v.platformProviderKeys.join(",")}}`}::text[])`)).rows as Array<{ key: string; name: string; kind: string; status: string }>) : [];
        return {
          id: v.id, name: v.name, website: v.website, platformProviderKeys: v.platformProviderKeys, platformProviders: providers, businessOwnerUserId: v.businessOwnerUserId,
          contacts: manage ? v.contacts : [], securityStatus: v.securityStatus, privacyStatus: v.privacyStatus, securityReviewedAt: iso(v.securityReviewedAt), privacyReviewedAt: iso(v.privacyReviewedAt), status: v.status, notes: manage ? v.notes : "",
          products: tools.map((t) => ({ id: t.id, name: t.name, status: t.status, category: t.category, annualCost: costs ? t.annualCost : null, licensedSeats: t.licensedSeats })),
          contracts: contracts.map((c) => ({ ...c, annualValue: costs ? c.annualValue : null, committedAnnualSpend: costs ? c.committedAnnualSpend : null, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), daysToRenewal: c.renewalDate ? daysBetween(today(), c.renewalDate) : null })),
        };
      });
    },
    async saveVendor(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.vendor.manage");
      const input = parse(id ? vendorSchema.partial() : vendorSchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        await b.assertMember(tx, b.org(ctx), input.businessOwnerUserId, "Business owner");
        const reviewed = { ...(input.securityStatus && input.securityStatus !== "not_reviewed" ? { securityReviewedAt: new Date() } : {}), ...(input.privacyStatus && input.privacyStatus !== "not_reviewed" ? { privacyReviewedAt: new Date() } : {}) };
        if (!id) {
          const [dup] = await tx.select({ id: aiVendors.id }).from(aiVendors).where(and(eq(aiVendors.organizationId, b.org(ctx)), sql`lower(${aiVendors.name}) = lower(${input.name!})`)).limit(1);
          if (dup) throw conflict(`A vendor named "${input.name}" already exists.`);
          return (await tx.insert(aiVendors).values({ ...(input as z.output<typeof vendorSchema>), ...reviewed, organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning())[0]!;
        }
        b.uuidOr404(id, "Vendor");
        const [u] = await tx.update(aiVendors).set({ ...input, ...reviewed, updatedAt: new Date() }).where(and(eq(aiVendors.organizationId, b.org(ctx)), eq(aiVendors.id, id))).returning();
        if (!u) throw notFound("Vendor", id);
        return u;
      });
      await b.record(ctx, id ? "ai_ops.vendor_updated" : "ai_ops.vendor_created", "ai_vendor", row.id, { after: { ...input, contacts: input.contacts?.length } });
      return { id: row.id, name: row.name };
    },
    async saveContract(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.vendor.manage");
      const input = parse(id ? contractSchema.partial() : contractSchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        if (input.vendorId) {
          const [v] = await tx.select({ id: aiVendors.id }).from(aiVendors).where(and(eq(aiVendors.organizationId, b.org(ctx)), eq(aiVendors.id, input.vendorId))).limit(1);
          if (!v) throw notFound("Vendor", input.vendorId);
        }
        await b.assertMember(tx, b.org(ctx), input.ownerUserId, "Owner");
        if (!id) return (await tx.insert(aiVendorContracts).values({ ...(input as z.output<typeof contractSchema>), organizationId: b.org(ctx) }).returning())[0]!;
        b.uuidOr404(id, "Contract");
        const [u] = await tx.update(aiVendorContracts).set({ ...input, ...(input.renewalDate ? { renewalAlertedFor: null } : {}), updatedAt: new Date() }).where(and(eq(aiVendorContracts.organizationId, b.org(ctx)), eq(aiVendorContracts.id, id))).returning();
        if (!u) throw notFound("Contract", id);
        return u;
      });
      await b.record(ctx, id ? "ai_ops.contract_updated" : "ai_ops.contract_created", "ai_vendor_contract", row.id, { after: input });
      return { id: row.id, name: row.name };
    },

    /** Daily: one alert per contract renewal date once it is inside the notice window. */
    async checkRenewals(orgId: string, now = today()) {
      const st = await settings(orgId);
      const ctx = b.sysCtx(orgId);
      const due = await b.orgScope(orgId, (tx) => tx.select().from(aiVendorContracts).where(and(eq(aiVendorContracts.organizationId, orgId), inArray(aiVendorContracts.status, ["active", "draft"]),
        sql`${aiVendorContracts.renewalDate} is not null and ${aiVendorContracts.renewalDate} >= ${now}::date and ${aiVendorContracts.renewalDate} <= (${now}::date + greatest(${st.renewalNoticeDays}, ${aiVendorContracts.noticeDays} + 14))`,
        sql`${aiVendorContracts.renewalAlertedFor} is distinct from ${aiVendorContracts.renewalDate}`)));
      for (const c of due) {
        const days = daysBetween(now, c.renewalDate!);
        const noticeBy = addDays(c.renewalDate!, -c.noticeDays);
        await b.orgScope(orgId, (tx) => tx.update(aiVendorContracts).set({ renewalAlertedFor: c.renewalDate }).where(eq(aiVendorContracts.id, c.id)));
        await deps.bus.publish(ctx, "ai_ops.contract.renewal_due", { contractId: c.id, vendorId: c.vendorId, renewalDate: c.renewalDate!, daysUntil: days, annualValue: c.annualValue, autoRenew: c.autoRenew });
        await deps.notifications.notify(ctx, {
          type: "ai_ops.renewal_due", title: `${c.name} renews in ${days} day${days === 1 ? "" : "s"}`, body: `${c.autoRenew ? "Auto-renews" : "Renews"} on ${c.renewalDate}. Notice is due by ${noticeBy}. Review utilization and open optimization findings first.`,
          actionUrl: `${BASE}/vendors/${c.vendorId}`, priority: days <= c.noticeDays ? "high" : "normal", recipients: c.ownerUserId ? { userIds: [c.ownerUserId] } : { permission: "ai_ops.vendor.manage" },
        });
        await b.record(ctx, "ai_ops.renewal_alerted", "ai_vendor_contract", c.id, { metadata: { renewalDate: c.renewalDate, daysUntil: days } });
      }
      return due.length;
    },
  };
}

export type Inventory = ReturnType<typeof makeInventory>;
