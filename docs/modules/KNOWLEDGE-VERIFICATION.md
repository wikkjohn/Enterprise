# AI Knowledge & Verification

The trusted knowledge layer for enterprise AI. Module id `knowledge_verification`, route prefix `/m/knowledge-verification`, package `modules/knowledge-verification`.

This is **not** a "chat with your documents" tool. Its job is to make sure that any AI answer in the platform:

- comes only from approved documents the asker may read;
- cites them;
- says how authoritative and current they are;
- flags claims the sources do not support; and
- explains its confidence in plain terms.

The other modules use it through a stable, permission-aware API.

```
QUERY → IDENTITY → PERMISSION FILTER → RETRIEVAL → SOURCE RANKING → GENERATION
      → CLAIM EXTRACTION → VERIFICATION → CONFIDENCE → CITED RESPONSE (+ expert escalation)
```

The module builds none of the shared infrastructure itself:

| Need | Shared service |
|---|---|
| Identity, roles, departments | Memberships and roles from `platform.rbac` / `platform.organizations` become retrieval principals |
| Pulling documents | `platform.connectors`: shared credentials, rate limits, SSRF guard and audit, with no separate connector auth |
| Answer generation | `platform.ai.execute` (moduleId `knowledge_verification`, use case `knowledge.answer`). Model policies, budgets, approvals and Data Security DLP all apply |
| Audit, events, notifications, jobs, usage, global search | Shared services |
| Retention | Organization `dataRetention.aiPromptRetention` and `aiRunDays` |

## Enabling it for an organization

1. **Deploy.** Run `pnpm db:migrate`. It applies `modules/knowledge-verification/migrations/0001_knowledge_verification.sql`, which creates 14 tables with RLS forced.
2. **Enable.** Use **Administration → Modules → AI Knowledge & Verification**, or `POST /api/v1/modules/knowledge_verification/enable`.
3. **Create sources** (**Sources → New source**). Each source sets:
   - the default authority;
   - the default classification;
   - the default access (principals, see below);
   - the owner;
   - an optional stale threshold.
4. **Add documents.** Any of these work:
   - upload files on **Documents → Add document**;
   - push documents with `POST /api/v1/m/knowledge-verification/documents`, using an API key with `knowledge.ingest`;
   - for a connector source, click **Sync**.
5. **Optional: configure expert escalation** under **Settings**. Set categories, keywords and named experts. With no named experts, reviewers are notified instead.
6. **Grant roles.** `org_admin` has every permission. The defaults are:

   | Role | Grants |
   |---|---|
   | `ai_admin` | read, search, ingest, manage, source.manage, verification.read, admin |
   | `security_admin` | read, search, verification.read, conflict.review |
   | `department_leader` | read, search, ingest, conflict.review, verification.read |
   | `analyst` | read, search, ingest |
   | `standard_user` | read, search |
   | `read_only` | read |
   | `auditor` | read, verification.read |

## Permissions

| Permission | Allows |
|---|---|
| `knowledge.read` | Open the module and list or read the documents you may access |
| `knowledge.search` | Ask questions and retrieve passages (only from documents you may access) |
| `knowledge.ingest` | Upload documents and new versions; trigger connector syncs |
| `knowledge.manage` | Edit document metadata and authority; mark documents reviewed; see every document in lists; work the freshness queues |
| `knowledge.source.manage` | Create and configure sources; set document access |
| `knowledge.conflict.review` | Review duplicates and contradictions; answer expert escalations |
| `knowledge.verification.read` | See every question in the organization and its verification, and analytics |
| `knowledge.admin` | Settings: staleness, question retention, escalation categories, the search index |

`knowledge.manage` never widens **retrieval**. What an answer may use is decided only by the document's access principals. An administrator outside HR does not get HR documents in their answers.

## Document access (permission-aware retrieval)

Every document has one row in `knowledge_permissions_metadata`. It holds a list of **principals**:

| Principal | Matches |
|---|---|
| `org:*` | Every active member of the organization |
| `user:<id>` | One member |
| `role:<key>` | Members holding that role (system or custom role key) |
| `dept:<name>` | Members whose membership department matches (case-insensitive) |
| `api_key:<id>`, `agent:<id>` | That API key or agent identity |

A caller's principals come from their **active** membership. Their user ID, their role keys, their department and `org:*` are each a principal. A non-member gets no principals and sees nothing.

Where a document's access comes from, in order of precedence:

