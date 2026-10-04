import { type ConnectorAdapter, type ConnectorDefinition, ConnectorError } from "./types";

/**
 * Reusable connector contract checks. Every adapter (core or module-provided)
 * must pass these — see tests/unit/connectors.contract.test.ts. They return a
 * list of violations instead of asserting, so any test runner can use them.
 */
export function definitionViolations(def: ConnectorDefinition, adapter?: ConnectorAdapter): string[] {
  const v: string[] = [];
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(def.type)) v.push("type must be snake_case");
  if (def.capabilities.length === 0) v.push("must declare at least one capability");
  for (const c of def.capabilities) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(c.key)) v.push(`capability "${c.key}" must be namespaced (e.g. files.read)`);
    if (c.operations.length === 0) v.push(`capability "${c.key}" declares no operations`);
  }
  for (const a of def.authTypes) {
    if (a !== "none" && !(def.credentialFields[a]?.length)) v.push(`auth type "${a}" has no credential fields`);
    for (const f of def.credentialFields[a] ?? []) {
      if (/secret|password|token|key/i.test(f.key) && !f.secret && f.key !== "clientId") v.push(`credential field "${f.key}" looks secret but is not marked secret`);
    }
  }
  for (const f of def.configFields) if (/secret|password|token|api[-_]?key/i.test(f.key) && !/header|prefix|url/i.test(f.key)) v.push(`config field "${f.key}" looks like a secret — use credentials`);
  if (def.rateLimit.requestsPerMinute <= 0) v.push("rateLimit must be positive");
  if (def.availability === "available" && !adapter) v.push("available connectors must ship an adapter");
  if (def.availability === "contract_only" && adapter) v.push("contract_only connectors must not register an adapter (mark them available)");
  if (adapter && adapter.type !== def.type) v.push("adapter.type must equal definition.type");
  return v;
}

export function isNormalisedError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError && ["auth", "rate_limited", "transient", "permanent", "configuration", "not_implemented"].includes(err.errorClass);
}
