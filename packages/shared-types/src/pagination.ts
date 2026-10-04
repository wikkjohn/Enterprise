import { z } from "zod";

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  data: T[];
  /** Opaque cursor for the next page; absent when there are no more results. */
  nextCursor?: string;
}

/** Keyset cursor encoding: (timestamp, id) pairs, base64url JSON. */
export function encodeCursor(value: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { t: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { t: unknown }).t === "string" && typeof (parsed as { id: unknown }).id === "string") {
      return parsed as { t: string; id: string };
    }
  } catch {
    // fall through
  }
  return undefined;
}

export const sortDirectionSchema = z.enum(["asc", "desc"]).default("desc");
