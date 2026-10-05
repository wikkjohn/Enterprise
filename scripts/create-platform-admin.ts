/**
 * Production bootstrap: create the first platform administrator.
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... pnpm platform:admin
 * Fails if a platform administrator already exists.
 */
import { MODULE_DEFINITIONS } from "@eaop/module-catalog";
import { createPlatform, loadEnv } from "@eaop/platform";

const email = process.env.PLATFORM_ADMIN_EMAIL;
const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!email || !password) {
  console.error("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required.");
  process.exit(1);
}
const p = createPlatform(loadEnv(), { modules: MODULE_DEFINITIONS });
await p.bootstrap();
await p.auth.bootstrapPlatformAdmin({ email, name: process.env.PLATFORM_ADMIN_NAME ?? "Platform Administrator", password });
console.log(`✔ platform administrator ${email} created`);
await p.close();
