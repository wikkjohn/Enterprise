import { Activity, BarChart3, Bot, Building2, FileClock, KeyRound, Lock, LayoutGrid, Plug, ScrollText, Shield, Sparkles, Users, Webhook, type LucideIcon } from "lucide-react";

/**
 * Core admin areas (shared by the shell and the /admin overview). Each entry is
 * shown only with its permission; the page and API enforce it again server-side.
 * Kept out of "use client" modules so Server Components can import it.
 */
export const ADMIN_NAV: Array<{ href: string; label: string; icon: LucideIcon; permission: string }> = [

  { href: "/admin/organization", label: "Organization", icon: Building2, permission: "org.manage" },
  { href: "/admin/users", label: "Users", icon: Users, permission: "user.read" },
  { href: "/admin/roles", label: "Roles & permissions", icon: Shield, permission: "role.read" },
  { href: "/admin/modules", label: "Modules", icon: LayoutGrid, permission: "module.read" },
  { href: "/admin/connectors", label: "Connectors", icon: Plug, permission: "connector.read" },
  { href: "/admin/ai-providers", label: "AI providers", icon: Sparkles, permission: "ai.provider.read" },
  { href: "/admin/ai-runs", label: "AI runs", icon: Bot, permission: "ai.run.read" },
  { href: "/admin/policies", label: "Policies", icon: ScrollText, permission: "policy.read" },
  { href: "/admin/audit", label: "Audit log", icon: FileClock, permission: "audit.read" },
  { href: "/admin/webhooks", label: "Webhooks & events", icon: Webhook, permission: "notification.manage" },
  { href: "/admin/security", label: "Security", icon: Lock, permission: "org.security.read" },
  { href: "/admin/usage", label: "Usage", icon: BarChart3, permission: "usage.read" },
  { href: "/admin/api-keys", label: "API access", icon: KeyRound, permission: "apikey.read" },
  { href: "/admin/health", label: "System health", icon: Activity, permission: "observability.read" },
];
