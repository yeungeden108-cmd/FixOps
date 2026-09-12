import { describe, expect, it } from "vitest";
import { classifyComposeService, discoverComposeServices, isAllowedHealthComposeDiff, isAllowedPatchPath, parseFixOpsOverrides, redactSecrets, transitionHealth } from "./index.js";

describe("compose discovery and safety", () => {
  it("classifies application and infrastructure services", () => {
    expect(classifyComposeService({ name: "api", image: "node:22", build: "." })).toBe("application");
    expect(classifyComposeService({ name: "postgres", image: "postgres:17" })).toBe("infrastructure");
    expect(classifyComposeService({ name: "nightly-job", command: "node migrate.js" })).toBe("job");
  });

  it("discovers normalized service configs", () => {
    const result = discoverComposeServices("00000000-0000-4000-8000-000000000000", { services: { api: { image: "node:22", ports: ["3000:3000"], build: "." }, db: { image: "postgres:17" } } });
    expect(result).toHaveLength(2);
    expect(result[0]?.config.port).toBe(3000);
    expect(result[1]?.kind).toBe("infrastructure");
  });

  it("moves to unhealthy only after the threshold and can recover", () => {
    expect(transitionHealth({ status: "healthy", consecutiveFailures: 2, consecutiveSuccesses: 0, failureThreshold: 3, recoveryThreshold: 2 })).toBe("degraded");
    expect(transitionHealth({ status: "degraded", consecutiveFailures: 3, consecutiveSuccesses: 0, failureThreshold: 3, recoveryThreshold: 2 })).toBe("unhealthy");
    expect(transitionHealth({ status: "recovering", consecutiveFailures: 0, consecutiveSuccesses: 2, failureThreshold: 3, recoveryThreshold: 2 })).toBe("healthy");
  });

  it("blocks secrets and host configuration from AI patches", () => {
    expect(isAllowedPatchPath("src/server.ts")).toBe(true);
    expect(isAllowedPatchPath(".env")).toBe(false);
    expect(isAllowedPatchPath(".github/workflows/deploy.yml")).toBe(false);
    expect(isAllowedPatchPath("docker-compose.yml")).toBe(false);
    expect(isAllowedPatchPath("compose.yaml")).toBe(false);
    expect(redactSecrets("token=sk-or-v1-secret password=hunter2")).toContain("[REDACTED]");
    expect(redactSecrets("Authorization: Bearer super-secret&token=abc")).not.toContain("super-secret");
    expect(isAllowedHealthComposeDiff("-  image: payments:old\n+  image: payments:new")).toBe(false);
    expect(isAllowedHealthComposeDiff("-  healthcheck: null\n+  healthcheck:\n+    interval: 5s")).toBe(true);
  });

  it("parses optional .fixops.yml service overrides", () => {
    expect(parseFixOpsOverrides("services:\n  api:\n    critical: false\n    port: 8080")).toEqual({ api: { critical: false, port: 8080 } });
    expect(parseFixOpsOverrides("not: [valid")).toEqual({});
  });
});
