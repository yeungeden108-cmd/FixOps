import { randomUUID } from "node:crypto";
import type { AgentOperation, AiDiagnosis, DiscoveredService, HealthResult, Incident, ProjectConfig } from "@fixops/contracts";
import { nowIso } from "@fixops/contracts";
import { assertSafeValidationCommand, discoverComposeServices, isAllowedComposePatchPath, isAllowedHealthComposeDiff, isAllowedPatchPath, parseFixOpsOverrides, parseUnifiedDiffPaths, redactSecrets, transitionHealth, type ComposeConfigInput, type FileSnapshot } from "@fixops/core";
import type { IncidentCreateInput, JobQueue, ProjectRecord, Repository } from "@fixops/db";
import { AgentClient, GitHubService, IncidentMailer } from "@fixops/integrations";
import { ChatGPTClient, ChatGPTError } from "@fixops/chatgpt";

export interface WorkerDependencies {
  repository: Repository;
  queue?: JobQueue;
  agent: AgentClient;
  /** Default AI client. Per-project settings are used when aiFactory is set. */
  chatgpt: ChatGPTClient;
  aiFactory?: (config: ProjectConfig) => ChatGPTClient;
  github: GitHubService;
  mailer: IncidentMailer;
  publish?: (event: import("@fixops/contracts").FixOpsEvent) => Promise<void>;
}

interface Counter { failures: number; successes: number; lastStatus: "healthy" | "unhealthy" | "unknown"; }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function packageTool(files: Array<{ path: string; content: string }>): { command: string[]; run: string } {
  const packageFile = files.find((file) => file.path === "package.json" || file.path.endsWith("/package.json"));
  let packageManager = "npm";
  let scripts: Record<string, string> = {};
  if (packageFile) { try { const parsed = JSON.parse(packageFile.content) as { packageManager?: string; scripts?: Record<string, string> }; scripts = parsed.scripts ?? {}; if (parsed.packageManager?.startsWith("pnpm")) packageManager = "pnpm"; else if (parsed.packageManager?.startsWith("yarn")) packageManager = "yarn"; } catch { /* use npm defaults */ } }
  if (packageManager === "npm" && files.some((file) => file.path === "pnpm-lock.yaml")) packageManager = "pnpm";
  if (packageManager === "npm" && files.some((file) => file.path === "yarn.lock")) packageManager = "yarn";
  const lock = files.some((file) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file.path));
  const install = packageManager === "pnpm" ? ["pnpm", "install", ...(lock ? ["--frozen-lockfile"] : []), "--ignore-scripts"] : packageManager === "yarn" ? ["yarn", "install", ...(lock ? ["--immutable"] : []), "--mode", "skip-builds"] : ["npm", lock ? "ci" : "install", "--ignore-scripts"];
  return { command: install, run: packageManager };
}

function validationCommands(files: Array<{ path: string; content: string }>, proposed: string[][]): string[][] {
  if (proposed.length) return proposed;
  const packageFile = files.find((file) => file.path === "package.json" || file.path.endsWith("/package.json"));
  if (!packageFile) return [];
  try { const scripts = (JSON.parse(packageFile.content) as { scripts?: Record<string, string> }).scripts ?? {}; const tool = packageTool(files).run; return ["lint", "typecheck", "test", "build"].filter((name) => Boolean(scripts[name])).map((name) => [tool, "run", name]); } catch { return []; }
}

function isAllowedRemediationPatch(path: string, unifiedDiff: string): boolean {
  return isAllowedPatchPath(path) || (isAllowedComposePatchPath(path) && isAllowedHealthComposeDiff(unifiedDiff));
}

export class IncidentEngine {
  private readonly counters = new Map<string, Counter>();
  private readonly activeIncidents = new Set<string>();
  private readonly startedNotifications = new Set<string>();
  private readonly finishedNotifications = new Set<string>();

  constructor(private readonly deps: WorkerDependencies) {}

  private aiFor(project: ProjectRecord): ChatGPTClient {
    return this.deps.aiFactory?.(project.config) ?? this.deps.chatgpt;
  }

