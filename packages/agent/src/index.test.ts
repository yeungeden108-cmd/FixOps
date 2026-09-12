import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockHostAgent } from "./index.js";

describe("MockHostAgent", () => {
  it("discovers Compose files and provides a reversible no-runtime snapshot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "fixops-mock-"));
    const agent = new MockHostAgent({ dataDir });
    const discovered = await agent.execute({ operation: "discover", projectPath: "demo", composeFiles: ["compose.yaml"], projectName: "fixops-demo" }) as { services?: Record<string, unknown> };
    expect(discovered.services?.["checkout-demo"]).toBeDefined();
    const snapshot = await agent.execute({ operation: "snapshot", projectPath: "demo", composeFiles: ["compose.yaml"], projectName: "fixops-demo", services: ["checkout-demo"] }) as { id: string; services: Array<{ service: string; image: string }> };
    expect(snapshot.services).toEqual([{ service: "checkout-demo", image: "mock://fixops-demo/checkout-demo" }]);
    const rollback = await agent.execute({ operation: "rollback", projectName: "fixops-demo", backupId: snapshot.id }) as { rolledBack: boolean };
    expect(rollback.rolledBack).toBe(true);
  });
});
