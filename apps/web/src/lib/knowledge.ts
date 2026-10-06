import { knowledgeService, type KnowledgeService } from "@eaop/module-knowledge-verification";
import { type Platform } from "@eaop/platform";
import { z } from "zod";

/** The Knowledge & Verification service, built by the module's install hook on the shared platform. */
export const kv = (platform: Platform): KnowledgeService => knowledgeService(platform);

export const KV_MODULE = "knowledge_verification" as const;
export const KV_BASE = "/m/knowledge-verification";
export const anyBody = z.record(z.unknown());
/** Uploads carry base64 content: allow up to 30 MB bodies on the document routes. */
export const UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const s = (max = 64) => z.string().max(max).optional();
export const listQuery = z.object({ status: s(), kind: s(), confidence: s(), sourceId: s(), q: s(200), mine: z.enum(["true", "false"]).optional() });