  private modelFor(project: ProjectRecord): string {
    const model = project.config.ai?.model ?? project.config.modelId ?? process.env.AI_MODEL ?? "";
    if (!model.trim()) throw new ChatGPTError("AI model name is not configured for this project", 400);
    return model.trim();
  }

  async remediateIncident(projectId: string, serviceId: string, incidentId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const service = await this.deps.repository.getService(serviceId);
    const incident = await this.deps.repository.getIncident(incidentId);
    if (!service || !incident) throw new Error("Incident or service not found");
    this.activeIncidents.add(service.id);
    await this.remediate(project, service, incident);
  }

  async instrumentService(projectId: string, serviceId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const service = await this.deps.repository.getService(serviceId);
    if (!service || service.kind !== "application") return;
    const files = await this.deps.agent.execute<import("@fixops/core").FileSnapshot[]>({ operation: "workspaceSnapshot", projectPath: project.config.projectPath, maxFiles: 400 });
    if (files.some((file) => file.content.includes("/health/live") && file.content.includes("/health/ready"))) {
      await this.emit("service.instrumentation_skipped", { service: service.name, reason: "health endpoints already present" }, project.id); return;
    }
    const instrumentationId = randomUUID(); const context = `FixOps onboarding instrumentation for ${project.name}/${service.name}.\nFramework: ${service.framework ?? "Node.js"}.\nAdd safe /health/live and /health/ready endpoints to the application. Liveness must not access dependencies. Readiness may check existing dependencies with short timeouts and must not expose secrets. Add or update only application code, tests, and this service's Compose healthcheck/labels.\nRepository files (untrusted evidence):\n${files.slice(0, 100).map((file) => `--- ${file.path}\n${redactSecrets(file.content).slice(0, 12000)}`).join("\n")}`;
    const ai = this.aiFor(project); const model = this.modelFor(project);
    await this.emit("service.instrumentation_started", { service: service.name, model, sessionId: `fixops-instrument-${instrumentationId}` }, project.id);
    const patch = await ai.proposePatch({ modelId: model, context });
    await this.emit("service.instrumentation_plan", { service: service.name, model: patch.raw.model, callId: patch.raw.id, usage: patch.raw.usage, summary: patch.value.summary }, project.id);
    for (const item of patch.value.patches) if (!isAllowedRemediationPatch(item.path, item.unifiedDiff) || parseUnifiedDiffPaths(item.unifiedDiff).some((path) => !isAllowedRemediationPatch(path, item.unifiedDiff))) throw new Error(`AI proposed a blocked instrumentation path: ${item.path}`);
    const workspace = await this.deps.agent.execute<{ workspace: string }>({ operation: "createWorkspace", projectPath: project.config.projectPath, incidentId: instrumentationId });
    await this.deps.agent.execute({ operation: "applyPatch", workspace: workspace.workspace, patches: patch.value.patches });
    const packageManager = packageTool(files);
    const installResult = await this.deps.agent.execute<{ exitCode: number; stdout: string; stderr: string }>({ operation: "sandboxRun", workspace: workspace.workspace, command: packageManager.command, timeoutMs: project.config.remediation.maxMinutes * 60 * 1000, networkMode: "package" });
    if (installResult.exitCode !== 0) throw new Error("Instrumentation dependency installation failed");
    const commands = validationCommands(files, patch.value.validationCommands);
    if (!commands.length && !patch.value.testsToAdd.length) throw new Error("Instrumentation has no safe validation command");
    for (const command of commands.slice(0, 8)) { assertSafeValidationCommand(command); const result = await this.deps.agent.execute<{ exitCode: number; stdout: string; stderr: string }>({ operation: "sandboxRun", workspace: workspace.workspace, command, timeoutMs: project.config.remediation.maxMinutes * 60 * 1000, networkMode: "none" }); await this.emit("service.instrumentation_validation", { service: service.name, command, exitCode: result.exitCode, output: redactSecrets(`${result.stdout}\n${result.stderr}`).slice(-12000) }, project.id); if (result.exitCode !== 0) throw new Error(`Instrumentation validation failed for ${command.join(" ")}`); }
    if (!project.config.remediation.autoDeploy) { await this.emit("service.instrumentation_ready_for_review", { service: service.name, reason: "automatic candidate deployment is disabled" }, project.id); return; }
    const snapshot = await this.deps.agent.execute<{ id: string }>({ operation: "snapshot", projectPath: project.config.projectPath, composeFiles: project.config.composeFiles, projectName: project.config.composeProjectName, services: [service.name] });
    try {
      await this.deps.agent.execute({ operation: "deployCandidate", projectName: project.config.composeProjectName, composeFiles: project.config.composeFiles, workspace: workspace.workspace, services: [service.name], incidentId: instrumentationId });
      if (!(await this.probeService(project, service))) throw new Error("Instrumented candidate failed health verification");
    } catch (error) { await this.deps.agent.execute({ operation: "rollback", projectName: project.config.composeProjectName, backupId: snapshot.id }); throw error; }
    const diff = await this.deps.agent.execute<{ files: string[] }>({ operation: "workspaceDiff", workspace: workspace.workspace }); const changedFiles = diff.files.length ? await this.deps.agent.execute<Array<{ path: string; content: string }>>({ operation: "workspaceFiles", workspace: workspace.workspace, paths: diff.files }) : [];
    const branch = `fixops/health-${service.name}-${instrumentationId.slice(0, 8)}`;
    const pr = await this.deps.github.createPullRequest({ owner: project.config.github.owner, repo: project.config.github.repo, ...(project.config.github.installationId !== undefined ? { installationId: project.config.github.installationId } : {}), branch, base: project.config.github.defaultBranch, title: `chore: add health checks for ${service.name}`, body: `FixOps added liveness/readiness checks for **${service.name}**. The candidate was tested, backed up and deployed. Merge this PR to reconcile the default branch; close it to roll back the candidate.`, files: changedFiles });
    await this.emit("service.instrumentation_finished", { service: service.name, branch, pullRequestUrl: pr.url }, project.id);
  }

