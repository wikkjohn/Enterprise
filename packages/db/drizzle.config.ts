import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Timestamp prefixes sort after the hand-written 0001_* security migration.
  migrations: { prefix: "timestamp" },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "postgres://eaop:eaop@localhost:5432/eaop_dev" },
});
