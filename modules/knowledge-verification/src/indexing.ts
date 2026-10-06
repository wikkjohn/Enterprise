import { sql, type Tx } from "@eaop/db";
import { terms } from "./text";

/**
 * Search/vector infrastructure abstraction.
 *
 * Retrieval is never tied to one vendor: the service talks to a
 * `KnowledgeIndexProvider`. The default provider uses PostgreSQL full-text
 * search over `knowledge_chunks.tsv`. A vector store (pgvector, OpenSearch,
 * a hosted vector DB…) plugs in by implementing the same interface and being
 * registered with `registerIndexProvider`.
 *
 * Contract every provider must honour:
 *  - `search` MUST apply the permission filter (`principals`) itself, before
 *    returning anything, and MUST exclude non-active, superseded and expired
 *    documents.
 *  - The service re-checks every returned chunk against the database ACL
 *    anyway (defence in depth), so a provider bug cannot leak content into
 *    model context.
 */
export interface IndexHit { chunkId: string; relevance: number }

export interface KnowledgeIndexProvider {
  key: string;
  description: string;
  /** Called after the chunks of a document version are written. */
  indexDocument(tx: Tx, doc: { organizationId: string; documentId: string; version: number }): Promise<void>;
  removeDocument(tx: Tx, doc: { organizationId: string; documentId: string }): Promise<void>;
  search(tx: Tx, req: { organizationId: string; query: string; principals: string[]; limit: number }): Promise<IndexHit[]>;
}

/** Build an OR tsquery from the question's content terms (sanitised to [a-z0-9]). */
export function toTsQuery(q: string): string | null {
  const ts = [...new Set(terms(q).map((t) => t.replace(/[^a-z0-9]/g, "")).filter((t) => t.length > 1))].slice(0, 32);
  return ts.length ? ts.map((t) => `${t}:*`).join(" | ") : null;
}

/** Postgres text[] literal with proper quoting (values are never stripped, so they still match). */
export function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(",")}}`;
}

export const postgresFtsProvider: KnowledgeIndexProvider = {
  key: "postgres_fts",
  description: "PostgreSQL full-text search (GIN over a generated tsvector); prefix matching on content terms; rank normalised to 0–1.",
  async indexDocument() {
    // The tsvector is a generated column: nothing to do.
  },
  async removeDocument() {
    // Chunks are deleted with the document version.
  },
  async search(tx, req) {
    const q = toTsQuery(req.query);
    if (!q || !req.principals.length) return [];
    const res = await tx.execute(sql`
      select c.id as chunk_id, ts_rank_cd(c.tsv, q.q, 32) as rank
      from knowledge_chunks c
      join knowledge_documents d on d.id = c.document_id
      join knowledge_permissions_metadata p on p.document_id = d.id
      cross join to_tsquery('english', ${q}) as q(q)
      where c.organization_id = ${req.organizationId}
        and d.status = 'active' and d.ingestion_status = 'indexed' and c.version = d.current_version
        and (d.expiration_date is null or d.expiration_date > now())
        and p.principals && ${pgTextArray(req.principals)}::text[]
        and c.tsv @@ q.q
      order by rank desc
      limit ${req.limit}`);
    return (res.rows as Array<{ chunk_id: string; rank: number | string }>).map((r) => ({ chunkId: r.chunk_id, relevance: Number(r.rank) }));
  },
};