  private async emit(type: string, payload: Record<string, unknown>, projectId?: string, incidentId?: string): Promise<void> {
    const event = await this.deps.repository.addEvent({ type, payload, ...(projectId ? { projectId } : {}), ...(incidentId ? { incidentId } : {}) });
    await this.deps.publish?.(event);
  }

  async discover(projectId: string): Promise<{ services: DiscoveredService[] }> {
    const project = await this.requireProject(projectId);
    const config = await this.deps.agent.execute<Record<string, unknown>>({ operation: "discover", projectPath: project.config.projectPath, composeFiles: project.config.composeFiles, projectName: project.config.composeProjectName });
    const compose = config as ComposeConfigInput;
    let files: import("@fixops/core").FileSnapshot[] = [];
    try { files = await this.deps.agent.execute<import("@fixops/core").FileSnapshot[]>({ operation: "workspaceSnapshot", projectPath: project.config.projectPath, maxFiles: 400 }); } catch { /* discovery remains useful when source inspection is unavailable */ }
    const overridesFile = files.find((file) => file.path === ".fixops.yml" || file.path === ".fixops.yaml");
    const overrides = overridesFile ? parseFixOpsOverrides(overridesFile.content) : {};
    const discovered = discoverComposeServices(projectId, compose, files).map((service) => { const override = overrides[service.name]; return override ? { ...service, config: { ...service.config, ...override } } : service; });
    const services = await this.deps.repository.replaceServices(projectId, discovered);
    await this.deps.repository.updateProject(projectId, { status: "monitoring" });
    await this.emit("project.discovered", { count: services.length, services: services.map((service) => ({ name: service.name, kind: service.kind, framework: service.framework })) }, projectId);
    for (const service of services) if (service.kind === "application" && !files.some((file) => file.content.includes("/health/live") && file.content.includes("/health/ready"))) await this.deps.queue?.publish("instrument", { projectId, serviceId: service.id });
    return { services };
  }

