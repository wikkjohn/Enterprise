# AI Data Security

The security layer between enterprise data and enterprise AI. Module id `data_security`, route prefix `/m/data-security`, package `modules/data-security`.

It answers one question: **can this company's data safely be used with AI?** It does this by combining data discovery, classification, permission analysis, AI exposure assessment, shadow AI visibility, AI DLP, remediation and incident management.

```
SHARED CONNECTORS / INGESTION API → CLASSIFY (in memory) → PERMISSION + AI-EXPOSURE FINDINGS → REMEDIATION
PLATFORM AI LAYER (policy hook) / ENFORCEMENT API → DETECT → DLP ACTIONS + ai_dlp POLICIES → ALLOW | REDACT | REQUIRE_APPROVAL | BLOCK → INCIDENTS
TELEMETRY (proxy / CASB / SSO) → SHADOW AI INVENTORY → RISK → TOOL STATUS → DLP
```

The module reuses the shared core and builds none of these itself:

| Need | Shared service |
|---|---|
| Discovery | `platform.connectors` (shared credentials, rate limits, SSRF guard, audit) |
| Scanning AI requests | `platform.ai.registerPolicyHook("data_security", …)`: every platform AI call is checked before it reaches a provider |
| Rules | `platform.policies`: new policy kind `ai_dlp` |
| Tokenization and fingerprint key | `platform.secrets` (one key per organization) |
| Audit / events / notifications / jobs / usage / search | shared services |
| Retention | Organization `dataRetention.aiPromptRetention` and `aiRunDays` |

## Enabling it for an organization

1. Deploy: `pnpm db:migrate` applies `modules/data-security/migrations/0001_data_security.sql`, which creates 15 tables with RLS forced.
2. Enable the module. Either:
   - use **Administration → Modules → AI Data Security**, or
   - call `POST /api/v1/modules/data_security/enable`.

   From then on, every platform AI request in the organization passes through DLP.
3. Grant roles. `org_admin` has everything. The defaults are:

   | Role | Grants |
   |---|---|
   | `security_admin` | all eight permissions |
   | `ai_admin` | read, scan, incident.read, shadow_ai.read |
   | `auditor` | read, incident.read, shadow_ai.read |
   | `department_leader` | read, shadow_ai.read |

4. Discover data. Choose any of:
   - **Data assets → Run discovery scan** on a shared connector.
   - Push inventory from your own collectors with `POST /api/v1/m/data-security/assets/ingest`.
5. Review **Classifications** (optional):
   - set per-category DLP actions;
   - add custom classifications;
   - set privacy and threshold settings.
   - Add organization `ai_dlp` policies under **Administration → Policies**.
6. Connect a telemetry source for shadow AI: `POST /api/v1/m/data-security/shadow-ai/telemetry`. Use an API key with `data_security.scan`.
7. Point external enforcement points at `POST /api/v1/m/data-security/dlp/evaluate`. These are a browser extension, a forward proxy or an AI gateway.

## Permissions

| Key | Allows |
|---|---|
| `data_security.read` | Inventory, classifications, findings, remediation, dashboard; the detection tester |
| `data_security.scan` | Run scans, ingest inventory and telemetry, call the DLP evaluation API |
| `data_security.classification.manage` | Custom classifications, per-category DLP actions, review classifications, change an asset's classification |
| `data_security.policy.manage` | Approve or reject AI data transfers, AI tool status, module settings |
| `data_security.incident.read` | Incidents and DLP events |
| `data_security.incident.manage` | Open, assign, investigate and resolve incidents |
| `data_security.remediation.manage` | Complete or dismiss remediation; resolve or accept findings |
| `data_security.shadow_ai.read` | Shadow AI inventory and usage |

## Data asset inventory

Each `data_assets` row tracks:

