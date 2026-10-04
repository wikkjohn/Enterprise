import { notFound } from "next/navigation";
import { NotInstalledState, PageHeader } from "@eaop/design-system";
import { ActionButton } from "@/components/actions";
import { getPlatform } from "@/lib/platform";
import { can, requireViewer } from "@/lib/viewer";

/**
 * Catch-all for module routes. Installed modules replace this with their own
 * route segment (apps/web/src/app/(app)/m/<module>/...), which takes precedence.
 */
export default async function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module: slug } = await params;
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const manifest = platform.moduleRegistry.list().find((m) => m.basePath === `/m/${slug}`);
  if (!manifest) notFound();
  const nav = viewer.navigation.find((m) => m.id === manifest.id);

  if (manifest.installStatus !== "installed") {
    return (
      <div className="space-y-6">
        <PageHeader title={manifest.name} description={manifest.description} />
        <NotInstalledState
          moduleName={manifest.name}
          description="This module is not yet installed on this platform. Its identity, permissions and navigation are reserved in the module registry; it will appear here once installed and enabled for your organization."
        />
      </div>
    );
  }
  if (nav?.state !== "enabled") {
    return (
      <div className="space-y-6">
        <PageHeader title={manifest.name} description={manifest.description} />
        <NotInstalledState
          moduleName={manifest.name}
          title="Not enabled for your organization"
          description="An organization administrator can enable this module from Administration → Modules."
          action={can(viewer, "module.manage") ? <ActionButton path={`/modules/${manifest.id}/enable`} success={`${manifest.name} enabled`}>Enable module</ActionButton> : undefined}
        />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader title={manifest.name} description={manifest.description} />
      <NotInstalledState moduleName={manifest.name} title="Module UI not provided" description="This module is enabled but has not registered pages in the web app yet." />
    </div>
  );
}