  async runHealthCheck(projectId: string, onlyServiceId?: string): Promise<void> {
    const project = await this.requireProject(projectId); const services = await this.deps.repository.listServices(projectId);
    for (const service of services.filter((item) => item.config.enabled && (!onlyServiceId || item.id === onlyServiceId))) {
      await this.checkService(project, service);
    }
  }

  private async checkService(project: ProjectRecord, service: DiscoveredService): Promise<void> {
    const config = service.config; const baseUrl = config.baseUrl ?? (config.port ? `http://127.0.0.1:${config.port}` : undefined);
    if (!baseUrl) { await this.deps.repository.updateService(service.id, { status: "unknown", lastCheckedAt: nowIso() }); await this.emit("service.check_skipped", { reason: "No base URL or published port configured" }, project.id); return; }
    const [live, ready] = await Promise.all([
      this.deps.agent.execute<HealthResult>({ operation: "probe", service: service.name, url: new URL(config.livenessPath, baseUrl).toString(), timeoutMs: project.config.monitoring.timeoutSeconds * 1000 }),
      this.deps.agent.execute<HealthResult>({ operation: "probe", service: service.name, url: new URL(config.readinessPath, baseUrl).toString(), timeoutMs: project.config.monitoring.timeoutSeconds * 1000 }),
    ]);
    const healthy = live.status === "healthy" && ready.status === "healthy";
    await this.deps.repository.recordHealthSample?.({ projectId: project.id, serviceId: service.id, status: healthy ? "healthy" : live.status === "timeout" || ready.status === "timeout" ? "timeout" : "unhealthy", live, ready, checkedAt: nowIso() });
    const current = this.counters.get(service.id) ?? { failures: 0, successes: 0, lastStatus: "unknown" as const };
    const counter: Counter = healthy ? { failures: 0, successes: current.successes + 1, lastStatus: "healthy" } : { failures: current.failures + 1, successes: 0, lastStatus: "unhealthy" };
    this.counters.set(service.id, counter);
    const nextStatus = transitionHealth({ status: service.status, consecutiveFailures: counter.failures, consecutiveSuccesses: counter.successes, failureThreshold: project.config.monitoring.failureThreshold, recoveryThreshold: project.config.monitoring.recoveryThreshold });
    if (nextStatus !== "unchanged") await this.deps.repository.updateService(service.id, { status: nextStatus === "unhealthy" ? "unhealthy" : nextStatus === "healthy" ? "healthy" : nextStatus, lastCheckedAt: nowIso() });
    await this.emit("service.health", { service: service.name, live, ready, status: nextStatus, failures: counter.failures, successes: counter.successes }, project.id);
    if (!healthy && counter.failures >= project.config.monitoring.failureThreshold && service.config.critical && !this.activeIncidents.has(service.id)) await this.openIncident(project, service, live, ready);
  }

  private async openIncident(project: ProjectRecord, service: DiscoveredService, live: HealthResult, ready: HealthResult): Promise<void> {
    this.activeIncidents.add(service.id);
    const incident = await this.deps.repository.createIncident({ projectId: project.id, serviceId: service.id, serviceName: service.name, severity: "critical", reason: `liveness=${live.status}; readiness=${ready.status}` });
    await this.emit("incident.detected", { reason: incident.reason }, project.id, incident.id);
    await this.sendStarted(project, incident);
    void this.handleIncident(project, service, incident).catch(async (error) => { await this.failIncident(project, incident, error); });
  }

  private async handleIncident(project: ProjectRecord, service: DiscoveredService, incident: Incident): Promise<void> {
    const config = project.config;
    await this.setStage(incident, "restarting");
    await this.deps.agent.execute({ operation: "restart", projectPath: config.projectPath, composeFiles: config.composeFiles, projectName: config.composeProjectName, service: service.name });
    await this.emit("incident.restart", { service: service.name }, project.id, incident.id);
    await sleep(config.monitoring.restartGraceSeconds * 1000);
    const recovered = await this.probeServiceRepeated(project, service, config.monitoring.recoveryThreshold);
    if (recovered) { await this.finishIncident(project, incident, "resolved", "recovered_by_restart", "Service recovered after the controlled restart."); return; }
    if (!config.remediation.enabled) { await this.finishIncident(project, incident, "needs_human", "needs_human", "Automatic remediation is disabled for this project."); return; }
    await this.remediate(project, service, incident);
  }