- **Identity:** name, source system, type, location.
- **Ownership:** owner (a platform user when the email matches a member; otherwise a label), department.
- **Sensitivity:** classification (`public`, `internal`, `confidential`, `restricted`), categories.
- **Access:** permissions and the sharing scope (`private`, `specific`, `group`, `organization`, `public`).
- **Lifecycle:** last modified, last accessed, retention category.
- **AI exposure status:** `none`, `potential` or `observed`.

Every metadata or classification change creates a version in `data_asset_versions`.

**Discovery sources:**

| Source | How |
|---|---|
| Sandbox connector | `files.list` returns **SIMULATED** files with synthetic sensitive values, for demos and tests |
| Custom APIs | A shared `rest_api` connector. The scan calls `GET <path>` and expects `{ "assets": [...] }` in the ingestion format |
| Microsoft 365 (SharePoint, OneDrive, Teams), Google Drive, Box, Dropbox, Slack, Salesforce, databases, cloud storage | Their shared connector definitions exist, but discovery adapters do not ship yet. A scan fails with a message pointing to the ingestion API. Push their inventory from your collector meanwhile. |

**Ingestion format** (`POST /assets/ingest`, up to 500 assets per call):

```json
{ "sourceSystem": "google_workspace", "assets": [{
  "externalId": "doc-1", "name": "Customer list.xlsx", "type": "spreadsheet", "location": "/Shared drives/Sales",
  "owner": "jane@acme.com", "department": "Sales", "lastModifiedAt": "2026-10-01T10:00:00Z", "lastAccessedAt": "2026-10-05T09:00:00Z",
  "retentionCategory": "standard",
  "permissions": { "scope": "organization", "publicLink": false, "principals": [
    { "type": "group", "name": "Everyone", "memberCount": 2400, "inherited": true },
    { "type": "user", "email": "old@acme.com", "status": "departed" } ] },
  "content": "optional text sample — classified in memory and discarded"
}] }
```

## Classification

The detectors live in `src/detect.ts`. They are pure and deterministic, and every match carries a confidence and a basis.

| Category | Detects (examples of the basis) |
|---|---|
| `pii` | SSN (area/group/serial rules; unformatted only next to an SSN keyword), date of birth with keyword. Email addresses and phone numbers are low confidence and never raise sensitivity on their own. |
| `financial` | Payment cards (issuer prefix, length and **Luhn**), IBAN (**mod-97**), ABA routing numbers (**checksum** plus keyword), bank account numbers with keyword |
| `credentials` | AWS key ID and secret, GitHub, Slack, Stripe, Google API, AI-provider (`sk-…`) and platform (`eaop_…`) keys, PEM private keys, JWTs, URLs with embedded passwords, secret-named assignments. Placeholders (`****`, `<…>`, `${…}`, `changeme`, `process.env.X`) are ignored. |
| `customer_records` | Customer, client or member identifiers with keyword |
| `employee` | Payroll tables (header with payroll columns), HR/compensation terms, employee IDs |
| `source_code` | Proportion of code-shaped lines, a shebang or a source file name |
| `contracts` | Distinct contract phrases ("this agreement", "governing law", "indemnify"…) |
| `trade_secrets` | Confidentiality and trade-secret markings |
| `health` | Clinical terms plus ICD-10 codes |
| `regulated` | HIPAA, PCI DSS, GDPR, ITAR/EAR, CUI, FERPA, SOX, GLBA, MNPI markings |
| custom | The organization's regular expressions and keywords. Patterns are validated: no nested quantifiers, no backreferences, nothing that matches the empty string, 200 characters at most. |

**What gets recorded:** each `data_classifications` row stores the category, sensitivity, detection method (`pattern`, `checksum`, `keyword`, `heuristic`, `custom` or `manual`), detectors, confidence, the **confidence basis**, the match count and the review status.

**Raw values are never stored.**

**Asset classification:** the highest sensitivity among categories at medium or high confidence. Rejected classifications are excluded. A reviewer can:

- confirm or reject each classification, or
- set and lock the asset's level; scans then stop changing it.

