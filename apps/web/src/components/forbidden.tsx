import { ShieldAlert } from "lucide-react";
import { EmptyState } from "@eaop/design-system";

/** Shown when the viewer lacks a page's permission. The API enforces the same check. */
export function Forbidden({ permission }: { permission: string }) {
  return (
    <EmptyState
      icon={<ShieldAlert className="size-6" />}
      title="You don't have access to this page"
      description={`It requires the "${permission}" permission. Ask an organization administrator if you need it.`}
    />
  );
}