  private async probeService(project: ProjectRecord, service: DiscoveredService): Promise<boolean> {
    const baseUrl = service.config.baseUrl ?? (service.config.port ? `http://127.0.0.1:${service.config.port}` : undefined); if (!baseUrl) return false;
    const results = await Promise.all([this.deps.agent.execute<HealthResult>({ operation: "probe", service: service.name, url: new URL(service.config.livenessPath, baseUrl).toString(), timeoutMs: project.config.monitoring.timeoutSeconds * 1000 }), this.deps.agent.execute<HealthResult>({ operation: "probe", service: service.name, url: new URL(service.config.readinessPath, baseUrl).toString(), timeoutMs: project.config.monitoring.timeoutSeconds * 1000 })]);
    return results.every((result) => result.status === "healthy");
  }

  private async probeServiceRepeated(project: ProjectRecord, service: DiscoveredService, threshold: number): Promise<boolean> {
    for (let attempt = 0; attempt < threshold; attempt += 1) {
      if (!(await this.probeService(project, service))) return false;
    }
    return true;
  }

  private async remediate(project: ProjectRecord, service: DiscoveredService, incident: Incident): Promise<void> {
    const config = project.config;
    const startedAt = Date.now();
    const ensureTimeBudget = () => { if (Date.now() - startedAt > config.remediation.maxMinutes * 60 * 1000) throw new Error(`Remediation exceeded ${config.remediation.maxMinutes} minutes`); };
    let totalCost = 0;
    const recordCost = (cost: number | undefined) => { const numericCost = Number(cost ?? 0); if (Number.isFinite(numericCost)) totalCost += numericCost; if (totalCost > config.maxIncidentCostUsd) throw new Error(`Remediation cost cap of $${config.maxIncidentCostUsd} exceeded`); };
    await this.setStage(incident, "diagnosing");
    const [files, logs] = await Promise.all([
      this.deps.agent.execute<FileSnapshot[]>({ operation: "workspaceSnapshot", projectPath: config.projectPath, maxFiles: 400 }),
      this.deps.agent.execute<{ logs: string }>({ operation: "tailLogs", projectPath: config.projectPath, composeFiles: config.composeFiles, projectName: config.composeProjectName, service: service.name, lines: 500 }),
    ]);
    const context = this.buildContext(project, service, incident, files, logs.logs);
    const ai = this.aiFor(project); const model = this.modelFor(project);
    const diagnosis = await ai.diagnose({ modelId: model, context });
    ensureTimeBudget(); recordCost(diagnosis.raw.usage?.cost);
    await this.deps.repository.updateIncident(incident.id, { diagnosis: diagnosis.value as unknown as Record<string, unknown> });
    await this.emit("incident.diagnosis", { diagnosis: diagnosis.value, model: diagnosis.raw.model, callId: diagnosis.raw.id, usage: diagnosis.raw.usage }, project.id, incident.id);
    if (!diagnosis.value.canAutoFix) { await this.finishIncident(project, incident, "needs_human", "needs_human", diagnosis.value.blockedReason ?? "AI marked this incident as unsafe to auto-fix."); return; }
    await this.setStage(incident, "planning");
    const workspaceResult = await this.deps.agent.execute<{ workspace: string }>({ operation: "createWorkspace", projectPath: config.projectPath, incidentId: incident.id });
    await this.setStage(incident, "patching");
    const packageManager = packageTool(files);
    let patch: Awaited<ReturnType<ChatGPTClient["proposePatch"]>> | undefined;
    let validationError: string | undefined;
    let validated = false;
    for (let iteration = 0; iteration < config.remediation.maxPatchIterations; iteration += 1) {
      ensureTimeBudget();
      const retryContext = validationError ? `\n\nPrevious validation failure (iteration ${iteration}):\n${validationError}` : "";
      patch = await ai.proposePatch({ modelId: model, context: `${context}\n\nDiagnosis:\n${JSON.stringify(diagnosis.value)}${retryContext}` });
      ensureTimeBudget(); recordCost(patch.raw.usage?.cost);
      for (const item of patch.value.patches) {
        if (!isAllowedRemediationPatch(item.path, item.unifiedDiff) || parseUnifiedDiffPaths(item.unifiedDiff).some((path) => !isAllowedRemediationPatch(path, item.unifiedDiff))) throw new Error(`AI proposed a blocked file path: ${item.path}`);
      }
      await this.deps.agent.execute({ operation: "applyPatch", workspace: workspaceResult.workspace, patches: patch.value.patches });
      await this.deps.repository.updateIncident(incident.id, { diagnosis: { ...diagnosis.value, patch: patch.value, patchIteration: iteration + 1 } });
      await this.emit("incident.patch_applied", { iteration: iteration + 1, files: patch.value.patches.map((item) => item.path), summary: patch.value.summary, model: patch.raw.model, callId: patch.raw.id, usage: patch.raw.usage }, project.id, incident.id);
      await this.setStage(incident, "validating");
      const installResult = await this.deps.agent.execute<{ exitCode: number; stdout: string; stderr: string }>({ operation: "sandboxRun", workspace: workspaceResult.workspace, command: packageManager.command, timeoutMs: config.remediation.maxMinutes * 60 * 1000, networkMode: "package" });
      await this.emit("incident.validation", { iteration: iteration + 1, command: packageManager.command, phase: "dependency-install", exitCode: installResult.exitCode, output: redactSecrets(`${installResult.stdout}\n${installResult.stderr}`).slice(-12000) }, project.id, incident.id);
      if (installResult.exitCode !== 0) {
        validationError = "Sandbox dependency installation failed.";
      } else {
        const commands = validationCommands(files, patch.value.validationCommands);
        if (!commands.length) { await this.finishIncident(project, incident, "needs_human", "validation_failed", "No build/test command was available for safe deployment."); return; }
        validationError = undefined;
        for (const command of commands.slice(0, Math.min(8, config.remediation.maxSteps))) {
          assertSafeValidationCommand(command);
          const result = await this.deps.agent.execute<{ exitCode: number; stdout: string; stderr: string }>({ operation: "sandboxRun", workspace: workspaceResult.workspace, command, timeoutMs: config.remediation.maxMinutes * 60 * 1000, networkMode: "none" });
          await this.emit("incident.validation", { iteration: iteration + 1, command, exitCode: result.exitCode, output: redactSecrets(`${result.stdout}\n${result.stderr}`).slice(-12000) }, project.id, incident.id);
          if (result.exitCode !== 0) { validationError = `Validation failed for ${command.join(" ")}.`; break; }
        }
        if (!validationError) validated = true;
      }
      if (validated) break;
      if (iteration + 1 < config.remediation.maxPatchIterations) await this.emit("incident.patch_retry", { iteration: iteration + 1, reason: validationError }, project.id, incident.id);
    }
    if (!validated || !patch) { await this.finishIncident(project, incident, "needs_human", "validation_failed", validationError ?? "Patch validation failed."); return; }
    if (!config.remediation.autoDeploy) { await this.finishIncident(project, incident, "needs_human", "needs_human", "Patch validation passed, but automatic candidate deployment is disabled for this project."); return; }
    await this.setStage(incident, "deploying");
    const snapshot = await this.deps.agent.execute<{ id: string }>({ operation: "snapshot", projectPath: config.projectPath, composeFiles: config.composeFiles, projectName: config.composeProjectName, services: [service.name] });
    await this.deps.repository.updateIncident(incident.id, { backupId: snapshot.id });
    try {
      await this.deps.agent.execute({ operation: "deployCandidate", projectName: config.composeProjectName, composeFiles: config.composeFiles, workspace: workspaceResult.workspace, services: [service.name], incidentId: incident.id });
      await this.setStage(incident, "verifying");
      for (let attempt = 0; attempt < config.monitoring.verifyAttempts; attempt += 1) {
        ensureTimeBudget();
        if (!(await this.probeService(project, service))) throw new Error("Candidate failed health verification");
        if (attempt + 1 < config.monitoring.verifyAttempts) await sleep(config.monitoring.verifyIntervalSeconds * 1000);
      }
    } catch (error) {
      await this.deps.agent.execute({ operation: "rollback", projectName: config.composeProjectName, backupId: snapshot.id });
      await this.finishIncident(project, incident, "rolled_back", "rolled_back", `Candidate deployment failed and the previous image was restored: ${error instanceof Error ? error.message : "unknown error"}`); return;
    }
    const diff = await this.deps.agent.execute<{ files: string[] }>({ operation: "workspaceDiff", workspace: workspaceResult.workspace });
    const changedFiles = diff.files.length ? await this.deps.agent.execute<Array<{ path: string; content: string }>>({ operation: "workspaceFiles", workspace: workspaceResult.workspace, paths: diff.files }) : [];
    const branch = `fixops/incident-${incident.id.slice(0, 8)}`;
    const pr = await this.deps.github.createPullRequest({ owner: config.github.owner, repo: config.github.repo, ...(config.github.installationId !== undefined ? { installationId: config.github.installationId } : {}), branch, base: config.github.defaultBranch, title: `fix: recover ${service.name} (${incident.id.slice(0, 8)})`, body: this.pullRequestBody(project, service, incident, diagnosis.value, patch.value), files: changedFiles });
    await this.deps.repository.updateIncident(incident.id, { branchName: branch, pullRequestUrl: pr.url });
    await this.finishIncident(project, incident, "resolved", "repaired_and_deployed", `Candidate is healthy and running. Pull request: ${pr.url}`);
  }