1. **`explicit`.** Set on the document by someone with `knowledge.source.manage`. Re-ingestion never overwrites it.
2. **`source_acl`.** The source system's permissions, mapped to principals at ingest:
   - users are matched by email;
   - groups named "Everyone" or "All staff" become `org:*`;
   - other groups match a role key or a department;
   - domain and link sharing become `org:*`.

   Entries that cannot be mapped are kept as **unmapped** and grant nothing (fail closed). The document page lists them.
3. **`source_default`.** The source's default principals. The document follows them when the source changes.

The document owner is always added.

**Enforcement happens before any text reaches a model, in two independent places:**

1. **Inside the index provider.** Its `search` filters on `principals && caller_principals`, active status, current version and not expired.
2. **In the service.** Every returned chunk is re-loaded and checked against the database ACL, status, version and expiry. A provider that returns something it should not (a bug, or a third-party vector store) is logged as `knowledge.index_returned_unauthorized` and dropped.

These rules apply everywhere a document could surface:

- **Answers and citations.** Answers and citations only contain passages that passed both checks.
- **Lists and global search.** Document lists and global search apply the same filter.
- **Stored answers.** Excerpts are shown only while the viewer can still access the document. Another person's answer that drew on documents the viewer cannot access is hidden (text, claims and titles), even from holders of `knowledge.verification.read`.

The integration tests prove this with a capturing AI provider: unauthorized content never appears in the prompt, the answer, the citations or the stored records. Covered cases:

- other departments;
- per-user documents;
- unmapped ACL entries;
- a deliberately leaky index provider;
- other organizations.

## Sources, formats and processing

| Format | Extraction (`src/extract.ts`) |
|---|---|
| TXT, Markdown | As is (BOM stripped) |
| HTML | Tags, scripts and styles removed; headings kept |
| CSV | Each row becomes `header: value; …` so values keep their meaning |
| JSON / structured records | Flattened `path: value` lines |
| DOCX | `word/document.xml` paragraphs; heading styles become section headings; title from `docProps/core.xml` |
| PPTX | One section per slide (`# Slide N: title`) |
| XLSX | Shared strings plus each sheet's rows, with headers |
| PDF | Text operators (`Tj`/`TJ`) from uncompressed and Flate streams. Scanned or image-only PDFs produce a warning: OCR is not available |

Processing steps:

- **Text processing.** Extracted text is normalised, hashed (SHA-256) and chunked: about 900 characters per chunk (at most 1,600), with a 150-character overlap. Chunks break at headings and sentences and carry their section heading.
- **Versioning.** Each content change creates a new **version**. Old versions keep their row in `knowledge_document_versions` (hash, sizes, metadata, change summary), but their chunks are removed. Only the current version is ever retrieved. Re-ingesting identical content is a no-op.
- **Document identity.** A document's identity within its source is its `externalId`. It defaults to the file name, or to the title for pasted text.
- **Tracked metadata.** Each document tracks:
  - source, owner, department and classification;
  - authority (own or inherited);
  - effective and expiration dates, review due date, last modified, last reviewed;
  - version, content hash and ingestion status, with any error or warnings;
  - lineage (superseded by).
- **Failed extraction.** A file that cannot be extracted is stored with `ingestionStatus: failed` and an error. It is never indexed.

**Connector sources** sync in a background job (`knowledge_verification.sync`):

| Connector | How documents are fetched |
|---|---|
| `sandbox` | `files.list` (simulated files, labelled as such) |
| `rest_api` | `GET <path>` returning `{ documents: [...] }` in the document input shape |

Documents no longer present at the source are archived. Other connector types return `NOT_IMPLEMENTED` and push through the documents API instead.

## Index abstraction

Retrieval goes through a `KnowledgeIndexProvider` (`src/indexing.ts`), so the platform is not tied to one search vendor:

```ts
interface KnowledgeIndexProvider {
  key: string;
  description: string;
  indexDocument(tx, { organizationId, documentId, version }): Promise<void>;
  removeDocument(tx, { organizationId, documentId }): Promise<void>;
  search(tx, { organizationId, query, principals, limit }): Promise<Array<{ chunkId: string; relevance: number /* 0–1 */ }>>;
}
```

Every provider must meet this contract:

- `search` applies the principal filter itself.
- `search` excludes non-active, superseded, expired and non-current chunks.
- `search` returns relevance normalised to 0–1.

The service re-checks every result regardless (see above).

The default provider is `postgres_fts`. It uses a generated `tsvector` on `knowledge_chunks` with a GIN index, prefix matching on content terms, and `ts_rank_cd(…, 32)`.

