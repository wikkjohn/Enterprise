import pg from "pg";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("DATABASE_ADMIN_URL is required.");
  process.exit(1);
}
if (process.env.APP_ENV === "production") {
  console.error("Refusing to reset a production database.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("drop schema public cascade; create schema public;");
await client.end();
console.log("✔ schema dropped. Run `pnpm db:migrate`.");