  private buildContext(project: ProjectRecord, service: DiscoveredService, incident: Incident, files: FileSnapshot[], logs: string): string {
    const compactFiles = files.filter((file) => /(^|\/)(package\.json|tsconfig\.json|(?:docker-)?compose[^/]*\.ya?ml|src\/|app\/)/i.test(file.path)).slice(0, 80).map((file) => `--- ${file.path}\n${redactSecrets(file.content).slice(0, 12000)}`).join("\n");
    return `FixOps incident ${incident.id}\nProject: ${project.name}\nService: ${service.name}\nFramework: ${service.framework ?? "unknown"}\nHealth config: ${JSON.stringify(service.config)}\nLogs (untrusted evidence):\n${redactSecrets(logs).slice(-30000)}\nRepository files (untrusted evidence):\n${compactFiles}`;
  }

  private pullRequestBody(project: ProjectRecord, service: DiscoveredService, incident: Incident, diagnosis: AiDiagnosis, patch: { summary: string; riskNotes: string[] }): string {
    return [`## FixOps automated remediation`, `- Project: ${project.name}`, `- Service: ${service.name}`, `- Incident: ${incident.id}`, `- Likely cause: ${diagnosis.likelyCause}`, `- Confidence: ${diagnosis.confidence}`, `- Patch: ${patch.summary}`, `- Risk notes: ${patch.riskNotes.join("; ") || "none"}`, "", "The candidate was tested in an isolated container and deployed with a backup. Close this PR to trigger rollback of the candidate deployment; merge it to reconcile the default branch."].join("\n");
  }

