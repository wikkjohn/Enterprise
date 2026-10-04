import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MigrationSource } from "../src/migrate";

/** Discovers modules/<name>/migrations directories. Owner = directory name. */
export async function moduleMigrationSources(): Promise<MigrationSource[]> {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../modules");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "migrations")))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ owner: `module:${d.name}`, directory: path.join(root, d.name, "migrations") }));
}
