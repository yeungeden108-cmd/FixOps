import { describe, expect, it } from "vitest";
import { ChatGPTClient } from "./index.js";

describe("ChatGPT-compatible adapter", () => {
  it("sends the user model and Chat Completions structured schema", async () => {
    let request: RequestInit | undefined;
    let url = "";
    const client = new ChatGPTClient({
      apiKey: "test-key",
      baseUrl: "https://happy.example/v1/",
      appName: "My FixOps App",
      appUrl: "https://fixops.example",
      fetchImpl: (async (input, init) => {
        url = String(input);
        request = init;
        return new Response(JSON.stringify({ model: "happy-model", choices: [{ message: { role: "assistant", content: JSON.stringify({ severity: "critical", summary: "broken", likelyCause: "test", confidence: 0.8, affectedFiles: [], plan: ["test"], canAutoFix: false, blockedReason: null }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const result = await client.diagnose({ modelId: "user/model", context: "evidence" });
    expect(result.value.severity).toBe("critical");
    expect(url).toBe("https://happy.example/v1/chat/completions");
    const body = JSON.parse(String(request?.body)) as { model: string; response_format: unknown; provider?: unknown };
    expect(body.model).toBe("user/model");
    expect(body.response_format).toBeTruthy();
    expect(body.provider).toBeUndefined();
    const headers = new Headers(request?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-app-name")).toBe("My FixOps App");
    expect(headers.get("referer")).toBe("https://fixops.example");
  });

  it("accepts a model list with only ids", async () => {
    const client = new ChatGPTClient({ fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "happy-model" }] }), { status: 200 })) as typeof fetch });
    await expect(client.listModels()).resolves.toEqual([{ id: "happy-model", supported_parameters: [] }]);
  });
});
