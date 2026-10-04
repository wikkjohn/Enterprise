import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export interface MigrationSource {
  /** Logical owner: "core" or a module id. Keeps migration histories separate. */
  owner: string;
  directory: string;
}

/**
 * Minimal, dependency-free migration runner. Applies *.sql files in lexical
 * order per source, each inside a transaction, recording them in
 * schema_migrations. Module migrations run after core migrations.
 */
export async function runMigrations(connectionString: string, sources: MigrationSource[], log: (msg: string) => void = () => {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      owner text not null, name text not null, applied_at timestamptz not null default now(), primary key (owner, name))`);
    // Serialize concurrent migrators.
    await client.query("select pg_advisory_lock(727274)");
    const applied: string[] = [];
    for (const source of sources) {
      const files = (await readdir(source.directory)).filter((f) => f.endsWith(".sql")).sort();
      const done = new Set(
        (await client.query<{ name: string }>("select name from schema_migrations where owner = $1", [source.owner])).rows.map((r) => r.name),
      );
      for (const file of files) {
        if (done.has(file)) continue;
        const sqlText = await readFile(path.join(source.directory, file), "utf8");
        await client.query("begin");
        try {
          await client.query(sqlText);
          await client.query("insert into schema_migrations(owner, name) values ($1, $2)", [source.owner, file]);
          await client.query("commit");
          applied.push(`${source.owner}/${file}`);
          log(`applied ${source.owner}/${file}`);
        } catch (err) {
          await client.query("rollback");
          throw new Error(`Migration ${source.owner}/${file} failed: ${(err as Error).message}`);
        }
      }
    }
    await client.query("select pg_advisory_unlock(727274)");
    return applied;
  } finally {
    await client.end();
  }
}

export const CORE_MIGRATIONS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../migrations");
