import { z } from "zod";
import { and, asc, eq, inArray, sql } from "@eaop/db";
import { AppError, conflict, notFound, type TenantContext } from "@eaop/shared-types";
import { BASE, iso, isoDay, parse, text, today, type Base } from "./base";
import { departmentAdoption } from "./economics";
import { aiAdoptionMetrics, aiTrainingAssignments, aiTrainingPrograms, aiUseCases } from "./schema";
import { DEPARTMENTS } from "./seeds";

const programSchema = z.object({
  name: text(200).min(1), kind: z.enum(["program", "course"]).default("course"), parentId: z.string().uuid().nullish(), description: text(4000).default(""), workflowFocus: text(1000).default(""),
  departments: z.array(text(120).min(1)).max(50).default([]), roles: z.array(text(60).min(1)).max(20).default([]), required: z.boolean().default(false),
  validityDays: z.number().int().min(30).max(3650).nullish(), passScore: z.number().int().min(0).max(100).nullish(), contentUrl: z.string().url().max(1000).nullish(), status: z.enum(["draft", "active", "retired"]).default("active"),
});
const useCaseSchema = z.object({
  department: text(120).min(1), title: text(200).min(1), businessProblem: text(4000).default(""), approvedWorkflow: text(4000).default(""), toolId: z.string().uuid().nullish(),
  instructions: text(8000).default(""), expectedBenefit: text(2000).default(""), risks: text(4000).default(""), requiredTrainingId: z.string().uuid().nullish(), successMetric: text(500).default(""),
  workflowRef: text(120).nullish(), usageKey: text(120).nullish(), templateId: z.string().uuid().nullish(), status: z.enum(["draft", "published", "retired"]).default("draft"), ownerUserId: z.string().uuid().nullish(),
});