To use another provider (pgvector, OpenSearch, a hosted vector database):

1. Register it with `knowledgeService(platform).registerIndexProvider(p)`.
2. Point the organization's default row in `knowledge_indexes` at it.

## Source authority and ranking

`score = relevance × authority weight × freshness weight`, where:

| Authority | Weight |
|---|---|
| Authoritative | 1.00 |
| Preferred | 0.85 |
| Secondary | 0.60 |
| Deprecated | 0.25 |

- **Freshness weight.** Stale documents score × 0.8. Expired documents are never used.
- **Ties.** Ties go to the newer effective date.
- **Weak matches.** Passages under 30 % of the best match's relevance are dropped, so loosely related text does not enter the context.
- **Context limits.** At most 2 passages per document and 6 in total.
- **Authority source.** A document can set its own authority; otherwise it inherits the source's.

## Duplicates, versions and conflicts

After each ingest, the document is compared with likely related documents. Candidates are those with the same hash or a full-text match on the document's top terms.

| Kind | Rule |
|---|---|
| `duplicate` | Identical content hash |
| `near_duplicate` | MinHash similarity of word shingles ≥ 0.8 |
| `contradiction` | Same-subject sentences (term overlap ≥ 0.5) state different values of the same unit (money, %, days, …), or say the same thing with opposite polarity ("may" / "may not") |
| `newer_version` | Same title, or similarity ≥ 0.5, with a later effective or modified date |

**The platform never decides which of two contradictory documents is correct.** A contradiction opens a conflict review and notifies reviewers (`knowledge.conflict.review`).

Until someone decides:

- both documents stay in use;
- answers citing them get `low` confidence;
- the uncertainty says so.

A reviewer records one decision:

| Decision | Effect |
|---|---|
| `keep_a` / `keep_b` | The other document is **superseded** and leaves retrieval immediately |
| `both_valid` | Records the decision; both documents stay in use |
| `not_a_conflict` | Dismisses the conflict |

Only people can decide; system or API contexts get `FORBIDDEN`. Expired documents are excluded from retrieval as soon as their expiration date passes.

## Answers

Each answer (`AnswerView`) contains:

- the **response** with `[S1]` markers;
- **citations** (every retrieved passage, flagged when cited), each with:
  - title and source;
  - authority and freshness;
  - document date and version;
  - excerpt;
- the **claims** with their verification;
- the **confidence** with its factors;
- an **uncertainty** note;
- an **escalation**, if any.

The model is told to use only the numbered sources, cite every factual sentence, never invent figures, and say so when the sources disagree or do not answer.

When generation is not possible, the answer is **extractive** and labelled as such (`mode: "extractive"` plus a note). It quotes the best-matching source sentences with their markers. This happens when:

- no model is configured;
- the caller lacks `ai.use`;
- a policy or DLP blocks the request or requires approval;
- the provider is the simulated sandbox.

If nothing accessible matches, the response says so, no model is called, and the question counts as unanswered.

## Claim verification

The answer is split into sentences. Questions, hedges and fragments are skipped. A claim is **important** if it contains a quantity or a policy word (must, required, prohibited, …).

Each claim is checked deterministically against the retrieved passages (`src/verify.ts`). Coverage is the fraction of the claim's content terms found in a source sentence.

| Status | Rule |
|---|---|
| `VERIFIED` | A source sentence covers ≥ 0.6 of the claim's terms, with the same figures (and units) and the same polarity |
| `PARTIALLY_VERIFIED` | Related content covers ≥ 0.35 but not all of it, or sources disagree (one supports, another contradicts) |
| `CONTRADICTED` | A same-subject source sentence states different figures of the same unit, or the opposite polarity |
| `UNSUPPORTED` | Nothing retrieved says it |

Each verification explains itself: it quotes the supporting or contradicting sentence and notes a claim that cites the wrong marker or a marker that was never retrieved.

An answer whose important claims include `UNSUPPORTED` or `CONTRADICTED` sets `verificationFailed`. It also emits `knowledge.verification.failed` and is audited.

## Confidence methodology

Confidence is **rule-based and has no percentages**. It reports one of four levels plus six factors. Each factor states its value and whether it raises or lowers confidence.

| Factor | What it looks at |
|---|---|
| Retrieval strength | Best permitted match: strong ≥ 0.5, moderate ≥ 0.2, otherwise weak |
| Source quality | Best authority among sources supporting the claims |
| Supporting sources | Distinct documents supporting the claims |
| Source agreement | Contradicted claims, plus open contradiction or newer-version conflicts on the documents the answer relies on |
| Freshness | Whether any supporting document is stale |
| Claim verification | Verified claims out of all claims; important claims unsupported or contradicted |