## Permission exposure

`src/analysis.ts` turns permission metadata into findings, ranked by severity and then by data sensitivity:

| Finding | Trigger |
|---|---|
| `public_link` | Public scope, a public link, or a link principal |
| `organization_wide` | Organization scope or a domain principal |
| `overly_broad_group` | A group at or above the broad-group size (default 500), or named Everyone, All Users, Domain Users… |
| `departed_user` | A principal marked departed or disabled, or an email matching a suspended or removed member |
| `stale_user` | A principal inactive for more than 90 days |
| `inherited_access` | Inherited group or domain access on sensitive data |
| `sensitive_broad_access` | Confidential or restricted content with any broad access |
| `no_owner` | Sensitive asset with no owner |

Rescans update findings in place. A finding no longer observed is resolved automatically, and resolved findings re-open if they come back.

## AI exposure

`ai_exposure_findings` records exposure to six destination types: approved AI, unapproved AI, enterprise copilots, agents, external model APIs and employee AI tools. A finding is one of two kinds:

- **Inferred** from sharing. A public link exposes the asset to external model APIs and unapproved AI. Organization-wide sharing in a collaboration suite exposes it to enterprise copilots.
- **Observed** when a DLP check references the asset (`assetIds`). The type follows the destination: agent caller, copilot, model API, approved, or employee tool.

## Shadow AI

**Inventory:** `shadow_ai_tools` lists:

- vendor, tool, category and domains
- status: `approved`, `experimental`, `unknown`, `restricted` or `blocked`
- user population over 90 days, departments, data categories
- an explainable risk score from status, data categories and user population

**Usage records:** `shadow_ai_usage` stores events from telemetry. A user identity that is not a platform member is stored as an HMAC fingerprint, never raw.

**Where tools come from:**

- telemetry events matched against a catalog of 18 public AI services by domain;
- events the telemetry source itself flags as AI (`ai: true`);
- DLP checks against external destinations;
- tools added by hand;
- the platform's own AI providers, recorded as approved.

**Visibility limits.** Without telemetry the UI says so explicitly: the module can only see tools reached through DLP checks or added by hand. Non-AI domains in telemetry are discarded.

**Incidents from telemetry:** when telemetry reports sensitive categories going to a non-approved tool, the module opens an `unauthorized_ai` incident. If the categories are restricted, it opens `restricted_data_access` instead.

## AI DLP

Every request to `platform.ai.execute` passes the `data_security` policy hook. External enforcement points call `POST /dlp/evaluate`.

### How a decision is made

The order is in `src/dlp.ts` plus the service. The strictest outcome wins: ALLOW < REDACT < REQUIRE_APPROVAL < BLOCK.

1. **Detect** across the system prompt and every message.
2. **Destination trust.**
   - Blocked tools: BLOCK everything.
   - Restricted tools: any sensitive content needs approval.
   - Platform AI providers are `approved`.
3. **Per-category action.** Each category has an action for *approved* destinations and one for *unapproved* destinations, applied at a minimum confidence. Organizations can override them.

   | Category | Approved AI | Unapproved AI |
   |---|---|---|
   | credentials | block | block |
   | pii | redact | redact |
   | financial | redact | block |
   | customer_records | redact | block |
   | employee | approval | block |
   | source_code | allow | block |
   | contracts | allow | approval |
   | trade_secrets | approval | block |
   | health | redact | block |
   | regulated | approval | block |
   | custom | redact | block |

   A REDACT category detected only as a whole-document signal cannot be cut out, so it becomes REQUIRE_APPROVAL.
4. **Organization `ai_dlp` policies** run on the shared engine and can only tighten: DENY → BLOCK; REQUIRE_APPROVAL or ESCALATE → approval.

   Attributes:
   - `context.categories`, `context.counts`, `context.sensitivity`, `context.chars`, `context.moduleId`, `context.source`
   - `resource.id` (the destination), `resource.attributes.trust`, `resource.attributes.category`
   - `subject.*`