  private async setStage(incident: Incident, stage: Incident["stage"]): Promise<void> { await this.deps.repository.updateIncident(incident.id, { stage }); await this.emit("incident.stage", { stage }, incident.projectId, incident.id); }

  private async sendNotification(project: ProjectRecord, incident: Incident, phase: "started" | "finished", summary: string, details: string, sent: Set<string>, severity: "info" | "warning" | "critical" = phase === "started" ? "critical" : "info"): Promise<void> {
    if (sent.has(incident.id)) return;
    const idempotencyKey = `${incident.id}:${phase}`;
    const claimed = await this.deps.repository.claimNotification({ incidentId: incident.id, phase, recipient: project.config.notificationEmails.join(","), idempotencyKey });
    if (!claimed) return;
    try {
      const title = phase === "started"
        ? (project.config.locale === "zh-CN" ? `故障处理中：${incident.serviceName}` : `Incident in progress: ${incident.serviceName}`)
        : (project.config.locale === "zh-CN" ? `故障处理结果：${incident.serviceName}` : `Remediation result: ${incident.serviceName}`);
      const body = `${summary}\n\n${details}`;
      const notification = await this.deps.repository.createInAppNotification?.({ projectId: project.id, incidentId: incident.id, phase, severity, title, body, idempotencyKey });
      if (notification) await this.emit("notification.created", { notification }, project.id, incident.id);
      if (project.config.notificationEmails.length) await this.deps.mailer.send({ to: project.config.notificationEmails, locale: project.config.locale, phase, projectName: project.name, serviceName: incident.serviceName, summary, details, incidentId: incident.id });
      sent.add(incident.id);
    } catch (error) {
      await this.deps.repository.releaseNotification?.(idempotencyKey);
      await this.emit("notification.failed", { phase, error: error instanceof Error ? error.message : "notification failed" }, project.id, incident.id);
    }
  }

