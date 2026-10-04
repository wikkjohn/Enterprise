import pg from "pg";
import { CORE_MIGRATIONS_DIR, runMigrations } from "../../packages/db/src/migrate";
import { moduleMigrationSources } from "../../packages/db/scripts/module-migrations";
import { TEST_ADMIN_URL, TEST_APP_ROLE } from "./env";

/** Recreate the test schema, apply all migrations, and grant the runtime role. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await client.connect();
  await client.query("drop schema if exists public cascade; create schema public;");
  await client.end();
  await runMigrations(TEST_ADMIN_URL, [{ owner: "core", directory: CORE_MIGRATIONS_DIR }, ...(await moduleMigrationSources())]);
  const c2 = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await c2.connect();
  await c2.query(`grant eaop_runtime to ${TEST_APP_ROLE}`).catch(() => undefined);
  await c2.end();
}
