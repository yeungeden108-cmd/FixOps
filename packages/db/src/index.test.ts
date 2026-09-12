import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./index.js";

const config = { github: { owner: "acme", repo: "demo", defaultBranch: "main" }, agentId: "agent", projectPath: ".", composeFiles: ["compose.yaml"], composeProjectName: "demo", modelId: "gpt-test", ai: { baseUrl: "https://api.openai.com/v1", model: "gpt-test" }, maxIncidentCostUsd: 2, locale: "zh-CN" as const, notificationEmails: ["dev@example.com"], monitoring: { intervalSeconds: 30, timeoutSeconds: 5, failureThreshold: 3, recoveryThreshold: 2, restartGraceSeconds: 60, verifyAttempts: 5, verifyIntervalSeconds: 15 }, remediation: { enabled: true, maxMinutes: 15, maxSteps: 12, maxPatchIterations: 2, autoDeploy: true, retainBackups: 5 } };

describe("memory repository", () => {
  it("persists projects, services, incidents and events", async () => {
    const repository = new MemoryRepository(); await repository.init();
    const project = await repository.createProject({ name: "Demo", config });
    const services = await repository.replaceServices(project.id, [{ projectId: project.id, name: "api", kind: "application", framework: "Express", config: { critical: true, livenessPath: "/health/live", readinessPath: "/health/ready", enabled: true } }]);
    const incident = await repository.createIncident({ projectId: project.id, serviceId: services[0]!.id, serviceName: "api", severity: "critical", reason: "unhealthy" });
    await repository.addEvent({ projectId: project.id, incidentId: incident.id, type: "incident.detected", payload: { ok: false } });
    const notification = await repository.createInAppNotification!({ projectId: project.id, incidentId: incident.id, phase: "started", severity: "critical", title: "Incident", body: "The API is unhealthy", idempotencyKey: `${incident.id}:started` });
    expect((await repository.createInAppNotification!({ projectId: project.id, incidentId: incident.id, phase: "started", severity: "critical", title: "Duplicate", body: "ignored", idempotencyKey: `${incident.id}:started` })).id).toBe(notification.id);
    expect((await repository.listNotifications!({ unreadOnly: true }))).toHaveLength(1);
    await repository.markNotificationRead!(notification.id);
    expect((await repository.listNotifications!({ unreadOnly: true }))).toHaveLength(0);
    expect((await repository.listProjects())).toHaveLength(1); expect((await repository.listIncidents(project.id))[0]?.id).toBe(incident.id); expect((await repository.listEvents({ incidentId: incident.id }))).toHaveLength(1);
  });
});