  private async sendStarted(project: ProjectRecord, incident: Incident): Promise<void> {
    await this.sendNotification(project, incident, "started", project.config.locale === "zh-CN" ? "服务连续健康检查失败，FixOps 已开始受控重启和诊断。" : "The service failed consecutive health checks; FixOps started a controlled restart and diagnosis.", `Reason: ${incident.reason}`, this.startedNotifications);
  }

  private async incidentTrace(incidentId: string): Promise<string> {
    const stored = await this.deps.repository.getIncident(incidentId);
    const events = await this.deps.repository.listEvents({ incidentId, limit: 200 });
    const trace = [
      stored?.diagnosis ? `AI diagnosis and patch:\n${JSON.stringify(stored.diagnosis, null, 2)}` : "",
      ...events.filter((event) => event.type.startsWith("incident.")).map((event) => `${event.createdAt} ${event.type}\n${JSON.stringify(event.payload)}`),
    ].filter(Boolean).join("\n\n");
    return redactSecrets(trace).slice(-30000) || "No AI steps were recorded.";
  }

  private async finishIncident(project: ProjectRecord, incident: Incident, stage: Incident["stage"], outcome: NonNullable<Incident["outcome"]>, details: string): Promise<void> {
    await this.deps.repository.updateIncident(incident.id, { stage, outcome });
    await this.emit("incident.finished", { outcome, details }, project.id, incident.id);
    const trace = await this.incidentTrace(incident.id);
    await this.sendNotification(project, incident, "finished", details, `Outcome: ${outcome}\n\nAI repair steps and verification trace:\n${trace}`, this.finishedNotifications);
    this.activeIncidents.delete(incident.serviceId);
    this.counters.set(incident.serviceId, { failures: 0, successes: 0, lastStatus: "healthy" });
  }

  private async failIncident(project: ProjectRecord, incident: Incident, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown failure";
    const outcome = error instanceof ChatGPTError ? (error.status && error.status >= 400 && error.status < 500 ? "model_unavailable" : message.includes("exceeded") ? "timed_out" : "needs_human") : message.includes("exceeded") ? "timed_out" : "needs_human";
    await this.deps.repository.updateIncident(incident.id, { stage: "needs_human", outcome, error: message });
    await this.emit("incident.error", { error: message, outcome }, project.id, incident.id);
    const trace = await this.incidentTrace(incident.id);
    await this.sendNotification(project, incident, "finished", `FixOps could not complete remediation: ${message}`, `Review the incident timeline and restore or fix the service manually.\n\nAI repair steps and verification trace:\n${trace}`, this.finishedNotifications, "warning");
    this.activeIncidents.delete(incident.serviceId);
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> { const project = await this.deps.repository.getProject(projectId); if (!project) throw new Error(`Project not found: ${projectId}`); return project; }
}

export function createDefaultEngine(dependencies: WorkerDependencies): IncidentEngine { return new IncidentEngine(dependencies); }
