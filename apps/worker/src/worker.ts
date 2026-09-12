import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { AgentClient, GitHubService, IncidentMailer } from "@fixops/integrations";
import { createRepository, JobQueue } from "@fixops/db";
import { ChatGPTClient, type ChatGPTConfig } from "@fixops/chatgpt";
import type { ProjectConfig } from "@fixops/contracts";
import { IncidentEngine } from "./index.js";

const rootEnv = resolve(process.cwd(), "../../.env");
loadDotenv({ path: existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env") });
const repository = createRepository();
await repository.init();
const queue = new JobQueue();
await queue.start();
const engine = new IncidentEngine({
  repository,
  queue,
  agent: new AgentClient(),
  chatgpt: new ChatGPTClient({
    ...(process.env.AI_API_KEY ? { apiKey: process.env.AI_API_KEY } : {}),
    ...(process.env.AI_BASE_URL ? { baseUrl: process.env.AI_BASE_URL } : {}),
    ...(process.env.AI_APP_NAME ? { appName: process.env.AI_APP_NAME } : {}),
    ...(process.env.AI_APP_URL ? { appUrl: process.env.AI_APP_URL } : {}),
    ...(process.env.AI_ORGANIZATION ? { organization: process.env.AI_ORGANIZATION } : {}),
  }),
  aiFactory: (config: ProjectConfig) => {
    const settings: ChatGPTConfig = {};
    const projectAi = config.ai ?? {};
    const apiKey = projectAi.apiKey ?? process.env.AI_API_KEY;
    const baseUrl = projectAi.baseUrl || process.env.AI_BASE_URL;
    const appName = projectAi.appName ?? process.env.AI_APP_NAME;
    const appUrl = projectAi.appUrl ?? process.env.AI_APP_URL;
    const organization = projectAi.organization ?? process.env.AI_ORGANIZATION;
    if (apiKey) settings.apiKey = apiKey;
    if (baseUrl) settings.baseUrl = baseUrl;
    if (appName) settings.appName = appName;
    if (appUrl) settings.appUrl = appUrl;
    if (organization) settings.organization = organization;
    return new ChatGPTClient(settings);
  },
  github: new GitHubService(),
  mailer: new IncidentMailer(),
});
await queue.work("discover", async ({ projectId }) => { try { await engine.discover(projectId); } catch (error) { await repository.updateProject(projectId, { status: "error" }); await repository.addEvent({ projectId, type: "project.discovery_failed", payload: { error: error instanceof Error ? error.message : "discovery failed" } }); } });
await queue.work("health-check", async ({ projectId, serviceId }) => { try { await engine.runHealthCheck(projectId, serviceId); } catch (error) { await repository.addEvent({ projectId, type: "project.health_check_failed", payload: { error: error instanceof Error ? error.message : "health check failed" } }); } });
await queue.work("remediate", async ({ projectId, serviceId, incidentId }) => { if (serviceId && incidentId) await engine.remediateIncident(projectId, serviceId, incidentId); });
await queue.work("instrument", async ({ projectId, serviceId }) => { if (serviceId) { try { await engine.instrumentService(projectId, serviceId); } catch (error) { await repository.addEvent({ projectId, type: "service.instrumentation_failed", payload: { serviceId, error: error instanceof Error ? error.message : "instrumentation failed" } }); } } });
const nextChecks = new Map<string, number>();
setInterval(async () => { const now = Date.now(); for (const project of await repository.listProjects()) { if (project.status !== "monitoring") continue; const dueAt = nextChecks.get(project.id) ?? 0; if (now < dueAt) continue; nextChecks.set(project.id, now + project.config.monitoring.intervalSeconds * 1000); try { await engine.runHealthCheck(project.id); } catch (error) { await repository.addEvent({ projectId: project.id, type: "project.health_check_failed", payload: { error: error instanceof Error ? error.message : "health check failed" } }); } } }, 1000);
console.log("FixOps worker is running.");