| Level | Rule (first match wins) |
|---|---|
| `insufficient` | Nothing retrieved, or no claim could be verified or partially verified |
| `low` | Any of: an important claim is unsupported or contradicted; a relied-on document has an open conflict; the only support is deprecated; or retrieval is weak and fewer than half the claims are verified |
| `high` | All of: every important claim is verified; support comes from an authoritative or preferred source that is not stale; no contradictions or conflicts; retrieval is not weak; and either two or more supporting documents or one authoritative document |
| `medium` | Everything else |

## Human escalation

Questions are matched against **escalation categories**. Each category has a key, a label, keywords, an escalation rule (`low_confidence` or `always`) and named experts.

The defaults are Legal, HR, Finance, Safety (always), Regulatory and Security. Administrators can replace them, or reset them with `escalationCategories: null`.

A matching question that is low or insufficient confidence, or in an `always` category:

- opens an `escalation` review assigned to the first expert;
- notifies the category's experts, or every reviewer if none are named (`knowledge.escalation`, through shared notifications);
- tells the asker in the answer.

When an expert resolves the review with a written answer, the asker is notified.

## Freshness review queues

A document is classified as follows:

| State | Rule |
|---|---|
| **Expired** | Past its expiration date |
| **Stale** | Its review is overdue, or it was neither modified nor reviewed within the stale threshold (source setting, else the organization setting, default 365 days) |
| **No owner** | No accountable member |

The queues are maintained:

- on every ingest or metadata change;
- by a daily `knowledge_verification.freshness` job;
- on demand with **Run freshness scan**.

Reviews that no longer apply are closed automatically. **Mark reviewed** records the review and sets the next due date. The review interval defaults to 365 days.

## Analytics

Analytics cover the last 30 days and need `knowledge.verification.read`:

- question totals and escalations;
- top questions;
- unanswered and low-confidence questions;
- most cited documents;
- the confidence and verification mix;
- document freshness and missing owners;
- open conflicts;
- knowledge gaps (terms recurring in unanswered or low-confidence questions);
- usage by department or calling module.

## Privacy and retention

- **Question text.** Question text and answer text are stored only when the module setting **Store question text** is on and the organization's `aiPromptRetention` is not `none`. They are redacted with the platform redactor. Otherwise only a hash is kept, and claims and explanations are stored without quotes.
- **Retention.** A daily `knowledge_verification.retention` job deletes questions, with their answers, citations and claims, older than the organization's `aiRunDays` (default 365). Questions with an open escalation are kept.
- **Events.** Events carry IDs and counts only, never question text.

## Shared platform API (for other modules)

Other modules call the service directly; they never scrape the UI:

```ts
import { knowledgeApi } from "@eaop/module-knowledge-verification";

const kv = knowledgeApi(platform); // null when not installed
await kv?.retrieve(ctx, { question, onBehalfOfUserId, sourceModule: "agent_governance", limit: 6 }); // passages only
await kv?.ask(ctx, { question, onBehalfOfUserId, sourceModule: "workflow_intelligence" });            // full cited answer
await kv?.documentMetadata(ctx, documentId);                                                           // classification, authority, owner, access
```

