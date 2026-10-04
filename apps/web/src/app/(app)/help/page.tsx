import { Card, CardBody, CardHeader, PageHeader } from "@eaop/design-system";

export const metadata = { title: "Help" };

const DOCS = [
  ["Architecture", "ARCHITECTURE.md", "How the shared core and modules fit together."],
  ["Module system", "MODULE-SYSTEM.md", "The contract every module follows."],
  ["Authentication", "AUTHENTICATION.md", "Sessions, MFA, SSO and API keys."],
  ["Roles & permissions", "RBAC.md", "System roles, custom roles and scopes."],
  ["Connectors", "CONNECTORS.md", "Connecting enterprise systems and credentials."],
  ["AI providers", "AI-PROVIDERS.md", "Models, routing, policies and cost."],
  ["Security", "SECURITY.md", "Controls and how they are implemented."],
  ["Audit", "AUDIT.md", "What is recorded and how to query it."],
  ["Developer guide", "DEVELOPER-GUIDE.md", "API conventions and extension points."],
] as const;

export default function Page() {
  return (
    <div className="space-y-6">
      <PageHeader title="Help & documentation" description="Platform documentation lives with the source in platform/docs." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {DOCS.map(([title, file, desc]) => (
          <Card key={file}>
            <CardHeader title={title} />
            <CardBody className="space-y-1 text-sm"><p className="text-muted">{desc}</p><code className="font-mono text-xs">platform/docs/{file}</code></CardBody>
          </Card>
        ))}
      </div>
      <p className="text-sm text-muted">API: all endpoints are under <code className="font-mono">/api/v1</code> and return <code className="font-mono">{"{ data }"}</code> or <code className="font-mono">{"{ error: { code, message, requestId } }"}</code>. Include the request id when contacting support.</p>
    </div>
  );
}
