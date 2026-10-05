import Link from "next/link";
import { Card, CardBody, CardHeader, CodeBlock, PageHeader } from "@eaop/design-system";
import { getPlatform } from "@/lib/platform";
import { ih } from "@/lib/integration";
import { can, requireViewer } from "@/lib/viewer";

export const metadata = { title: "Developers" };

const BASE = "/api/v1/m/integration-hub";

export default async function DevelopersPage() {
  const viewer = await requireViewer();
  const platform = await getPlatform();
  const svc = ih(platform);
  const tools = can(viewer, "integration.execute") ? await svc.listTools(viewer.ctx) : [];
  const schemas = svc.schemas();
  const origin = platform.env.APP_URL.replace(/\/$/, "");
  const curlTools = `curl -s ${origin}${BASE}/tools \\
  -H "Authorization: Bearer $EAOP_API_KEY"`;
  const curlInvoke = `curl -s -X POST ${origin}${BASE}/tools/${tools[0]?.name ?? "crm.lookup"}/invoke \\
  -H "Authorization: Bearer $EAOP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 7f9c2c1e-quote-42" \\
  -d '{ "input": { ... }, "agent": { "id": "quote-bot", "name": "Quote assistant" } }'`;
  const curlRun = `curl -s -X POST ${origin}${BASE}/workflows/<workflowId>/executions \\
  -H "Authorization: Bearer $EAOP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1009" \\
  -d '{ "input": { "customerEmail": "buyer@example.com", "request": "200 units of SKU-9" } }'`;
  const sdk = `// Minimal TypeScript client — the platform has no proprietary SDK; plain fetch is enough.
type ToolResult = { executionId: string; status: string; output: unknown; approvalId: string | null; error: { class: string; message: string } | null };

export async function callTool(name: string, input: Record<string, unknown>, opts: { idempotencyKey?: string; agentId?: string } = {}): Promise<ToolResult> {
  const res = await fetch(\`\${process.env.EAOP_URL}${BASE}/tools/\${encodeURIComponent(name)}/invoke\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${process.env.EAOP_API_KEY}\`,
      "Content-Type": "application/json",
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
    },
    body: JSON.stringify({ input, ...(opts.agentId ? { agent: { id: opts.agentId } } : {}) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(\`\${body.error.code}: \${body.error.message}\`); // VALIDATION_FAILED carries field-level issues
  return body.data;                                                        // status may be "waiting_approval" — poll GET ${BASE}/executions/:id
}`;
  return (
    <div className="space-y-6">
      <PageHeader title="Developers" description="Connect AI applications and agents through the tool gateway, start workflows over the API, and subscribe to integration events." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Authentication" />
          <CardBody className="space-y-2 text-sm text-muted">
            <p>Create a scoped API key under <Link className="text-accent hover:underline" href="/admin/api-keys">Administration → API access</Link>. Give AI callers only <code>integration.execute</code> and <code>integration.connector.use</code> (plus <code>connector.use</code>), and <code>integration.history.read</code> if they poll results.</p>
            <p>The organization always comes from the key — never from the request body. Every call is validated, authorized, policy-checked, approval-gated when required, rate-limited, idempotent where configured, and audited.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="AI tool gateway" description="AI never receives direct access to enterprise systems — only these tools." />
          <CardBody className="space-y-3">
            <CodeBlock code={curlTools} language="bash" />
            <CodeBlock code={curlInvoke} language="bash" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Start a workflow" description="Workflows with an API trigger accept runs from API keys. Live runs return 202 and run on the worker." />
          <CardBody><CodeBlock code={curlRun} language="bash" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="SDK pattern (TypeScript)" />
          <CardBody><CodeBlock code={sdk} language="ts" maxHeight="360px" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Webhooks" />
          <CardBody className="space-y-2 text-sm text-muted">
            <p>Subscribe to <code>integration.execution.completed</code>, <code>integration.execution.failed</code>, <code>integration.approval.required</code> and <code>integration.action.executed</code> under <Link className="text-accent hover:underline" href="/admin/webhooks">Administration → Webhooks &amp; events</Link>. Deliveries are signed and retried by the shared event system.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Test sandbox" />
          <CardBody className="space-y-2 text-sm text-muted">
            <p>Run any workflow with <code>{`"mode": "test"`}</code>. Only the simulated sandbox connector is really called; every other action is validated and dry-run, approvals and delays are skipped, and results are labelled test. In non-production environments, <em>Workflows → Sample workflow</em> builds a complete customer-quote flow on the sandbox connector.</p>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader title="Endpoints" />
        <CardBody>
          <CodeBlock language="text" code={[
            `GET    ${BASE}/tools                         integration.execute`,
            `POST   ${BASE}/tools/:name/invoke            integration.execute + integration.connector.use`,
            `GET    ${BASE}/actions                       integration.read`,
            `POST   ${BASE}/actions                       integration.manage   (install a template)`,
            `POST   ${BASE}/actions/custom                integration.admin    (custom action builder)`,
            `GET    ${BASE}/workflows | /:id              integration.read`,
            `PUT    ${BASE}/workflows/:id/graph           integration.create`,
            `POST   ${BASE}/workflows/:id/publish         integration.manage`,
            `POST   ${BASE}/workflows/:id/executions      integration.execute  (Idempotency-Key supported)`,
            `GET    ${BASE}/executions | /:id             integration.history.read`,
            `POST   ${BASE}/executions/:id/cancel|retry   integration.execute | integration.manage`,
            `GET    ${BASE}/approvals                     integration.read`,
            `POST   ${BASE}/approvals/:id/decision        integration.approve`,
            `GET    ${BASE}/errors?status=dead_letter     integration.history.read`,
            `GET    ${BASE}/schemas                       integration.read`,
          ].join("\n")} />
        </CardBody>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={`Your tools (${tools.length})`} description="Exactly what an AI caller with your permissions receives from GET /tools." />
          <CardBody><CodeBlock code={JSON.stringify(tools, null, 2)} language="json" maxHeight="420px" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Schema registry" description="Node types, edge kinds, transforms, error classes and action templates." />
          <CardBody><CodeBlock code={JSON.stringify(schemas, null, 2)} language="json" maxHeight="420px" /></CardBody>
        </Card>
      </div>
    </div>
  );
}
