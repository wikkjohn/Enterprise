import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.mfaEnrollmentRequired) redirect("/mfa/enroll");
  return (
    <AppShell
      viewer={{
        user: { id: viewer.user.id, name: viewer.user.name, email: viewer.user.email, isPlatformAdmin: viewer.user.isPlatformAdmin },
        organization: viewer.organization,
        organizations: viewer.organizations,
        permissions: viewer.permissions,
        navigation: viewer.navigation,
      }}
    >
      {children}
    </AppShell>
  );
}
