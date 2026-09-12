import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { MemoryRepository } from "@fixops/db";
import type { AgentClient, GitHubService, IncidentMailer } from "@fixops/integrations";
import type { ChatGPTClient } from "@fixops/chatgpt";

describe("FixOps API", () => {
  it("exposes health and project lifecycle endpoints", async () => {
    const repository = new MemoryRepository();
    const fakeAgent = { execute: async () => ({}) } as unknown as AgentClient;
    const fakeChatGPT = { listModels: async () => [], chat: async () => ({ id: "test-id", model: "test-model", choices: [{ message: { role: "assistant", content: "OK" } }] }) } as unknown as ChatGPTClient;
    const fakeGithub = {} as GitHubService; const fakeMailer = {} as IncidentMailer;
    const server = await buildServer({ repository, agent: fakeAgent, chatgpt: fakeChatGPT, aiConnectionFactory: () => fakeChatGPT, github: fakeGithub, mailer: fakeMailer });
    const health = await server.app.inject({ method: "GET", url: "/health/live" }); expect(health.statusCode).toBe(200);
    const response = await server.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Demo", config: { github: { owner: "acme", repo: "demo" }, agentId: "agent", projectPath: ".", composeFiles: ["compose.yaml"], composeProjectName: "demo", modelId: "gpt-test" } } });
    expect(response.statusCode).toBe(201); expect(JSON.parse(response.body).name).toBe("Demo"); expect(JSON.parse(response.body).config.notificationEmails).toEqual([]);
    const projects = await server.app.inject({ method: "GET", url: "/api/v1/projects" }); expect(JSON.parse(projects.body)).toHaveLength(1);
    const project = JSON.parse(response.body) as { id: string };
    const incident = await repository.createIncident({ projectId: project.id, serviceId: "00000000-0000-4000-8000-000000000001", serviceName: "api", severity: "critical", reason: "test" });
    const notification = await repository.createInAppNotification!({ projectId: project.id, incidentId: incident.id, phase: "started", severity: "critical", title: "故障处理中", body: "test", idempotencyKey: `${incident.id}:started` });
    const notifications = await server.app.inject({ method: "GET", url: "/api/v1/notifications" }); expect(JSON.parse(notifications.body)[0].id).toBe(notification.id);
    const marked = await server.app.inject({ method: "POST", url: `/api/v1/notifications/${notification.id}/read` }); expect(marked.statusCode).toBe(200); expect(JSON.parse(marked.body).read).toBe(true);
    const aiConfig = await server.app.inject({ method: "GET", url: "/api/v1/ai/config" }); expect(aiConfig.statusCode).toBe(200); expect(JSON.parse(aiConfig.body).apiKeyConfigured).toBe(false);
    const aiTest = await server.app.inject({ method: "POST", url: "/api/v1/ai/test", payload: { baseUrl: "https://happy.example/v1", model: "user-model", apiKey: "secret", appName: "My App" } }); expect(aiTest.statusCode).toBe(200); expect(JSON.parse(aiTest.body).ok).toBe(true);
    const saved = await server.app.inject({ method: "PATCH", url: `/api/v1/projects/${project.id}/ai`, payload: { baseUrl: "https://happy.example/v1", model: "user-model", apiKey: "secret", appName: "My App" } }); expect(saved.statusCode).toBe(200); expect(JSON.parse(saved.body).config.ai.apiKey).toBeUndefined(); expect(JSON.parse(saved.body).config.ai.apiKeyConfigured).toBe(true);
    await server.close();
  });
});
