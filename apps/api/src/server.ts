import { config as loadDotenv } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { AgentClient, GitHubService, IncidentMailer } from "@fixops/integrations";
import { AiProviderConfigSchema, ProjectCreateSchema, ServiceConfigSchema, type AiProviderConfig, type FixOpsEvent, type ProjectConfig } from "@fixops/contracts";
import { createRepository, JobQueue, type Repository } from "@fixops/db";
import { ChatGPTClient, ChatGPTError, selectableModel, type ChatGPTConfig } from "@fixops/chatgpt";
import { IncidentEngine } from "@fixops/worker";

const rootEnv = resolve(process.cwd(), "../../.env");
loadDotenv({ path: existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env") });

class EventHub {
  private listeners = new Set<(event: FixOpsEvent) => void>();
  subscribe(listener: (event: FixOpsEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(event: FixOpsEvent): void { for (const listener of this.listeners) listener(event); }
}

function jsonError(reply: FastifyReply, status: number, detail: string): FastifyReply { return reply.code(status).type("application/problem+json").send({ type: "about:blank", title: status >= 500 ? "FixOps server error" : "Invalid request", status, detail }); }
function requireUuid(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Expected UUID"); return value; }
function aiConfigFromProject(config: ProjectConfig): AiProviderConfig {
  return {
    baseUrl: config.ai.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1",
    ...(config.ai.apiKey ?? process.env.AI_API_KEY ? { apiKey: config.ai.apiKey ?? process.env.AI_API_KEY } : {}),
    ...(config.ai.model ?? config.modelId ?? process.env.AI_MODEL ? { model: config.ai.model ?? config.modelId ?? process.env.AI_MODEL } : {}),
    ...(config.ai.appName ?? process.env.AI_APP_NAME ? { appName: config.ai.appName ?? process.env.AI_APP_NAME } : {}),
    ...(config.ai.appUrl ?? process.env.AI_APP_URL ? { appUrl: config.ai.appUrl ?? process.env.AI_APP_URL } : {}),
    ...(config.ai.organization ?? process.env.AI_ORGANIZATION ? { organization: config.ai.organization ?? process.env.AI_ORGANIZATION } : {}),
  };
}

function publicAiConfig(config: ProjectConfig): Record<string, unknown> {
  const ai = aiConfigFromProject(config);
  return {
    baseUrl: ai.baseUrl,
    ...(ai.model ? { model: ai.model } : {}),
    ...(ai.appName ? { appName: ai.appName } : {}),
    ...(ai.appUrl ? { appUrl: ai.appUrl } : {}),
    ...(ai.organization ? { organization: ai.organization } : {}),
    apiKeyConfigured: Boolean(ai.apiKey),
  };
}

function publicProject<T extends { config: ProjectConfig }>(project: T): T & { config: Omit<ProjectConfig, "ai"> & { ai: Record<string, unknown> } } {
  return { ...project, config: { ...project.config, ai: publicAiConfig(project.config) } } as T & { config: Omit<ProjectConfig, "ai"> & { ai: Record<string, unknown> } };
}

function validateAiSettings(config: ProjectConfig): void {
  const settings = aiConfigFromProject(config);
  // Monitoring and restart-only projects may intentionally omit AI settings.
  if (!settings.model && !settings.apiKey) return;
  // Constructing the client validates protocol and URL without making a network request.
  new ChatGPTClient(settings);
}

const AiConnectionSchema = AiProviderConfigSchema.extend({ model: z.string().min(1) });

export interface ApiDependencies { repository?: Repository; queue?: JobQueue; agent?: AgentClient; chatgpt?: ChatGPTClient; aiFactory?: (config: ProjectConfig) => ChatGPTClient; aiConnectionFactory?: (config: ChatGPTConfig) => ChatGPTClient; github?: GitHubService; mailer?: IncidentMailer; engine?: IncidentEngine; }

export async function buildServer(dependencies: ApiDependencies = {}): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const repository = dependencies.repository ?? createRepository(); await repository.init();
  const queue = dependencies.queue ?? new JobQueue(); await queue.start();
  const agent = dependencies.agent ?? new AgentClient();
  const chatgpt = dependencies.chatgpt ?? new ChatGPTClient({
    ...(process.env.AI_API_KEY ? { apiKey: process.env.AI_API_KEY } : {}),
    ...(process.env.AI_BASE_URL ? { baseUrl: process.env.AI_BASE_URL } : {}),
    ...(process.env.AI_APP_NAME ? { appName: process.env.AI_APP_NAME } : {}),
    ...(process.env.AI_APP_URL ? { appUrl: process.env.AI_APP_URL } : {}),
    ...(process.env.AI_ORGANIZATION ? { organization: process.env.AI_ORGANIZATION } : {}),
  });
  const github = dependencies.github ?? new GitHubService(); const mailer = dependencies.mailer ?? new IncidentMailer(); const hub = new EventHub();
  const engine = dependencies.engine ?? new IncidentEngine({ repository, queue, agent, chatgpt, aiFactory: dependencies.aiFactory ?? ((config) => new ChatGPTClient(aiConfigFromProject(config))), github, mailer, publish: async (event) => { hub.publish(event); } });
  await queue.work("discover", async ({ projectId }) => { try { await engine.discover(projectId); } catch (error) { await repository.updateProject(projectId, { status: "error" }); await repository.addEvent({ projectId, type: "project.discovery_failed", payload: { error: error instanceof Error ? error.message : "discovery failed" } }); } });
  await queue.work("health-check", async ({ projectId, serviceId }) => { try { await engine.runHealthCheck(projectId, serviceId); } catch (error) { await repository.addEvent({ projectId, type: "project.health_check_failed", payload: { error: error instanceof Error ? error.message : "health check failed" } }); } });
  await queue.work("remediate", async ({ projectId, serviceId, incidentId }) => { if (serviceId && incidentId) await engine.remediateIncident(projectId, serviceId, incidentId); });
  await queue.work("instrument", async ({ projectId, serviceId }) => { if (serviceId) { try { await engine.instrumentService(projectId, serviceId); } catch (error) { await repository.addEvent({ projectId, type: "service.instrumentation_failed", payload: { serviceId, error: error instanceof Error ? error.message : "instrumentation failed" } }); } } });
  const nextInlineChecks = new Map<string, number>();
  const inlineMonitor = !process.env.DATABASE_URL ? setInterval(async () => { const now = Date.now(); for (const project of await repository.listProjects()) { if (project.status !== "monitoring") continue; const dueAt = nextInlineChecks.get(project.id) ?? 0; if (now < dueAt) continue; nextInlineChecks.set(project.id, now + project.config.monitoring.intervalSeconds * 1000); try { await engine.runHealthCheck(project.id); } catch (error) { await repository.addEvent({ projectId: project.id, type: "project.health_check_failed", payload: { error: error instanceof Error ? error.message : "health check failed" } }); } } }, 1000) : undefined;

  const app = Fastify({ logger: process.env.NODE_ENV !== "test", bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: false });
  await app.register(rawBody, { field: "rawBody", global: false, encoding: "utf8" });
  const webDist = resolve(process.env.FIXOPS_WEB_DIST ?? join(process.cwd(), "apps/web/dist"));
  if (existsSync(webDist)) { await app.register(fastifyStatic, { root: webDist, prefix: "/" }); app.get("/", async (_request, reply) => reply.sendFile("index.html")); }

  app.get("/health/live", async () => ({ status: "ok", service: "fixops-api", version: "0.1.0" }));
  app.get("/health/ready", async (_request, reply) => { try { await repository.listProjects(); return { status: "ok", checks: { database: "ok" } }; } catch { return reply.code(503).send({ status: "error", checks: { database: "error" } }); } });
  app.get("/api/v1/openapi.json", async () => ({ openapi: "3.0.3", info: { title: "FixOps API", version: "0.1.0" }, servers: [{ url: "/" }], paths: {
    "/api/v1/projects": { get: { responses: { "200": { description: "Projects" } } }, post: { responses: { "201": { description: "Project created" } } } },
    "/api/v1/projects/{projectId}/discover": { post: { responses: { "202": { description: "Discovery queued" } } } },
    "/api/v1/projects/{projectId}/checks/run": { post: { responses: { "202": { description: "Health check queued" } } } },
    "/api/v1/projects/{projectId}/services": { get: { responses: { "200": { description: "Discovered services" } } } },
    "/api/v1/incidents": { get: { responses: { "200": { description: "Incidents" } } } },
    "/api/v1/incidents/{incidentId}": { get: { responses: { "200": { description: "Incident timeline" } } } },
    "/api/v1/notifications": { get: { responses: { "200": { description: "In-app notifications" } } } },
    "/api/v1/notifications/{notificationId}/read": { post: { responses: { "200": { description: "Notification marked read" } } } },
    "/api/v1/ai/config": { get: { responses: { "200": { description: "Masked ChatGPT-compatible AI configuration" } } } },
    "/api/v1/ai/models": { get: { responses: { "200": { description: "Models from the configured AI gateway" } } }, post: { responses: { "200": { description: "Models from a supplied gateway" } } } },
    "/api/v1/ai/test": { post: { responses: { "200": { description: "AI gateway connectivity test" } } } },
    "/api/v1/events": { get: { responses: { "200": { description: "Server-sent events" } } } },
  } }));

  app.get("/api/v1/projects", async () => (await repository.listProjects()).map(publicProject));
  app.post("/api/v1/projects", async (request, reply) => {
    const parsed = ProjectCreateSchema.safeParse(request.body); if (!parsed.success) return jsonError(reply, 400, parsed.error.message);
    try { validateAiSettings(parsed.data.config); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "Invalid AI settings"); }
    try { const project = await repository.createProject(parsed.data); await queue.publish("discover", { projectId: project.id }); return reply.code(201).send(publicProject(project)); } catch (error) { return jsonError(reply, 500, error instanceof Error ? error.message : "could not create project"); }
  });
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", async (request, reply) => { try { const project = await repository.getProject(requireUuid(request.params.projectId)); return project ? reply.send(publicProject(project)) : jsonError(reply, 404, "Project not found"); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid project"); } });
  app.patch<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", async (request, reply) => { try {
    const id = requireUuid(request.params.projectId); const current = await repository.getProject(id); if (!current) return jsonError(reply, 404, "Project not found");
    const body = (request.body ?? {}) as Partial<ProjectConfig>;
    const candidate = { ...current.config, ...body, ai: body.ai ? { ...current.config.ai, ...body.ai, ...(body.ai.apiKey === "********" ? { apiKey: current.config.ai.apiKey } : {}) } : current.config.ai };
    const parsed = ProjectCreateSchema.shape.config.safeParse(candidate); if (!parsed.success) return jsonError(reply, 400, parsed.error.message);
    try { validateAiSettings(parsed.data); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "Invalid AI settings"); }
    const updated = await repository.updateProject(id, { config: parsed.data }); return updated ? reply.send(publicProject(updated)) : jsonError(reply, 404, "Project not found");
  } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid project"); } });
  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/discover", async (request, reply) => { try { const id = requireUuid(request.params.projectId); if (!(await repository.getProject(id))) return jsonError(reply, 404, "Project not found"); const jobId = await queue.publish("discover", { projectId: id }); return reply.code(202).send({ jobId, status: "queued" }); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "could not queue discovery"); } });
  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/monitoring/enable", async (request, reply) => { try { const id = requireUuid(request.params.projectId); const project = await repository.updateProject(id, { status: "monitoring" }); return project ? reply.send(publicProject(project)) : jsonError(reply, 404, "Project not found"); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "could not enable monitoring"); } });
  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/checks/run", async (request, reply) => { try { const id = requireUuid(request.params.projectId); if (!(await repository.getProject(id))) return jsonError(reply, 404, "Project not found"); const serviceId = (request.body as { serviceId?: string } | null)?.serviceId; const jobId = await queue.publish("health-check", { projectId: id, ...(serviceId ? { serviceId: requireUuid(serviceId) } : {}) }); return reply.code(202).send({ jobId, status: "queued" }); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "could not queue health check"); } });
  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/instrument", async (request, reply) => { try { const id = requireUuid(request.params.projectId); if (!(await repository.getProject(id))) return jsonError(reply, 404, "Project not found"); const serviceId = (request.body as { serviceId?: string } | null)?.serviceId; if (!serviceId) return jsonError(reply, 400, "serviceId is required"); const jobId = await queue.publish("instrument", { projectId: id, serviceId: requireUuid(serviceId) }); return reply.code(202).send({ jobId, status: "queued" }); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "could not queue instrumentation"); } });
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/services", async (request, reply) => { try { return reply.send(await repository.listServices(requireUuid(request.params.projectId))); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid project"); } });
  app.patch<{ Params: { projectId: string; serviceId: string } }>("/api/v1/projects/:projectId/services/:serviceId", async (request, reply) => { try { const projectId = requireUuid(request.params.projectId); const serviceId = requireUuid(request.params.serviceId); const existing = await repository.getService(serviceId); if (!existing || existing.projectId !== projectId) return jsonError(reply, 404, "Service not found"); const config = ServiceConfigSchema.parse(request.body); return reply.send(await repository.updateService(serviceId, { config })); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid service config"); } });
  app.patch<{ Params: { serviceId: string } }>("/api/v1/services/:serviceId", async (request, reply) => { try { const config = ServiceConfigSchema.parse(request.body); const service = await repository.updateService(requireUuid(request.params.serviceId), { config }); return service ? reply.send(service) : jsonError(reply, 404, "Service not found"); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid service config"); } });

  // AI settings are deliberately kept behind server routes. API keys may be
  // submitted here, but are never included in project responses or logs.
  app.get<{ Querystring: { projectId?: string } }>("/api/v1/ai/config", async (request, reply) => { try {
    if (request.query.projectId) {
      const project = await repository.getProject(requireUuid(request.query.projectId));
      return project ? reply.send(publicAiConfig(project.config)) : jsonError(reply, 404, "Project not found");
    }
    const settings = {
      baseUrl: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
      ...(process.env.AI_MODEL ? { model: process.env.AI_MODEL } : {}),
      ...(process.env.AI_APP_NAME ? { appName: process.env.AI_APP_NAME } : {}),
      ...(process.env.AI_APP_URL ? { appUrl: process.env.AI_APP_URL } : {}),
      ...(process.env.AI_ORGANIZATION ? { organization: process.env.AI_ORGANIZATION } : {}),
      apiKeyConfigured: Boolean(process.env.AI_API_KEY),
    };
    return reply.send(settings);
  } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid AI config query"); } });

  app.patch<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/ai", async (request, reply) => { try {
    const projectId = requireUuid(request.params.projectId); const current = await repository.getProject(projectId); if (!current) return jsonError(reply, 404, "Project not found");
    const bodySchema = AiProviderConfigSchema.partial().extend({ clearApiKey: z.boolean().optional() });
    const parsed = bodySchema.safeParse(request.body); if (!parsed.success) return jsonError(reply, 400, parsed.error.message);
    const { clearApiKey, ...updates } = parsed.data;
    const nextAi: Record<string, unknown> = { ...current.config.ai, ...updates };
    if (updates.apiKey === "********") nextAi.apiKey = current.config.ai.apiKey;
    if (clearApiKey) delete nextAi.apiKey;
    const nextConfig = ProjectCreateSchema.shape.config.parse({ ...current.config, ai: nextAi });
    validateAiSettings(nextConfig);
    const updated = await repository.updateProject(projectId, { config: nextConfig });
    return updated ? reply.send(publicProject(updated)) : jsonError(reply, 404, "Project not found");
  } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid AI settings"); } });

  app.get<{ Querystring: { projectId?: string } }>("/api/v1/ai/models", async (request, reply) => { try {
    let client = chatgpt;
    if (request.query.projectId) {
      const project = await repository.getProject(requireUuid(request.query.projectId)); if (!project) return jsonError(reply, 404, "Project not found");
      const settings = aiConfigFromProject(project.config);
      if (!settings.apiKey && !process.env.AI_BASE_URL && !project.config.ai.model && !project.config.modelId) return reply.send({ data: [], source: "unconfigured" });
      client = dependencies.aiFactory?.(project.config) ?? new ChatGPTClient(settings);
    } else if (!process.env.AI_API_KEY && !process.env.AI_BASE_URL) {
      return reply.send({ data: [], source: "unconfigured" });
    }
    const models = (await client.listModels()).filter(selectableModel);
    return reply.send({ data: models, source: "chatgpt-compatible", baseUrl: client.endpoint });
  } catch (error) { return jsonError(reply, error instanceof ChatGPTError && error.status && error.status < 500 ? 400 : 502, error instanceof Error ? error.message : "AI gateway unavailable"); } });

  app.post("/api/v1/ai/models", async (request, reply) => { try {
    const schema = AiProviderConfigSchema.pick({ baseUrl: true, apiKey: true, appName: true, appUrl: true, organization: true }).partial();
    const parsed = schema.safeParse(request.body); if (!parsed.success) return jsonError(reply, 400, parsed.error.message);
    const client = dependencies.aiConnectionFactory?.(parsed.data) ?? new ChatGPTClient(parsed.data); const models = (await client.listModels()).filter(selectableModel);
    return reply.send({ data: models, source: "chatgpt-compatible", baseUrl: client.endpoint });
  } catch (error) { return jsonError(reply, error instanceof ChatGPTError && error.status && error.status < 500 ? 400 : 502, error instanceof Error ? error.message : "AI gateway unavailable"); } });

  app.post("/api/v1/ai/test", async (request, reply) => { try {
    const parsed = AiConnectionSchema.safeParse(request.body); if (!parsed.success) return jsonError(reply, 400, parsed.error.message);
    const client = dependencies.aiConnectionFactory?.(parsed.data) ?? new ChatGPTClient(parsed.data); const response = await client.chat({ modelId: parsed.data.model, messages: [{ role: "user", content: "Reply with exactly OK.", }], maxTokens: 8, temperature: 0 });
    return reply.send({ ok: true, id: response.id, model: response.model ?? parsed.data.model, usage: response.usage, baseUrl: client.endpoint });
  } catch (error) { return jsonError(reply, error instanceof ChatGPTError && error.status && error.status < 500 ? 400 : 502, error instanceof Error ? error.message : "AI gateway test failed"); } });

  app.get<{ Querystring: { projectId?: string; unread?: string; limit?: string } }>("/api/v1/notifications", async (request, reply) => { try { if (!repository.listNotifications) return reply.send([]); const projectId = request.query.projectId ? requireUuid(request.query.projectId) : undefined; const limit = request.query.limit ? Math.max(1, Math.min(200, Number.parseInt(request.query.limit, 10) || 50)) : undefined; return reply.send(await repository.listNotifications({ ...(projectId ? { projectId } : {}), unreadOnly: request.query.unread === "true", ...(limit ? { limit } : {}) })); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid notification query"); } });
  app.post<{ Params: { notificationId: string } }>("/api/v1/notifications/:notificationId/read", async (request, reply) => { try { if (!repository.markNotificationRead) return jsonError(reply, 501, "In-app notifications are not available"); const notification = await repository.markNotificationRead(requireUuid(request.params.notificationId)); return notification ? reply.send(notification) : jsonError(reply, 404, "Notification not found"); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid notification"); } });

  app.get<{ Querystring: { projectId?: string } }>("/api/v1/incidents", async (request, reply) => { try { return reply.send(await repository.listIncidents(request.query.projectId ? requireUuid(request.query.projectId) : undefined)); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid project"); } });
  app.get<{ Params: { incidentId: string } }>("/api/v1/incidents/:incidentId", async (request, reply) => { try { const incident = await repository.getIncident(requireUuid(request.params.incidentId)); if (!incident) return jsonError(reply, 404, "Incident not found"); const events = await repository.listEvents({ incidentId: incident.id }); return reply.send({ incident, events }); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "invalid incident"); } });
  app.post<{ Params: { incidentId: string } }>("/api/v1/incidents/:incidentId/retry", async (request, reply) => { try { const incident = await repository.getIncident(requireUuid(request.params.incidentId)); if (!incident) return jsonError(reply, 404, "Incident not found"); const jobId = await queue.publish("remediate", { projectId: incident.projectId, serviceId: incident.serviceId, incidentId: incident.id }); return reply.code(202).send({ jobId, status: "queued" }); } catch (error) { return jsonError(reply, 400, error instanceof Error ? error.message : "could not retry incident"); } });
  app.post<{ Params: { incidentId: string } }>("/api/v1/incidents/:incidentId/rollback", async (request, reply) => { try { const incident = await repository.getIncident(requireUuid(request.params.incidentId)); if (!incident?.backupId) return jsonError(reply, 409, "No backup is available for this incident"); const project = await repository.getProject(incident.projectId); if (!project) return jsonError(reply, 404, "Project not found"); await agent.execute({ operation: "rollback", projectName: project.config.composeProjectName, backupId: incident.backupId }); await repository.updateIncident(incident.id, { stage: "rolled_back", outcome: "rolled_back" }); return reply.send({ status: "rolled_back" }); } catch (error) { return jsonError(reply, 500, error instanceof Error ? error.message : "rollback failed"); } });

  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack(); const response = reply.raw; response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); response.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const unsubscribe = hub.subscribe((event) => { response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000); request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });
  app.post<{ Headers: { "x-hub-signature-256"?: string } }>("/api/v1/webhooks/github", { config: { rawBody: true } }, async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    if (!github.verifyWebhook(raw, request.headers["x-hub-signature-256"])) return jsonError(reply, 401, "Invalid GitHub webhook signature");
    const eventHeader = request.headers["x-github-event"]; const eventName = Array.isArray(eventHeader) ? eventHeader[0] ?? "unknown" : eventHeader ?? "unknown"; const deliveryHeader = request.headers["x-github-delivery"]; const delivery = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader; if (delivery && await repository.claimWebhookDelivery?.(delivery) === false) return reply.code(202).send({ accepted: true, replayed: true }); const body = typeof request.body === "object" && request.body ? request.body as Record<string, unknown> : {};
    await repository.addEvent({ type: `github.${eventName}`, payload: { delivery, bodyHash: createHash("sha256").update(raw).digest("hex"), action: body.action } });
    if (eventName === "pull_request" && body.pull_request && typeof body.pull_request === "object") {
      const pullRequest = body.pull_request as { head?: { ref?: string }; merged?: boolean; html_url?: string }; const branch = pullRequest.head?.ref;
      if (branch?.startsWith("fixops/")) {
        const incident = (await repository.listIncidents()).find((candidate) => candidate.branchName === branch);
        if (incident) {
          if (body.action === "closed" && !pullRequest.merged) {
            const project = await repository.getProject(incident.projectId);
            if (project && incident.backupId) { try { await agent.execute({ operation: "rollback", projectName: project.config.composeProjectName, backupId: incident.backupId }); await repository.updateIncident(incident.id, { stage: "rolled_back", outcome: "rolled_back" }); } catch (error) { await repository.updateIncident(incident.id, { stage: "needs_human", outcome: "needs_human", error: error instanceof Error ? error.message : "rollback failed after PR close" }); } }
          } else if (body.action === "closed" && pullRequest.merged) {
            await repository.updateIncident(incident.id, { stage: "resolved", outcome: "repaired_and_deployed", pullRequestUrl: pullRequest.html_url ?? incident.pullRequestUrl });
            await queue.publish("health-check", { projectId: incident.projectId, serviceId: incident.serviceId });
          }
        }
      }
    }
    return reply.code(202).send({ accepted: true });
  });

  return { app, close: async () => { if (inlineMonitor) clearInterval(inlineMonitor); await app.close(); await queue.stop(); await repository.close(); } };
}

if (process.env.NODE_ENV !== "test") {
  const { app } = await buildServer(); const port = Number(process.env.PORT ?? 3000); const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && process.env.ALLOW_INSECURE_REMOTE !== "true") throw new Error("Refusing to bind FixOps API remotely without ALLOW_INSECURE_REMOTE=true");
  await app.listen({ port, host }); console.log(`FixOps API listening at http://${host}:${port}`);
}
