import { describe, expect, it } from "vitest";
import {
  classifyStatus, defaultConnectorDefinitions, definitionViolations, graphqlAdapter, outboundWebhookAdapter, parseRetryAfter, resolveUnder, restApiAdapter, sandboxAdapter, ConnectorError,
} from "../../packages/connectors/src";

const adapters = new Map([restApiAdapter, graphqlAdapter, outboundWebhookAdapter, sandboxAdapter].map((a) => [a.type, a]));

describe("connector contracts", () => {
  for (const def of defaultConnectorDefinitions({ includeSandbox: true })) {
    it(`${def.type} satisfies the connector definition contract`, () => {
      expect(definitionViolations(def, adapters.get(def.type))).toEqual([]);
    });
  }

  it("normalises upstream statuses into error classes", () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(401)?.errorClass).toBe("auth");
    expect(classifyStatus(429, "7")).toMatchObject({ errorClass: "rate_limited", retryAfterSeconds: 7 });
    expect(classifyStatus(503)?.errorClass).toBe("transient");
    expect(classifyStatus(404)?.errorClass).toBe("permanent");
    expect(classifyStatus(503)?.retryable).toBe(true);
    expect(classifyStatus(404)?.retryable).toBe(false);
  });

  it("parses Retry-After (0, seconds, HTTP dates, garbage)", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("12")).toBe(12);
    expect(parseRetryAfter(null)).toBe(30);
    expect(parseRetryAfter("99999")).toBe(300);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeLessThanOrEqual(6);
  });

  it("confines REST paths to the base URL", () => {
    expect(resolveUnder("https://api.x.com/v1", "/items")).toBe("https://api.x.com/v1/items");
    expect(() => resolveUnder("https://api.x.com/v1", "//evil.com")).toThrow(ConnectorError);
    expect(() => resolveUnder("https://api.x.com/v1", "/../admin")).toThrow(ConnectorError);
    expect(() => resolveUnder("https://api.x.com/v1", "items")).toThrow(ConnectorError);
  });
});
