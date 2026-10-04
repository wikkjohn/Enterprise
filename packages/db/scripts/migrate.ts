import { runMigrations, CORE_MIGRATIONS_DIR } from "../src/migrate";
import { moduleMigrationSources } from "./module-migrations";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required (owner role; runs DDL).");
  process.exit(1);
}
const applied = await runMigrations(url, [{ owner: "core", directory: CORE_MIGRATIONS_DIR }, ...(await moduleMigrationSources())], (m) => console.log(m));
console.log(applied.length ? `✔ ${applied.length} migration(s) applied` : "✔ database is up to date");
