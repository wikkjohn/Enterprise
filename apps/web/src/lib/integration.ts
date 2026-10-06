import { integrationService, type IntegrationService } from "@eaop/module-integration-hub";
import { type Platform } from "@eaop/platform";
import { z } from "zod";

/** The Integration service, built by the module's install hook on the shared platform. */
export const ih = (platform: Platform): IntegrationService => integrationService(platform);

export const IH_MODULE = "integration_hub" as const;
export const IH_BASE = "/m/integration-hub";
export const anyBody = z.record(z.unknown());
