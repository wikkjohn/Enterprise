import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? "postgres://eaop:eaop@localhost:5432/eaop_dev" },
});
