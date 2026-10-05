import { MODULE_DEFINITIONS } from "@eaop/module-catalog";
import { createPlatform, loadEnv, type Platform } from "@eaop/platform";

/**
 * One platform instance per server process. Cached on globalThis so Next.js
 * dev hot-reloads do not open a new connection pool on every change.
 */
const g = globalThis as unknown as { __eaopPlatform?: Promise<Platform> };

export function getPlatform(): Promise<Platform> {
  g.__eaopPlatform ??= (async () => {
    const platform = createPlatform(loadEnv(), { modules: MODULE_DEFINITIONS });
    await platform.bootstrap();
    return platform;
  })().catch((err) => {
    g.__eaopPlatform = undefined;
    throw err;
  });
  return g.__eaopPlatform;
}