- **A user context** gets that user's view.
- **A system context** (another module's job) must pass `onBehalfOfUserId` to get that member's view. Without it, it sees only `org:*` documents.
- **`onBehalfOfUserId` from a non-system caller** is rejected with `FORBIDDEN`.
- **API keys and agents** see `org:*` documents plus documents shared with their own principal.

## Data model

Every table has `organization_id` with RLS forced. The tenant-isolation test covers all of them automatically.

| Table | Purpose |
|---|---|
| `knowledge_settings` | Stale days, review interval, question retention, escalation categories |
| `knowledge_indexes` | Index rows: provider, default, counts, last built |
| `knowledge_sources` | Kind (upload, api, connector), connector, authority, default classification and access, owner, stale days, sync status |
| `knowledge_documents` | Current metadata, status, ingestion status, version, hash, MinHash signature, dates, lineage |
| `knowledge_document_versions` | One row per content version |
| `knowledge_chunks` | Current-version chunks with heading, offsets, hash and the generated `tsv` |
| `knowledge_permissions_metadata` | Mode, raw source ACL, principals (GIN), unmapped entries |
| `knowledge_conflicts` | Document pair, kind, similarity, newer side, evidence, decision |
| `knowledge_queries` | Who asked (actor, user, department, calling module), redacted question or hash, categories, status, latency |
| `knowledge_answers` | Response, mode, AI run, confidence level, factors and summary, uncertainty, escalated |
| `knowledge_citations` | Marker, document, chunk, version, authority, freshness, date, score, cited |
| `knowledge_claims` | Claim text, importance and cited markers |
| `knowledge_verifications` | Status, explanation, supporting and contradicting markers, coverage |
| `knowledge_reviews` | Escalation, conflict, expired, stale, review_due and no_owner reviews (deduplicated) |

## Events

| Type | Payload |
|---|---|
| `knowledge.document.ingested` | `documentId, sourceId, version, chunkCount` |
| `knowledge.document.updated` | Same, for a new version |
| `knowledge.conflict.detected` | `conflictId, kind, documentAId, documentBId` |
| `knowledge.review.required` | `reviewId, kind` |
| `knowledge.answer.generated` | `queryId, answerId, confidence, mode, sources, sourceModule` |
| `knowledge.verification.failed` | `queryId, answerId, unsupported, contradicted` |

Notification types: `knowledge.conflict`, `knowledge.review_required`, `knowledge.escalation`.

## HTTP API (`/api/v1/m/knowledge-verification`)

| Method and path | Permission |
|---|---|
| `POST /ask` (60 per minute) | `knowledge.search` |
| `POST /retrieve` (300 per minute) | `knowledge.search` |
| `GET /queries`, `GET /queries/:id` | `knowledge.search`; everyone's needs `verification.read` |
| `GET /sources`, `POST /sources`, `PATCH /sources/:id` | `read` / `source.manage` |
| `POST /sources/:id/sync` | `knowledge.ingest` |
| `GET /documents`, `GET /documents/:id`, `GET /documents/:id/metadata` | `knowledge.read` (access-filtered) |
| `POST /documents` (bodies up to 30 MB) | `knowledge.ingest` |
| `PATCH /documents/:id`, `POST /documents/:id/review` | `knowledge.manage` |
| `PUT /documents/:id/permissions` | `knowledge.source.manage` |
| `GET /conflicts`, `POST /conflicts/:id/resolve` | `knowledge.conflict.review` (people only) |
| `GET /reviews`, `PATCH /reviews/:id` | `conflict.review` or `manage` |
| `POST /reviews/scan` | `knowledge.manage` |
| `GET /analytics` | `knowledge.verification.read` |
| `GET /settings`, `PATCH /settings`, `GET /indexes` | `read` / `admin` |

The document input takes:

- `sourceId`;
- `title` (optional for files);
- `filename`, `format` or `mimeType`;
- the content, as exactly one of `text`, `contentBase64` or `record`;
- optional metadata: `externalId`, `owner` (email), `department`, `classification`, `authority`, `effectiveDate`, `expirationDate`, `reviewDueAt`, `lastModifiedAt`;
- optional `permissions` (`{ scope, principals: [{ type, id | name | email }] }`, the source ACL).

## Changes to the shared core

- **Per-route body limit.** `route()` accepts `maxBodyBytes`, which overrides the 2 MB request body limit up to 32 MB. The documents upload route uses 30 MB.

## Known limitations

- **Lexical retrieval.** The default index is full-text search, not semantic search. Paraphrased questions with no shared terms can miss. A vector provider plugs in through the index interface, but none ships yet.
- **Heuristic verification.** Verification checks terms, numbers and units, and polarity. It does not understand paraphrase, so a correct but reworded claim can show as partially verified. It never marks anything verified without a matching source sentence.
- **Extraction gaps.** There is no OCR, so scanned PDFs yield a warning and no text. PDF extraction handles common text encodings, but not every font encoding. Embedded images and charts are ignored.
- **Two connector adapters.** Connector sync covers the sandbox (simulated) and generic REST connectors. SharePoint, Google Drive, Confluence and others push documents through the documents API until their adapters ship.
- **Departments must match exactly.** ACL mapping matches departments by exact name. Source-system groups need a matching role key or department to grant access; otherwise they are unmapped (fail closed).
- **Re-sync for source permission changes.** Access is evaluated against stored principals. A permission change in the source system takes effect on the next sync or ingest.
- **Overshared sources stay overshared.** A source that shares a file with "Everyone" makes it retrievable by everyone. Use AI Data Security findings to fix oversharing at the source.
