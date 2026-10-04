import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type NavigationModule } from "@eaop/module-registry";
import { SESSION_COOKIE } from "@eaop/security";
import { newCorrelationId } from "@eaop/observability";
import { type TenantContext } from "@eaop/shared-types";
import { getPlatform } from "./platform";

export interface Viewer {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; mfaEnabled: boolean };
  ctx: TenantContext;
  organization: { id: string; name: string; slug: string; environment: string };
  organizations: Array<{ id: string; name: string; slug: string }>;
  permissions: string[];
  navigation: NavigationModule[];
  mfaEnrollmentRequired: boolean;
}

/**
 * Resolve the signed-in viewer for a Server Component. Authorization is still
 * enforced by every service call made with `viewer.ctx`; `permissions` is for
 * UI affordances only.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const h = await headers();
  const platform = await getPlatform();
  const meta = {
    correlationId: newCorrelationId(),
    ip: h.get("x-forwarded-for")?.split(",").pop()?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
  const resolved = await platform.auth.resolve(token, meta).catch(() => null);
  if (!resolved?.tenant) return null;
  const ctx = resolved.tenant;
  const [orgs, permissions, navigation] = await Promise.all([
    platform.organizations.listForUser(resolved.user.id),
    platform.rbac.authorizer.list(ctx),
    platform.modules.navigation(ctx),
  ]);
  const org = orgs.find((o) => o.id === ctx.organizationId)!;
  return {
    user: { id: resolved.user.id, email: resolved.user.email, name: resolved.user.name, isPlatformAdmin: resolved.user.isPlatformAdmin, mfaEnabled: resolved.user.mfaEnabled },
    ctx,
    organization: { id: org.id, name: org.name, slug: org.slug, environment: org.environment },
    organizations: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
    permissions,
    navigation,
    mfaEnrollmentRequired: resolved.mfaEnrollmentRequired,
  };
});

export async function requireViewer(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) redirect("/login");
  return v;
}

/** Server-side page guard. Renders the Forbidden state rather than leaking existence. */
export function can(viewer: Viewer, permission: string) {
  return viewer.permissions.includes(permission);
}