5. **Large exports** at or above the threshold (default 100 000 characters) to non-approved destinations need approval.

### What happens for each decision

| Decision | In the AI layer | From `/dlp/evaluate` |
|---|---|---|
| ALLOW | Request passes unchanged | Content returned unchanged |
| REDACT | The provider receives the redacted request | Redacted content returned |
| REQUIRE_APPROVAL | `APPROVAL_REQUIRED` | `approvalRequestId` returned |
| BLOCK | `POLICY_DENIED` | `content: null` |

**Approval:** a person with `data_security.policy.manage` decides, and can never approve their own request. An approval lets the same caller send exactly the same content (matched by HMAC fingerprint) to the same destination **once within 24 hours**. Requests expire after 7 days.

### Redaction (`src/redact.ts`)

There are three modes:

- **Mask:** `***-**-6789`, `••••1111`, `j***@domain`. Secrets are always fully masked.
- **Tokenize:** `[SSN:tok_…]`. Uses HMAC-SHA256 with the organization's key from the secret store, so it is consistent within the organization, different across organizations, and not reversible. No lookup table is stored.
- **Label:** `[SSN]`.

Every redaction writes a `redaction_events` row with counts, modes and an output fingerprint.

## Privacy

What is stored:

- metadata;
- HMAC fingerprints, never raw hashes of short values, which could be brute-forced;
- classification results;
- event references.

No table stores raw sensitive content:

- **Content samples** sent to discovery are classified in memory and discarded.
- **DLP events** keep the detection summary and, if the organization allows it, a short **label-redacted preview**. The preview requires two things: the module's content retention is `redacted_preview`, and the organization's AI prompt retention is not `none`.
- **Whole-document sensitive content** (payroll tables, clinical notes, source code) cannot be redacted safely, so its preview is withheld.
- **Blocked or held AI requests** are recorded in the shared run log as a fully label-redacted copy, even under `full` prompt retention. This uses a new option for AI policy hooks.
- **Old data** is purged daily by the `data_security.retention` job: DLP events and telemetry older than `aiRunDays`.

## Incidents

`security_incidents` and `incident_events` are opened automatically for these cases:

| Kind | When |
|---|---|
| `credential_exposure` | Credentials in AI-bound content (high when blocked, critical otherwise) |
| `unauthorized_ai` | Confidential or restricted data sent or attempted to a non-approved destination, or reported by telemetry |
| `large_ai_export` | A large export with sensitive data, or to a non-approved destination |
| `restricted_data_access` | Telemetry reports restricted data in a non-approved tool |
| `abnormal_ai_activity` | One caller is blocked at least N times in an hour (default 5) |
| `policy_violation` | An `ai_dlp` policy denied |

**Fields:**

- severity, status (`open`, `investigating`, `contained`, `resolved`), owner, source
- affected assets and users
- timeline, root cause, resolution, remediation

**Handling:**

- Repeats within 24 hours (same kind, caller and destination) append evidence to the open incident instead of opening a new one.
- Resolving requires a resolution.
- Changes are written to the shared audit log and to the incident timeline.
- Notifications use the shared notification service.

## Remediation

Each recommendation records its action, how it is executed and its status.

| Action | Execution |
|---|---|
| `assign_owner`, `change_classification`, `block_ai_destination`, `require_approval` (restricts the tool) | **automatic**: applied inside the platform when someone with `data_security.remediation.manage` completes it |
| `remove_broad_sharing`, `restrict_group`, `rotate_credential` | **manual**: the platform **never changes source-system permissions or credentials**. Make the change in the source system, then complete the item here with an attestation note. The next scan verifies it. |

Remediation progress appears on the dashboard. Recommendations are deduplicated per asset, action and principal.

## Security dashboard

The dashboard shows:

