import { route } from "@/lib/api";
import { KV_MODULE, UPLOAD_BODY_BYTES, anyBody, kv, listQuery } from "@/lib/knowledge";

export const GET = route({ auth: "any", module: KV_MODULE, permission: "knowledge.read", query: listQuery, handler: ({ platform, ctx, query }) => kv(platform).listDocuments(ctx, { sourceId: query.sourceId, status: query.status, q: query.q }) });
/** Upload or push a document (text, base64 file content or a structured record). Re-sending the same externalId creates a new version. */
export const POST = route({ auth: "any", module: KV_MODULE, permission: "knowledge.ingest", body: anyBody, maxBodyBytes: UPLOAD_BODY_BYTES, rateLimit: { limit: 120, windowSeconds: 60 }, handler: ({ platform, ctx, body }) => kv(platform).ingestDocument(ctx, body) });
