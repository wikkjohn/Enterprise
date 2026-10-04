"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Bell, BookCheck, Cable, CircleHelp, Gauge, Home, LayoutGrid, Lock, LogOut, Network,
  Search, Settings, ShieldCheck, Workflow, type LucideIcon,
} from "lucide-react";
import {
  Avatar, Badge, buttonClasses, CommandPalette, DropdownMenu, IconButton, useHotkey, NavItem, NavSection, Select, ToastProvider, cn, type CommandItem,
} from "@eaop/design-system";
import { type NavigationModule } from "@eaop/module-registry";
import { apiFetch } from "@/lib/client";
import { ADMIN_NAV } from "@/lib/admin-nav";
import { renderLink } from "./link";

const MODULE_ICONS: Record<string, LucideIcon> = { Workflow, Cable, ShieldCheck, Lock, BookCheck, Gauge };

export interface ShellViewer {
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean };
  organization: { id: string; name: string; environment: string };
  organizations: Array<{ id: string; name: string }>;
  permissions: string[];
  navigation: NavigationModule[];
}

export function AppShell({ viewer, children }: { viewer: ShellViewer; children: ReactNode }) {
  return (
    <ToastProvider>
      <Shell viewer={viewer}>{children}</Shell>
    </ToastProvider>
  );
}

function Shell({ viewer, children }: { viewer: ShellViewer; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const has = (p: string) => viewer.permissions.includes(p);
  const adminItems = ADMIN_NAV.filter((i) => has(i.permission));
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

  useEffect(() => {
    let alive = true;
    const load = () => apiFetch<{ count: number }>("/notifications/unread-count").then((r) => alive && setUnread(r.count)).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);
  useHotkey("k", () => setPaletteOpen(true));

  const switchOrg = async (organizationId: string) => {
    await apiFetch("/auth/switch-organization", { body: { organizationId } });
    router.push("/");
    router.refresh();
  };
  const logout = async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };

  const staticItems: CommandItem[] = [
    { id: "nav-home", label: "Home", group: "Navigate", href: "/" },
    ...viewer.navigation.filter((m) => m.state === "enabled").map((m) => ({ id: `mod-${m.id}`, label: m.name, group: "Modules", href: m.basePath })),
    ...adminItems.map((i) => ({ id: `adm-${i.href}`, label: i.label, group: "Administration", href: i.href })),
    { id: "nav-profile", label: "Profile & security", group: "Account", href: "/settings/profile" },
    { id: "nav-notifications", label: "Notifications", group: "Account", href: "/notifications" },
  ];
  const remoteSearch = useCallback(async (q: string, signal: AbortSignal): Promise<CommandItem[]> => {
    if (q.trim().length < 2 || !has("search.use")) return [];
    const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}`, { signal, credentials: "same-origin" });
    if (!res.ok) return [];
    const json = (await res.json()) as { data: { hits: Array<{ resourceType: string; id: string; title: string; subtitle?: string; url: string }> } };
    return json.data.hits.map((h) => ({ id: `${h.resourceType}:${h.id}`, label: h.title, hint: h.subtitle, group: `Search · ${h.resourceType}`, href: h.url }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sidebar = (
    <nav aria-label="Primary" className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-4">
      <NavSection>
        <NavItem href="/" label="Home" icon={<Home className="size-4" />} active={isActive("/")} renderLink={renderLink} />
      </NavSection>
      <NavSection title="Applications">
        {viewer.navigation.map((m) => {
          const Icon = MODULE_ICONS[m.icon] ?? LayoutGrid;
          return (
            <NavItem
              key={m.id}
              href={m.basePath}
              label={m.shortName}
              icon={<Icon className="size-4" />}
              active={isActive(m.basePath)}
              badge={m.state === "enabled" ? undefined : <Badge tone="neutral">{m.state === "not_installed" ? "Soon" : "Off"}</Badge>}
              renderLink={renderLink}
            />
          );
        })}
      </NavSection>
      {adminItems.length > 0 && (
        <NavSection title="Administration">
          {adminItems.map((i) => (
            <NavItem key={i.href} href={i.href} label={i.label} icon={<i.icon className="size-4" />} active={isActive(i.href)} renderLink={renderLink} />
          ))}
        </NavSection>
      )}
      {viewer.user.isPlatformAdmin && (
        <NavSection title="Platform">
          <NavItem href="/platform" label="Organizations" icon={<Network className="size-4" />} active={isActive("/platform")} renderLink={renderLink} />
        </NavSection>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="grid size-7 place-items-center rounded-md bg-accent text-xs font-semibold text-accent-fg" aria-hidden>
            AI
          </div>
          <span className="text-sm font-semibold">Enterprise AI Platform</span>
        </div>
        {sidebar}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-overlay" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-72 bg-surface shadow-overlay">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 sm:gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur">
          <IconButton className="lg:hidden" label="Open navigation" icon={<LayoutGrid className="size-4" />} onClick={() => setMobileOpen(true)} />
          {viewer.organizations.length > 1 ? (
            <Select
              aria-label="Switch organization"
              size="sm"
              className="max-w-56"
              value={viewer.organization.id}
              onChange={(e) => void switchOrg(e.target.value)}
              options={viewer.organizations.map((o) => ({ value: o.id, label: o.name }))}
            />
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{viewer.organization.name}</span>
          )}
          {viewer.organization.environment !== "production" && <Badge tone="warning" className="hidden sm:inline-flex">{viewer.organization.environment}</Badge>}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
            className={cn("ml-auto flex h-8 shrink-0 items-center gap-2 rounded-md border border-border bg-background px-2 text-sm text-muted hover:border-border-strong sm:w-72 sm:px-3", "ds-ring")}
          >
            <Search className="size-4" aria-hidden />
            <span className="hidden flex-1 text-left sm:inline">Search…</span>
            <kbd className="hidden rounded border border-border px-1.5 font-mono text-xs sm:inline">⌘K</kbd>
          </button>
          <a href="/notifications" className={cn(buttonClasses({ variant: "ghost", size: "sm" }), "relative px-2")} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
            <Bell className="size-4" aria-hidden />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-danger-fg" aria-hidden>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </a>
          <a href="/help" className={cn(buttonClasses({ variant: "ghost", size: "sm" }), "hidden px-2 sm:inline-flex")} aria-label="Help and documentation">
            <CircleHelp className="size-4" aria-hidden />
          </a>
          <DropdownMenu
            ariaLabel="Account"
            align="end"
            trigger={(props) => (
              <button {...props} className="ds-ring rounded-full" aria-label={`Account menu for ${viewer.user.name}`}>
                <Avatar name={viewer.user.name} size="sm" decorative />
              </button>
            )}
            items={[
              { id: "who", label: viewer.user.email, disabled: true },
              { id: "profile", label: "Profile & security", icon: <Settings className="size-4" />, onSelect: () => router.push("/settings/profile") },
              { id: "logout", label: "Sign out", icon: <LogOut className="size-4" />, tone: "danger", separatorBefore: true, onSelect: () => void logout() },
            ]}
          />
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} items={staticItems} onQueryChange={remoteSearch} onNavigate={(href) => router.push(href)} placeholder="Search people, connectors, policies, pages…" />
    </div>
  );
}
