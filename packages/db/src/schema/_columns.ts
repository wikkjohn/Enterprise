import { timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().defaultRandom();
export const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date", precision: 3 }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date", precision: 3 }).notNull().defaultNow();
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