- sensitive and exposed-sensitive assets
- shadow AI tools, including how many are not approved
- blocked and redacted transmissions (30 days)
- requests awaiting approval
- open and critical incidents
- permission risks by severity
- remediation progress
- last scan, and whether telemetry is connected
- charts: data by category, and DLP decisions

## Data model

**The 12 specified tables:** `data_assets`, `data_asset_versions`, `data_classifications`, `data_access_findings`, `ai_exposure_findings`, `shadow_ai_tools`, `shadow_ai_usage`, `dlp_events`, `redaction_events`, `security_incidents`, `incident_events`, `remediation_actions`.

**Three supporting tables:**

- `data_security_settings`: per-organization settings and the secret reference for the tokenization key.
- `data_classification_rules`: custom classifications and DLP action overrides.
- `data_scans`.

These reference the shared `organizations`, `users`, `connectors`, policies (by key, in each event's `policies`), secrets and audit events.

## Events

| Type | Payload |
|---|---|
| `security.incident.created` | `incidentId, kind, severity, source` |
| `data_security.asset.classified` | `assetId, classification, categories` |
| `data_security.dlp.blocked` | `dlpEventId, destination, categories` |
| `data_security.dlp.redacted` | `dlpEventId, destination, categories, redactedCount` |
| `data_security.dlp.approval_required` | `dlpEventId, destination, categories` |
| `data_security.shadow_ai.discovered` | `toolId, vendor, name, status` |

**Notification types:** `data_security.incident`, `data_security.dlp_approval`, `data_security.shadow_ai_discovered`.

## HTTP API (`/api/v1/m/data-security`)

| Area | Endpoints |
|---|---|
| Dashboard and settings | `GET dashboard`, `GET/PATCH settings` |
| Assets | `GET assets`, `POST assets/ingest`, `GET assets/:id`, `POST assets/:id/classification` |
| Classification | `POST classifications/:id/review`, `GET/POST rules`, `DELETE rules/:key` |
| Findings | `GET findings`, `POST findings/access/:id`, `POST findings/exposure/:id` |
| Scans | `GET/POST scans` |
| DLP | `POST dlp/evaluate`, `POST dlp/test` (stores nothing), `GET dlp/events`, `POST dlp/events/:id/decision` |
| Shadow AI | `POST shadow-ai/telemetry`, `GET/POST shadow-ai/tools`, `GET shadow-ai/tools/:id`, `POST shadow-ai/tools/:id/status` |
| Incidents | `GET/POST incidents`, `GET/PATCH incidents/:id` |
| Remediation | `GET remediation`, `POST remediation/:id/complete`, `POST remediation/:id/dismiss` |

## Changes to the shared core

- **AI policy hooks receive the caller.** Their input now includes `actor`.
- **Hooks can sanitize what gets logged.** A blocking hook may return a sanitized `request` that the run log persists instead of the original.
- **The sandbox connector gained `files.list`**, which returns simulated files.
- **Connectors can pick up new capabilities.** A capability added to a definition after a connector was created is now listed as disabled, and enabling it creates the row. This was previously impossible.

## Known limitations

- **Two discovery adapters.** Discovery runs through the sandbox and REST connectors only. Other sources depend on the ingestion API until their connector adapters ship.
- **Heuristic detection.** Detection uses deterministic patterns, checksums and heuristics, not ML. Names and free-text personal data are not detected. Document-level categories rely on keywords and can produce false positives; rejecting a classification feeds the asset's sensitivity, not the detectors.
- **Limited shadow AI visibility.** Shadow AI only sees what telemetry integrations report. Data categories in telemetry are taken as reported by the source.
- **Partial enforcement coverage.** DLP covers the platform AI layer and callers of `/dlp/evaluate`. AI traffic that bypasses both is invisible.
- **Inferred exposure is an inference.** It does not prove an AI system has read the asset.
- **No automatic source-system changes.** Source-system permission changes are never automated (by design), and there are no write adapters for them yet.
