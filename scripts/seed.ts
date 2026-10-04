/**
 * Development seed. Creates a platform administrator and one SANDBOX
 * organization so you can sign in. No business/sample data is created.
 * Refuses to run when APP_ENV=production (use scripts/create-platform-admin.ts).
 */
import { randomUUID } from "node:crypto";
import { eq, users } from "@eaop/db";
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
  const [row] = await p.db.withSystem("seed.find_admin", (tx) => tx.select({ id: users.id }).from(users).where(eq(users.isPlatformAdmin, true)).limit(1));
  adminId = row?.id ?? "";
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
