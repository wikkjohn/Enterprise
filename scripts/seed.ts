/**
 * Development seed. Creates a platform administrator and one SANDBOX
 * organization so you can sign in. No business/sample data is created.
 * Refuses to run when APP_ENV=production (use scripts/create-platform-admin.ts).
 */
import { randomUUID } from "node:crypto";
import { createPlatform, loadEnv } from "@eaop/platform";

const env = loadEnv();
if (env.APP_ENV === "production") {
  console.error("Refusing to seed a production environment.");
  process.exit(1);
}
const email = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.SEED_ADMIN_PASSWORD ?? "change-me-on-first-login";
const p = createPlatform(env);
await p.bootstrap();
let adminId: string;
try {
  adminId = await p.auth.bootstrapPlatformAdmin({ email, name: "Platform Admin", password });
  console.log(`✔ platform administrator ${email}`);
} catch (e) {
  console.log(`• ${(e as Error).message}`);
  const r = await p.db.pool.query<{ id: string }>("select id from users where is_platform_admin limit 1").catch(() => ({ rows: [] as { id: string }[] }));
  adminId = r.rows[0]?.id ?? "";
}
if (adminId) {
  try {
    const org = await p.organizations.create(
      { actor: { type: "system", id: "seed", label: "system:seed" }, correlationId: randomUUID() },
      { name: "Sandbox Organization", slug: "sandbox", environment: "sandbox", adminUserId: adminId },
    );
    console.log(`✔ organization "${org.name}" (${org.environment}) — you are its Organization Administrator`);
  } catch (e) {
    console.log(`• ${(e as Error).message}`);
  }
}
console.log(`\nSign in at ${env.APP_URL}/login as ${email}`);
await p.close();