export function makePeople(b: Base, settings: (orgId: string) => Promise<{ adoptionMinGroup: number; unusedLicenseDays: number }>) {
  const { deps } = b;

  /** Department-level adoption for the last 30 days, stored as this month's snapshot. Never per person. */
  async function snapshotAdoption(orgId: string, now = new Date()) {
    const period = now.toISOString().slice(0, 7);
    const st = await settings(orgId);
    return b.orgScope(orgId, async (tx) => {
      const rows = (await tx.execute(sql`
        with m as (select user_id, coalesce(nullif(trim(department), ''), 'Unassigned') as dept from memberships where organization_id = ${orgId} and status = 'active'),
        lic as (select distinct l.user_id, l.last_active_at from ai_tool_licenses l where l.organization_id = ${orgId} and l.status = 'active'),
        runs as (select user_id, sum(quantity)::float8 as n from usage_events where organization_id = ${orgId} and metric = 'ai.runs' and occurred_at >= now() - interval '30 days' and user_id is not null group by user_id),
        tr as (select user_id, count(*) filter (where required) as req, count(*) filter (where required and status = 'completed') as done from ai_training_assignments where organization_id = ${orgId} and status <> 'waived' group by user_id)
        select m.dept as department, count(*)::int as members,
          count(*) filter (where exists (select 1 from lic where lic.user_id = m.user_id))::int as licensed,
          count(*) filter (where exists (select 1 from runs where runs.user_id = m.user_id) or exists (select 1 from lic where lic.user_id = m.user_id and lic.last_active_at >= now() - make_interval(days => ${st.unusedLicenseDays})))::int as active,
          coalesce(sum((select n from runs where runs.user_id = m.user_id)), 0)::int as ai_runs,
          coalesce(sum((select req from tr where tr.user_id = m.user_id)), 0)::int as training_required,
          coalesce(sum((select done from tr where tr.user_id = m.user_id)), 0)::int as training_completed
        from m group by m.dept`)).rows as Array<{ department: string; members: number; licensed: number; active: number; ai_runs: number; training_required: number; training_completed: number }>;
      // Use-case adoption through the shared usage metering (dimension useCase).
      const uc = (await tx.execute(sql`
        select coalesce(nullif(trim(m.department), ''), 'Unassigned') as department, u.usage_key, count(distinct e.user_id)::int as users
        from ai_use_cases u join usage_events e on e.organization_id = u.organization_id and e.metric = 'ai.runs' and e.occurred_at >= now() - interval '30 days' and e.dimensions->>'useCase' like replace(u.usage_key, '*', '%')
        join memberships m on m.user_id = e.user_id and m.organization_id = e.organization_id
        where u.organization_id = ${orgId} and u.status = 'published' and u.usage_key is not null group by 1, 2`)).rows as Array<{ department: string; usage_key: string; users: number }>;
      for (const r of rows) {
        const useCaseUsers = Object.fromEntries(uc.filter((x) => x.department === r.department).map((x) => [x.usage_key, x.users]));
        const values = { members: r.members, licensedUsers: r.licensed, activeUsers: r.active, aiRuns: r.ai_runs, trainingRequired: r.training_required, trainingCompleted: r.training_completed, useCaseUsers, computedAt: new Date() };
        await tx.insert(aiAdoptionMetrics).values({ organizationId: orgId, period, department: r.department, ...values }).onConflictDoUpdate({ target: [aiAdoptionMetrics.organizationId, aiAdoptionMetrics.period, aiAdoptionMetrics.department], set: values });
      }
      await tx.delete(aiAdoptionMetrics).where(and(eq(aiAdoptionMetrics.organizationId, orgId), eq(aiAdoptionMetrics.period, period), rows.length ? sql`${aiAdoptionMetrics.department} <> all(${`{${rows.map((r) => `"${r.department.replace(/["\\]/g, "")}"`).join(",")}}`}::text[])` : undefined));
      return rows.length;
    });
  }

  async function assign(ctx: TenantContext, programId: string, userIds: string[], opts: { dueDate?: string | null; required?: boolean }) {
    const res = await b.tenant(ctx, async (tx) => {
      const [p] = await tx.select().from(aiTrainingPrograms).where(and(eq(aiTrainingPrograms.organizationId, b.org(ctx)), eq(aiTrainingPrograms.id, programId))).limit(1);
      if (!p) throw notFound("Training", programId);
      if (p.status !== "active") throw conflict("Only active training can be assigned.");
      const members = userIds.length ? ((await tx.execute(sql`select m.user_id, m.department, (select string_agg(r.key, ',') from member_roles mr join roles r on r.id = mr.role_id where mr.membership_id = m.id) as roles from memberships m where m.organization_id = ${b.org(ctx)} and m.status = 'active' and m.user_id = any(${`{${userIds.join(",")}}`}::uuid[])`)).rows as Array<{ user_id: string; department: string | null; roles: string | null }>) : [];
      const created: Array<{ id: string; userId: string }> = [];
      for (const m of members) {
        const [a] = await tx.insert(aiTrainingAssignments).values({ organizationId: b.org(ctx), programId, userId: m.user_id, department: m.department, role: m.roles?.split(",")[0] ?? null, required: opts.required ?? p.required, dueDate: opts.dueDate ?? null, assignedBy: b.userId(ctx) })
          .onConflictDoUpdate({ target: [aiTrainingAssignments.programId, aiTrainingAssignments.userId], set: { status: "assigned", dueDate: opts.dueDate ?? null, required: opts.required ?? p.required, completedAt: null, score: null, passed: null, expiresAt: null, updatedAt: new Date() }, where: sql`${aiTrainingAssignments.status} in ('expired','waived')` })
          .returning({ id: aiTrainingAssignments.id });
        if (a) created.push({ id: a.id, userId: m.user_id });
      }
      return { program: p, created, skipped: userIds.length - created.length };
    });
    for (const a of res.created) {
      await deps.bus.publish(ctx, "ai_ops.training.required", { assignmentId: a.id, programId, userId: a.userId, dueDate: opts.dueDate ?? null, required: opts.required ?? res.program.required });
    }
    if (res.created.length) {
      await deps.notifications.notify(ctx, { type: "ai_ops.training_required", title: `AI training assigned: ${res.program.name}`, body: `${res.program.required ? "Required" : "Recommended"}${opts.dueDate ? `, due ${opts.dueDate}` : ""}. ${res.program.workflowFocus}`.trim(), actionUrl: `${BASE}/training`, recipients: { userIds: res.created.map((a) => a.userId) } });
    }
    return res;
  }

  /** Daily: completed training past its validity expires; required training is reassigned. */
  async function expireTraining(orgId: string) {
    const expired = await b.orgScope(orgId, (tx) => tx.update(aiTrainingAssignments).set({ status: "expired", updatedAt: new Date() }).where(and(eq(aiTrainingAssignments.organizationId, orgId), eq(aiTrainingAssignments.status, "completed"), sql`${aiTrainingAssignments.expiresAt} < now()`)).returning());
    const ctx = b.sysCtx(orgId);
    for (const a of expired.filter((x) => x.required)) {
      await assign(ctx, a.programId, [a.userId], { required: true, dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) }).catch((e: unknown) => deps.logger.warn("ai_ops.training_reassign_failed", { error: e instanceof Error ? e.message : String(e) }));
    }
    return expired.length;
  }

  const programView = (p: typeof aiTrainingPrograms.$inferSelect, stats?: { assigned: number; completed: number }) => ({ ...p, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), assigned: stats?.assigned ?? 0, completed: stats?.completed ?? 0 });
  const toUseCaseView = (u: typeof aiUseCases.$inferSelect, extra: { toolName?: string | null; trainingName?: string | null; activeUsers?: number | null } = {}) => ({ ...u, createdAt: u.createdAt.toISOString(), updatedAt: u.updatedAt.toISOString(), toolName: extra.toolName ?? null, trainingName: extra.trainingName ?? null, activeUsers: extra.activeUsers ?? null });

  return {
    snapshotAdoption, expireTraining,

    async adoption(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.adoption.read");
      const st = await settings(b.org(ctx));
      const period = new Date().toISOString().slice(0, 7);
      // On-demand reads recompute this month's snapshot (aggregate queries only); dashboards reuse the stored one.
      await snapshotAdoption(b.org(ctx));
      const rows = await b.tenant(ctx, (tx) => tx.select().from(aiAdoptionMetrics).where(and(eq(aiAdoptionMetrics.organizationId, b.org(ctx)), eq(aiAdoptionMetrics.period, period))));
      const history = await b.tenant(ctx, (tx) => tx.execute(sql`select period, sum(members)::int as members, sum(active_users)::int as active, sum(licensed_users)::int as licensed from ai_adoption_metrics where organization_id = ${b.org(ctx)} group by period order by period desc limit 12`));
      const sum = (k: "members" | "licensedUsers" | "activeUsers" | "aiRuns" | "trainingRequired" | "trainingCompleted") => rows.reduce((a, r) => a + r[k], 0);
      const useCases = await b.tenant(ctx, (tx) => tx.select({ id: aiUseCases.id, title: aiUseCases.title, department: aiUseCases.department, usageKey: aiUseCases.usageKey }).from(aiUseCases).where(and(eq(aiUseCases.organizationId, b.org(ctx)), eq(aiUseCases.status, "published"))));
      const ucUsers = (key: string | null) => (key ? rows.reduce((a, r) => a + (r.useCaseUsers[key] ?? 0), 0) : null);
      const members = sum("members");
      return {
        period, minGroupSize: st.adoptionMinGroup, computedAt: rows[0] ? rows[0].computedAt.toISOString() : null,
        totals: {
          members, licensedUsers: sum("licensedUsers"), activeUsers: sum("activeUsers"), aiRuns30d: sum("aiRuns"),
          activePct: members ? Math.round((sum("activeUsers") / members) * 100) : 0,
          trainingCompletionPct: sum("trainingRequired") ? Math.round((sum("trainingCompleted") / sum("trainingRequired")) * 100) : null,
          runsPerActiveUser: sum("activeUsers") ? Math.round((sum("aiRuns") / sum("activeUsers")) * 10) / 10 : 0,
        },
        departments: departmentAdoption(rows.map((r) => ({ department: r.department, members: r.members, licensed: r.licensedUsers, active: r.activeUsers, aiRuns: r.aiRuns, trainingRequired: r.trainingRequired, trainingCompleted: r.trainingCompleted })), st.adoptionMinGroup),
        useCases: useCases.map((u) => {
          const n = ucUsers(u.usageKey);
          return { id: u.id, title: u.title, department: u.department, tracked: !!u.usageKey, activeUsers: n == null ? null : n < st.adoptionMinGroup && n > 0 ? null : n, suppressed: n != null && n > 0 && n < st.adoptionMinGroup };
        }),
        trend: (history.rows as Array<{ period: string; members: number; active: number; licensed: number }>).reverse().map((h) => ({ period: h.period, activePct: h.members ? Math.round((h.active / h.members) * 100) : 0, licensed: h.licensed, active: h.active })),
      };
    },

    // ── Training ──────────────────────────────────────────────────────────
    async listPrograms(ctx: TenantContext) {
      await b.require(ctx, "ai_ops.read");
      const manage = await b.can(ctx, "ai_ops.training.manage");
      return b.tenant(ctx, async (tx) => {
        const rows = await tx.select().from(aiTrainingPrograms).where(and(eq(aiTrainingPrograms.organizationId, b.org(ctx)), manage ? undefined : eq(aiTrainingPrograms.status, "active"))).orderBy(asc(aiTrainingPrograms.name));
        const stats = manage ? ((await tx.execute(sql`select program_id, count(*) filter (where status <> 'waived')::int as assigned, count(*) filter (where status = 'completed')::int as completed from ai_training_assignments where organization_id = ${b.org(ctx)} group by program_id`)).rows as Array<{ program_id: string; assigned: number; completed: number }>) : [];
        return rows.map((p) => programView(p, stats.find((s) => s.program_id === p.id)));
      });
    },
    async saveProgram(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.training.manage");
      const input = parse(id ? programSchema.partial() : programSchema, raw);
      const row = await b.tenant(ctx, async (tx) => {
        if (!id) {
          const [dup] = await tx.select({ id: aiTrainingPrograms.id }).from(aiTrainingPrograms).where(and(eq(aiTrainingPrograms.organizationId, b.org(ctx)), eq(aiTrainingPrograms.name, input.name!))).limit(1);
          if (dup) throw conflict(`Training named "${input.name}" already exists.`);
          return (await tx.insert(aiTrainingPrograms).values({ ...(input as z.output<typeof programSchema>), organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning())[0]!;
        }
        b.uuidOr404(id, "Training");
        const [u] = await tx.update(aiTrainingPrograms).set({ ...input, updatedAt: new Date() }).where(and(eq(aiTrainingPrograms.organizationId, b.org(ctx)), eq(aiTrainingPrograms.id, id))).returning();
        if (!u) throw notFound("Training", id);
        return u;
      });
      await b.record(ctx, id ? "ai_ops.training_updated" : "ai_ops.training_created", "ai_training_program", row.id, { after: input });
      return programView(row);
    },
    /** Assign to named users, or to everyone in departments/roles. */
    async assignTraining(ctx: TenantContext, programId: string, raw: unknown) {
      await b.require(ctx, "ai_ops.training.manage");
      b.uuidOr404(programId, "Training");
      const input = parse(z.object({ users: z.array(text(320).min(1)).max(5000).default([]), departments: z.array(text(120)).max(50).default([]), roles: z.array(text(60)).max(20).default([]), dueDate: isoDay.nullish(), required: z.boolean().optional() })
        .refine((x) => x.users.length + x.departments.length + x.roles.length > 0, "Choose users, departments or roles."), raw);
      const ids = await b.tenant(ctx, async (tx) => {
        const { members } = await b.resolveMembers(tx, b.org(ctx), input.users);
        const byGroup = input.departments.length || input.roles.length ? ((await tx.execute(sql`
          select distinct m.user_id from memberships m left join member_roles mr on mr.membership_id = m.id left join roles r on r.id = mr.role_id
          where m.organization_id = ${b.org(ctx)} and m.status = 'active' and (lower(m.department) = any(${`{${input.departments.map((d) => `"${d.toLowerCase().replace(/["\\]/g, "")}"`).join(",")}}`}::text[]) or r.key = any(${`{${input.roles.map((r) => `"${r.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]))`)).rows as Array<{ user_id: string }>).map((r) => r.user_id) : [];
        return [...new Set([...members.map((m) => m.id), ...byGroup])];
      });
      const res = await assign(ctx, programId, ids, { dueDate: input.dueDate, required: input.required });
      await b.record(ctx, "ai_ops.training_assigned", "ai_training_program", programId, { metadata: { assigned: res.created.length, departments: input.departments, roles: input.roles } });
      return { assigned: res.created.length, alreadyAssigned: res.skipped };
    },
    /** Training records: managers see everyone's; everyone else only their own. */
    async listAssignments(ctx: TenantContext, q: { programId?: string; mine?: boolean } = {}) {
      await b.require(ctx, "ai_ops.read");
      const all = !q.mine && (await b.can(ctx, "ai_ops.training.manage"));
      const uid = b.userId(ctx);
      if (!all && !uid) return [];
      const rows = await b.tenant(ctx, (tx) => tx.execute(sql`
        select a.*, p.name as program_name, p.workflow_focus, p.pass_score, p.content_url, u.name as user_name
        from ai_training_assignments a join ai_training_programs p on p.id = a.program_id join users u on u.id = a.user_id
        where a.organization_id = ${b.org(ctx)} ${all ? sql`` : sql`and a.user_id = ${uid}`} ${q.programId ? sql`and a.program_id = ${q.programId}::uuid` : sql``}
        order by a.status, a.due_date nulls last limit 2000`));
      return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id), programId: String(r.program_id), programName: String(r.program_name), workflowFocus: String(r.workflow_focus ?? ""), contentUrl: (r.content_url as string) ?? null, passScore: (r.pass_score as number) ?? null,
        userId: String(r.user_id), userName: String(r.user_name), department: (r.department as string) ?? null, role: (r.role as string) ?? null, required: !!r.required, status: String(r.status),
        dueDate: r.due_date ? String(r.due_date).slice(0, 10) : null, completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null, score: (r.score as number) ?? null, passed: (r.passed as boolean) ?? null,
        expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null, overdue: !!r.due_date && String(r.due_date).slice(0, 10) < today() && r.status !== "completed",
      }));
    },
    /** Record completion. A person may complete their own assignment; managers may record anyone's (e.g. from an LMS). */
    async completeAssignment(ctx: TenantContext, id: string, raw: unknown) {
      b.uuidOr404(id, "Assignment");
      await b.require(ctx, "ai_ops.read");
      const input = parse(z.object({ score: z.number().int().min(0).max(100).nullish(), status: z.enum(["in_progress", "completed", "waived"]).default("completed") }), raw);
      const manage = await b.can(ctx, "ai_ops.training.manage");
      const res = await b.tenant(ctx, async (tx) => {
        const [a] = await tx.select().from(aiTrainingAssignments).where(and(eq(aiTrainingAssignments.organizationId, b.org(ctx)), eq(aiTrainingAssignments.id, id))).limit(1);
        if (!a || (!manage && a.userId !== b.userId(ctx))) throw notFound("Assignment", id);
        if (input.status === "waived" && !manage) throw new AppError("FORBIDDEN", "Only training managers can waive training.");
        const [p] = await tx.select().from(aiTrainingPrograms).where(eq(aiTrainingPrograms.id, a.programId)).limit(1);
        if (input.status === "completed" && p!.passScore != null && input.score == null) throw new AppError("VALIDATION_FAILED", `This training has an assessment; record the score (pass mark ${p!.passScore}).`);
        const passed = input.status === "completed" ? (p!.passScore == null ? true : (input.score ?? 0) >= p!.passScore) : null;
        const status = input.status === "completed" && passed === false ? "in_progress" : input.status;
        const completedAt = status === "completed" ? new Date() : null;
        const [u] = await tx.update(aiTrainingAssignments).set({ status, score: input.score ?? null, passed, completedAt, expiresAt: completedAt && p!.validityDays ? new Date(completedAt.getTime() + p!.validityDays * 86_400_000) : null, updatedAt: new Date() }).where(eq(aiTrainingAssignments.id, id)).returning();
        return u!;
      });
      await b.record(ctx, "ai_ops.training_recorded", "ai_training_assignment", id, { after: { status: res.status, score: res.score, passed: res.passed } });
      return { id, status: res.status, passed: res.passed, expiresAt: iso(res.expiresAt) };
    },

    // ── Use-case library ──────────────────────────────────────────────────
    async listUseCases(ctx: TenantContext, q: { department?: string } = {}) {
      await b.require(ctx, "ai_ops.read");
      const manage = await b.can(ctx, "ai_ops.training.manage");
      return b.tenant(ctx, async (tx) => {
        const rows = await tx.select().from(aiUseCases).where(and(eq(aiUseCases.organizationId, b.org(ctx)), manage ? undefined : eq(aiUseCases.status, "published"), q.department ? eq(aiUseCases.department, q.department) : undefined)).orderBy(asc(aiUseCases.department), asc(aiUseCases.title));
        const toolIds = rows.map((r) => r.toolId).filter((x): x is string => !!x);
        const trIds = rows.map((r) => r.requiredTrainingId).filter((x): x is string => !!x);
        const tools = toolIds.length ? ((await tx.execute(sql`select id, name from ai_tools where id = any(${`{${toolIds.join(",")}}`}::uuid[])`)).rows as Array<{ id: string; name: string }>) : [];
        const trs = trIds.length ? await tx.select({ id: aiTrainingPrograms.id, name: aiTrainingPrograms.name }).from(aiTrainingPrograms).where(inArray(aiTrainingPrograms.id, trIds)) : [];
        return rows.map((u) => toUseCaseView(u, { toolName: tools.find((t) => t.id === u.toolId)?.name, trainingName: trs.find((t) => t.id === u.requiredTrainingId)?.name }));
      });
    },
    async saveUseCase(ctx: TenantContext, id: string | null, raw: unknown) {
      await b.require(ctx, "ai_ops.training.manage");
      const input = parse(id ? useCaseSchema.partial() : useCaseSchema, raw);
      if (input.status === "published" && input.toolId === null) throw new AppError("VALIDATION_FAILED", "A published use case names its approved tool.");
      const row = await b.tenant(ctx, async (tx) => {
        await b.assertMember(tx, b.org(ctx), input.ownerUserId, "Owner");
        if (input.toolId) {
          const t = (await tx.execute(sql`select status from ai_tools where organization_id = ${b.org(ctx)} and id = ${input.toolId}`)).rows[0] as { status: string } | undefined;
          if (!t) throw notFound("Tool", input.toolId);
          if (input.status === "published" && !["strategic", "approved"].includes(t.status)) throw new AppError("VALIDATION_FAILED", "A published use case must use a Strategic or Approved tool.");
        }
        if (!id) {
          const [dup] = await tx.select({ id: aiUseCases.id }).from(aiUseCases).where(and(eq(aiUseCases.organizationId, b.org(ctx)), eq(aiUseCases.department, input.department!), eq(aiUseCases.title, input.title!))).limit(1);
          if (dup) throw conflict("This department already has a use case with that title.");
          return (await tx.insert(aiUseCases).values({ ...(input as z.output<typeof useCaseSchema>), organizationId: b.org(ctx), createdBy: b.userId(ctx) }).returning())[0]!;
        }
        b.uuidOr404(id, "Use case");
        const [cur] = await tx.select().from(aiUseCases).where(and(eq(aiUseCases.organizationId, b.org(ctx)), eq(aiUseCases.id, id))).limit(1);
        if (!cur) throw notFound("Use case", id);
        if ((input.status ?? cur.status) === "published" && !(input.toolId !== undefined ? input.toolId : cur.toolId)) throw new AppError("VALIDATION_FAILED", "A published use case names its approved tool.");
        const [u] = await tx.update(aiUseCases).set({ ...input, updatedAt: new Date() }).where(eq(aiUseCases.id, id)).returning();
        return u!;
      });
      await b.record(ctx, id ? "ai_ops.use_case_updated" : "ai_ops.use_case_created", "ai_use_case", row.id, { after: input });
      return toUseCaseView(row);
    },
    departments: () => [...DEPARTMENTS],
  };
}

export type People = ReturnType<typeof makePeople>;
