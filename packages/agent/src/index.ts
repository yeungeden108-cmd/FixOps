import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import Docker from "dockerode";
import { execa } from "execa";
import Fastify, { type FastifyInstance } from "fastify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentOperationSchema, type AgentOperation, type HealthResult } from "@fixops/contracts";
import { assertSafeValidationCommand, isAllowedComposePatchPath, isAllowedHealthComposeDiff, isAllowedPatchPath } from "@fixops/core";

export interface SnapshotService {
  service: string;
  image: string;
  containerId?: string;
}

export interface AgentSnapshot {
  id: string;
  projectName: string;
  projectPath: string;
  composeFiles: string[];
  services: SnapshotService[];
  renderedCompose?: Record<string, unknown>;
  createdAt: string;
}

export interface HostAgentOptions {
  dataDir?: string;
  socketPath?: string;
  composeBinary?: string;
  dockerImage?: string;
  allowedRoots?: string[];
}

export interface HostAgent {
  execute(operation: AgentOperation): Promise<unknown>;
}

function defaultSocketPath(): string {
  return process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
}

function detectWorkspaceRoot(): string {
  const cwd = resolve(process.cwd());
  const candidates = [cwd, resolve(cwd, ".."), resolve(cwd, "../..")];
  return candidates.find((candidate) => existsSync(join(candidate, "pnpm-workspace.yaml"))) ?? cwd;
}

function parseComposeJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    return { services: Object.fromEntries(lines.map((line) => [line, {}])) };
  }
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim(); if (!trimmed) return [];
  try { const value = JSON.parse(trimmed) as unknown; return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [value as Record<string, unknown>]; } catch { return trimmed.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { const value = JSON.parse(line) as Record<string, unknown>; return [value]; } catch { return []; } }); }
}

function composeArgs(composeFiles: string[], projectName: string, args: string[]): string[] {
  return ["compose", "-p", projectName, ...composeFiles.flatMap((file) => ["-f", file]), ...args];
}

function isAllowedRemediationPatch(path: string, unifiedDiff: string): boolean {
  return isAllowedPatchPath(path) || (isAllowedComposePatchPath(path) && isAllowedHealthComposeDiff(unifiedDiff));
}

export class DockerHostAgent implements HostAgent {
  readonly docker: Docker;
  readonly dataDir: string;
  private readonly composeBinary: string;
  private readonly dockerImage: string;
  private readonly allowedRoots: string[];

  constructor(options: HostAgentOptions = {}) {
    this.docker = new Docker({ socketPath: options.socketPath ?? defaultSocketPath() });
    const workspaceRoot = detectWorkspaceRoot();
    this.dataDir = resolve(workspaceRoot, options.dataDir ?? process.env.FIXOPS_DATA_DIR ?? ".fixops-data");
    this.composeBinary = options.composeBinary ?? "docker";
    this.dockerImage = options.dockerImage ?? "node:22-bookworm-slim";
    this.allowedRoots = (options.allowedRoots ?? [process.env.FIXOPS_PROJECT_ROOT ?? workspaceRoot, this.dataDir, process.env.FIXOPS_WORKSPACE_ROOT ?? ".fixops-workspaces"]).map((root) => resolve(workspaceRoot, root));
  }

  private assertProjectPath(projectPath: string): string {
    const absolute = resolve(projectPath);
    if (!this.allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`))) {
      throw new Error(`Project path is outside an allowed root: ${absolute}`);
    }
    return absolute;
  }

  private assertComposeFile(projectRoot: string, file: string): string {
    if (!file || !/\.ya?ml$/i.test(file)) throw new Error(`Compose file must be YAML: ${file}`);
    const absolute = resolve(projectRoot, file);
    if (!this.isWithin(projectRoot, absolute)) throw new Error(`Compose file is outside the project root: ${file}`);
    return relative(projectRoot, absolute).replaceAll("\\", "/");
  }

  private isWithin(root: string, candidate: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedCandidate = resolve(candidate);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${normalizedCandidate.includes("\\") ? "\\" : "/"}`);
  }

  private assertComposeProjectName(projectName: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(projectName)) throw new Error("Invalid Compose project name");
    return projectName;
  }

  private assertServiceName(service: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service)) throw new Error("Invalid Compose service name");
    return service;
  }

  private async compose(projectPath: string, composeFiles: string[], projectName: string, args: string[], timeoutMs = 120000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cwd = this.assertProjectPath(projectPath);
    const files = composeFiles.map((file) => this.assertComposeFile(cwd, file));
    const result = await execa(this.composeBinary, composeArgs(files, this.assertComposeProjectName(projectName), args), { cwd, timeout: timeoutMs, reject: false });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  }

  async discover(input: Extract<AgentOperation, { operation: "discover" }>): Promise<Record<string, unknown>> {
    const result = await this.compose(input.projectPath, input.composeFiles, input.projectName, ["config", "--format", "json"]);
    if (result.exitCode !== 0) throw new Error(result.stderr || "docker compose config failed");
    return parseComposeJson(result.stdout);
  }

  async workspaceSnapshot(input: Extract<AgentOperation, { operation: "workspaceSnapshot" }>): Promise<Array<{ path: string; content: string }>> {
    const root = this.assertProjectPath(input.projectPath); const realRoot = await realpath(root).catch(() => root); const output: Array<{ path: string; content: string }> = [];
    const ignored = new Set([".git", "node_modules", ".fixops-data", ".fixops-workspaces", "dist", "build", ".next"]);
    const walk = async (directory: string): Promise<void> => {
      if (output.length >= input.maxFiles) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        const resolved = await realpath(full).catch(() => ""); if (!resolved || !this.isWithin(realRoot, resolved)) continue;
        const info = await stat(resolved); if (info.size > 256 * 1024) continue;
        const path = relative(root, full).replaceAll("\\", "/");
        if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|md|lock|env\.example)$/i.test(path)) continue;
        output.push({ path, content: await readFile(full, "utf8") });
        if (output.length >= input.maxFiles) return;
      }
    };
    await walk(root); return output;
  }

  async createWorkspace(input: Extract<AgentOperation, { operation: "createWorkspace" }>): Promise<{ workspace: string }> {
    const source = this.assertProjectPath(input.projectPath); const root = process.env.FIXOPS_WORKSPACE_ROOT ? resolve(detectWorkspaceRoot(), process.env.FIXOPS_WORKSPACE_ROOT) : join(this.dataDir, "workspaces");
    await mkdir(root, { recursive: true }); const workspace = join(root, input.incidentId);
    try { await execa("git", ["-C", source, "worktree", "add", "--detach", workspace, "HEAD"], { timeout: 120000 }); }
    catch { await cp(source, workspace, { recursive: true, filter: (path) => !/(^|[\\/])(node_modules|\.fixops-data|\.fixops-workspaces|\.git)([\\/]|$)/.test(path) && !/(^|[\\/])\.env(?:\.|$)/i.test(path) && !/(^|[\\/])(secrets?|credentials?)([\\/]|$)/i.test(path) }); }
    return { workspace };
  }

  async applyPatch(input: Extract<AgentOperation, { operation: "applyPatch" }>): Promise<{ applied: string[] }> {
    const workspace = this.assertProjectPath(input.workspace);
    for (const patch of input.patches) {
      if (!isAllowedRemediationPatch(patch.path, patch.unifiedDiff)) throw new Error(`Patch path is blocked: ${patch.path}`);
      const paths = patch.unifiedDiff.match(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)?.map((line) => line.replace(/^(?:\+\+\+ b\/|--- a\/)/, "")) ?? [];
      if (paths.some((path) => !isAllowedRemediationPatch(path, patch.unifiedDiff))) throw new Error("Patch contains a blocked file path");
    }
    const patchFile = join(workspace, ".fixops.patch"); await writeFile(patchFile, input.patches.map((patch) => patch.unifiedDiff).join("\n"), "utf8");
    const check = await execa("git", ["-C", workspace, "apply", "--check", patchFile], { reject: false });
    if (check.exitCode !== 0) { await unlink(patchFile).catch(() => undefined); throw new Error(check.stderr || "patch did not apply cleanly"); }
    const applied = await execa("git", ["-C", workspace, "apply", "--whitespace=nowarn", patchFile], { reject: false });
    await unlink(patchFile).catch(() => undefined);
    if (applied.exitCode !== 0) throw new Error(applied.stderr || "patch application failed");
    return { applied: input.patches.map((patch) => patch.path) };
  }

  async workspaceDiff(input: Extract<AgentOperation, { operation: "workspaceDiff" }>): Promise<{ diff: string; files: string[] }> {
    const workspace = this.assertProjectPath(input.workspace); const diff = await execa("git", ["-C", workspace, "diff", "--no-ext-diff"], { reject: false }); const files = await execa("git", ["-C", workspace, "diff", "--name-only"], { reject: false });
    return { diff: diff.stdout, files: files.stdout.split(/\r?\n/).filter(Boolean) };
  }

  async workspaceFiles(input: Extract<AgentOperation, { operation: "workspaceFiles" }>): Promise<Array<{ path: string; content: string }>> {
    const workspace = this.assertProjectPath(input.workspace); return Promise.all(input.paths.map(async (path) => { if (!isAllowedPatchPath(path) && !isAllowedComposePatchPath(path)) throw new Error(`File path is blocked: ${path}`); return { path, content: await readFile(join(workspace, path), "utf8") }; }));
  }

  async probe(input: Extract<AgentOperation, { operation: "probe" }>): Promise<HealthResult> {
    const parsedUrl = new URL(input.url);
    if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("Probe URL must use HTTP(S)");
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(input.url, { signal: controller.signal, headers: { "user-agent": "FixOps-Probe/0.1" } });
      return { status: response.ok ? "healthy" : "unhealthy", statusCode: response.status, latencyMs: Date.now() - started, ...(response.ok ? {} : { detail: `HTTP ${response.status}` }) };
    } catch (error) {
      return { status: error instanceof Error && error.name === "AbortError" ? "timeout" : "unhealthy", latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : "probe failed" };
    } finally { clearTimeout(timer); }
  }

  async tailLogs(input: Extract<AgentOperation, { operation: "tailLogs" }>): Promise<{ logs: string }> {
    const result = await this.compose(input.projectPath, input.composeFiles, input.projectName, ["logs", "--no-color", `--tail=${input.lines}`, this.assertServiceName(input.service)], 30000);
    return { logs: result.stdout || result.stderr };
  }

  async restart(input: Extract<AgentOperation, { operation: "restart" }>): Promise<{ restarted: boolean; output: string }> {
    const result = await this.compose(input.projectPath, input.composeFiles, input.projectName, ["restart", this.assertServiceName(input.service)], 120000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "docker compose restart failed");
    return { restarted: true, output: result.stdout };
  }

  async snapshot(input: Extract<AgentOperation, { operation: "snapshot" }>): Promise<AgentSnapshot> {
    const result = await this.compose(input.projectPath, input.composeFiles, input.projectName, ["ps", "--format", "json"], 30000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "cannot inspect running Compose services for backup");
    const services = parseJsonLines(result.stdout).flatMap((row) => { const service = typeof row.Service === "string" ? row.Service : undefined; const image = typeof row.Image === "string" ? row.Image : undefined; const id = typeof row.ID === "string" ? row.ID : undefined; if (!service || !image || !input.services.includes(service)) return []; return [{ service, image, ...(id ? { containerId: id } : {}) }]; });
    if (!services.length) throw new Error("No running target service image was found for backup");
    const rendered = await this.compose(input.projectPath, input.composeFiles, input.projectName, ["config", "--format", "json"], 30000);
    const snapshot: AgentSnapshot = { id: randomUUID(), projectName: input.projectName, projectPath: input.projectPath, composeFiles: input.composeFiles, services, ...(rendered.exitCode === 0 ? { renderedCompose: parseComposeJson(rendered.stdout) } : {}), createdAt: new Date().toISOString() };
    await mkdir(join(this.dataDir, "backups"), { recursive: true });
    await writeFile(join(this.dataDir, "backups", `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2), "utf8");
    return snapshot;
  }

  async sandboxRun(input: Extract<AgentOperation, { operation: "sandboxRun" }>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    input.command.forEach((_, index) => { if (index === 0) return; });
    assertSafeValidationCommand(input.command);
    const workspace = this.assertProjectPath(input.workspace);
    const args = ["run", "--rm", "--network", input.networkMode === "package" ? "bridge" : "none", "--cpus", "1", "--memory", "1g", "--pids-limit", "128", "--read-only", "--user", "1000:1000", "--tmpfs", "/tmp", "--tmpfs", "/home/node/.npm", "-e", "HOME=/tmp", "-e", "COREPACK_HOME=/tmp/corepack", "-e", "PNPM_HOME=/tmp/pnpm", "-v", `${workspace}:/workspace:rw`, "-w", "/workspace", this.dockerImage, ...input.command];
    const result = await execa(this.composeBinary.replace(/docker(?:\.exe)?$/i, "docker"), args, { timeout: input.timeoutMs, reject: false });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  async deployCandidate(input: Extract<AgentOperation, { operation: "deployCandidate" }>): Promise<{ deployed: boolean; output: string }> {
    const services = input.services.map((service) => this.assertServiceName(service));
    const result = await this.compose(input.workspace, input.composeFiles, input.projectName, ["up", "-d", "--build", "--force-recreate", ...services], 900000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "candidate deployment failed");
    return { deployed: true, output: result.stdout };
  }

  async rollback(input: Extract<AgentOperation, { operation: "rollback" }>): Promise<{ rolledBack: boolean; output: string }> {
    const file = join(this.dataDir, "backups", `${input.backupId}.json`);
    const snapshot = JSON.parse(await readFile(file, "utf8")) as AgentSnapshot;
    const compose = snapshot.renderedCompose ? undefined : await this.compose(snapshot.projectPath, snapshot.composeFiles, snapshot.projectName, ["config", "--format", "json"]);
    if (compose && compose.exitCode !== 0) throw new Error(compose.stderr || "cannot read compose config during rollback");
    const parsed = snapshot.renderedCompose ?? parseComposeJson(compose?.stdout ?? "");
    const services = (parsed.services ?? {}) as Record<string, Record<string, unknown>>;
    for (const previous of snapshot.services) {
      if (!services[previous.service]) continue;
      services[previous.service] = { ...services[previous.service], image: previous.image, build: null };
    }
    const overridePath = join(this.dataDir, "backups", `${input.backupId}.rollback.yaml`);
    await writeFile(overridePath, stringifyYaml({ services }), "utf8");
    const result = await this.compose(snapshot.projectPath, snapshot.composeFiles.concat([overridePath]), snapshot.projectName, ["up", "-d", "--force-recreate", ...snapshot.services.map((service) => service.service)], 300000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "rollback failed");
    return { rolledBack: true, output: result.stdout };
  }

  async execute(operation: AgentOperation): Promise<unknown> {
    const parsed = AgentOperationSchema.parse(operation);
    switch (parsed.operation) {
      case "discover": return this.discover(parsed);
      case "workspaceSnapshot": return this.workspaceSnapshot(parsed);
      case "createWorkspace": return this.createWorkspace(parsed);
      case "applyPatch": return this.applyPatch(parsed);
      case "workspaceDiff": return this.workspaceDiff(parsed);
      case "workspaceFiles": return this.workspaceFiles(parsed);
      case "probe": return this.probe(parsed);
      case "tailLogs": return this.tailLogs(parsed);
      case "restart": return this.restart(parsed);
      case "snapshot": return this.snapshot(parsed);
      case "sandboxRun": return this.sandboxRun(parsed);
      case "deployCandidate": return this.deployCandidate(parsed);
      case "rollback": return this.rollback(parsed);
    }
  }
}

/**
 * A deliberately non-production host adapter for local development and CI.
 * It keeps the same typed operation boundary as DockerHostAgent, but never
 * talks to a container runtime. Probes still use HTTP so the native demo can
 * be exercised end-to-end without Docker Desktop.
 */
export class MockHostAgent implements HostAgent {
  readonly dataDir: string;
  private readonly allowedRoots: string[];

  constructor(options: HostAgentOptions = {}) {
    const workspaceRoot = detectWorkspaceRoot();
    this.dataDir = resolve(workspaceRoot, options.dataDir ?? process.env.FIXOPS_DATA_DIR ?? ".fixops-data");
    this.allowedRoots = (options.allowedRoots ?? [process.env.FIXOPS_PROJECT_ROOT ?? workspaceRoot, this.dataDir, process.env.FIXOPS_WORKSPACE_ROOT ?? ".fixops-workspaces"]).map((root) => resolve(workspaceRoot, root));
  }

  private isWithin(root: string, candidate: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedCandidate = resolve(candidate);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`);
  }

  private assertProjectPath(projectPath: string): string {
    const absolute = resolve(projectPath);
    if (!this.allowedRoots.some((root) => this.isWithin(root, absolute))) throw new Error(`Project path is outside an allowed root: ${absolute}`);
    return absolute;
  }

  private assertComposeFile(projectRoot: string, file: string): string {
    if (!file || !/\.ya?ml$/i.test(file)) throw new Error(`Compose file must be YAML: ${file}`);
    const absolute = resolve(projectRoot, file);
    if (!this.isWithin(projectRoot, absolute)) throw new Error(`Compose file is outside the project root: ${file}`);
    return relative(projectRoot, absolute).replaceAll("\\", "/");
  }

  private assertComposeProjectName(projectName: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(projectName)) throw new Error("Invalid Compose project name");
    return projectName;
  }

  private assertServiceName(service: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service)) throw new Error("Invalid service name");
    return service;
  }

  private async composeConfig(projectPath: string, composeFiles: string[], projectName: string): Promise<Record<string, unknown>> {
    const cwd = this.assertProjectPath(projectPath);
    this.assertComposeProjectName(projectName);
    const merged: Record<string, unknown> = {};
    const serviceMap: Record<string, unknown> = {};
    for (const file of composeFiles.map((item) => this.assertComposeFile(cwd, item))) {
      const parsed = parseYaml(await readFile(join(cwd, file), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Compose file is not an object: ${file}`);
      const document = parsed as Record<string, unknown>;
      Object.assign(merged, document);
      if (document.services && typeof document.services === "object" && !Array.isArray(document.services)) Object.assign(serviceMap, document.services);
    }
    merged.services = serviceMap;
    return merged;
  }

  private async workspaceSnapshot(input: Extract<AgentOperation, { operation: "workspaceSnapshot" }>): Promise<Array<{ path: string; content: string }>> {
    const root = this.assertProjectPath(input.projectPath);
    const realRoot = await realpath(root).catch(() => root);
    const output: Array<{ path: string; content: string }> = [];
    const ignored = new Set([".git", "node_modules", ".fixops-data", ".fixops-workspaces", "dist", "build", ".next"]);
    const walk = async (directory: string): Promise<void> => {
      if (output.length >= input.maxFiles) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        const resolved = await realpath(full).catch(() => "");
        if (!resolved || !this.isWithin(realRoot, resolved)) continue;
        const info = await stat(resolved);
        if (info.size > 256 * 1024) continue;
        const path = relative(root, full).replaceAll("\\", "/");
        if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|md|lock|env\.example)$/i.test(path)) continue;
        output.push({ path, content: await readFile(full, "utf8") });
        if (output.length >= input.maxFiles) return;
      }
    };
    await walk(root);
    return output;
  }

  private async createWorkspace(input: Extract<AgentOperation, { operation: "createWorkspace" }>): Promise<{ workspace: string }> {
    const source = this.assertProjectPath(input.projectPath);
    const root = process.env.FIXOPS_WORKSPACE_ROOT ? resolve(detectWorkspaceRoot(), process.env.FIXOPS_WORKSPACE_ROOT) : join(this.dataDir, "workspaces");
    await mkdir(root, { recursive: true });
    const workspace = join(root, input.incidentId);
    try {
      await execa("git", ["-C", source, "worktree", "add", "--detach", workspace, "HEAD"], { timeout: 120000 });
    } catch {
      await cp(source, workspace, { recursive: true, filter: (path) => !/(^|[\\/])(node_modules|\.fixops-data|\.fixops-workspaces|\.git)([\\/]|$)/.test(path) && !/(^|[\\/])\.env(?:\.|$)/i.test(path) && !/(^|[\\/])(secrets?|credentials?)([\\/]|$)/i.test(path) });
    }
    return { workspace };
  }

  private async applyPatch(input: Extract<AgentOperation, { operation: "applyPatch" }>): Promise<{ applied: string[] }> {
    const workspace = this.assertProjectPath(input.workspace);
    for (const patch of input.patches) {
      if (!isAllowedRemediationPatch(patch.path, patch.unifiedDiff)) throw new Error(`Patch path is blocked: ${patch.path}`);
      const paths = patch.unifiedDiff.match(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)?.map((line) => line.replace(/^(?:\+\+\+ b\/|--- a\/)/, "")) ?? [];
      if (paths.some((path) => !isAllowedRemediationPatch(path, patch.unifiedDiff))) throw new Error("Patch contains a blocked file path");
    }
    const patchFile = join(workspace, ".fixops.patch");
    await writeFile(patchFile, input.patches.map((patch) => patch.unifiedDiff).join("\n"), "utf8");
    const check = await execa("git", ["-C", workspace, "apply", "--check", patchFile], { reject: false });
    if (check.exitCode !== 0) { await unlink(patchFile).catch(() => undefined); throw new Error(check.stderr || "patch did not apply cleanly"); }
    const applied = await execa("git", ["-C", workspace, "apply", "--whitespace=nowarn", patchFile], { reject: false });
    await unlink(patchFile).catch(() => undefined);
    if (applied.exitCode !== 0) throw new Error(applied.stderr || "patch application failed");
    return { applied: input.patches.map((patch) => patch.path) };
  }

  private async workspaceDiff(input: Extract<AgentOperation, { operation: "workspaceDiff" }>): Promise<{ diff: string; files: string[] }> {
    const workspace = this.assertProjectPath(input.workspace);
    const diff = await execa("git", ["-C", workspace, "diff", "--no-ext-diff"], { reject: false });
    const files = await execa("git", ["-C", workspace, "diff", "--name-only"], { reject: false });
    return { diff: diff.stdout, files: files.stdout.split(/\r?\n/).filter(Boolean) };
  }

  private async workspaceFiles(input: Extract<AgentOperation, { operation: "workspaceFiles" }>): Promise<Array<{ path: string; content: string }>> {
    const workspace = this.assertProjectPath(input.workspace);
    return Promise.all(input.paths.map(async (path) => {
      if (!isAllowedPatchPath(path) && !isAllowedComposePatchPath(path)) throw new Error(`File path is blocked: ${path}`);
      return { path, content: await readFile(join(workspace, path), "utf8") };
    }));
  }

  private async probe(input: Extract<AgentOperation, { operation: "probe" }>): Promise<HealthResult> {
    const parsedUrl = new URL(input.url);
    if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("Probe URL must use HTTP(S)");
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(input.url, { signal: controller.signal, headers: { "user-agent": "FixOps-Mock-Probe/0.1" } });
      return { status: response.ok ? "healthy" : "unhealthy", statusCode: response.status, latencyMs: Date.now() - started, ...(response.ok ? {} : { detail: `HTTP ${response.status}` }) };
    } catch (error) {
      return { status: error instanceof Error && error.name === "AbortError" ? "timeout" : "unhealthy", latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : "probe failed" };
    } finally { clearTimeout(timer); }
  }

  private async restart(input: Extract<AgentOperation, { operation: "restart" }>): Promise<{ restarted: boolean; output: string }> {
    this.assertProjectPath(input.projectPath);
    this.assertServiceName(input.service);
    const resetUrl = process.env.FIXOPS_MOCK_RESET_URL;
    if (resetUrl) {
      const parsed = new URL(resetUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("FIXOPS_MOCK_RESET_URL must use HTTP(S)");
      const response = await fetch(parsed, { method: "POST" });
      if (!response.ok) throw new Error(`Mock reset endpoint returned HTTP ${response.status}`);
    }
    return { restarted: true, output: `Mock restart completed for ${input.service}` };
  }

  private async snapshot(input: Extract<AgentOperation, { operation: "snapshot" }>): Promise<AgentSnapshot> {
    const compose = await this.composeConfig(input.projectPath, input.composeFiles, input.projectName);
    const services = (compose.services && typeof compose.services === "object" ? compose.services : {}) as Record<string, Record<string, unknown>>;
    const snapshot: AgentSnapshot = { id: randomUUID(), projectName: input.projectName, projectPath: this.assertProjectPath(input.projectPath), composeFiles: input.composeFiles, services: input.services.map((service) => ({ service, image: typeof services[service]?.image === "string" ? String(services[service].image) : `mock://${input.projectName}/${service}` })), renderedCompose: compose, createdAt: new Date().toISOString() };
    await mkdir(join(this.dataDir, "backups"), { recursive: true });
    await writeFile(join(this.dataDir, "backups", `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2), "utf8");
    return snapshot;
  }

  private async sandboxRun(input: Extract<AgentOperation, { operation: "sandboxRun" }>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    assertSafeValidationCommand(input.command);
    this.assertProjectPath(input.workspace);
    return { exitCode: 0, stdout: `[mock sandbox] skipped execution: ${input.command.join(" ")}`, stderr: "" };
  }

  private async rollback(input: Extract<AgentOperation, { operation: "rollback" }>): Promise<{ rolledBack: boolean; output: string }> {
    if (!/^[0-9a-f-]{36}$/i.test(input.backupId)) throw new Error("Invalid mock backup id");
    await readFile(join(this.dataDir, "backups", `${input.backupId}.json`), "utf8");
    return { rolledBack: true, output: `Mock rollback completed for ${input.projectName}` };
  }

  async execute(operation: AgentOperation): Promise<unknown> {
    const parsed = AgentOperationSchema.parse(operation);
    switch (parsed.operation) {
      case "discover": return this.composeConfig(parsed.projectPath, parsed.composeFiles, parsed.projectName);
      case "workspaceSnapshot": return this.workspaceSnapshot(parsed);
      case "createWorkspace": return this.createWorkspace(parsed);
      case "applyPatch": return this.applyPatch(parsed);
      case "workspaceDiff": return this.workspaceDiff(parsed);
      case "workspaceFiles": return this.workspaceFiles(parsed);
      case "probe": return this.probe(parsed);
      case "tailLogs": this.assertProjectPath(parsed.projectPath); this.assertServiceName(parsed.service); return { logs: "[mock agent] container logs are unavailable; use the demo request timeline." };
      case "restart": return this.restart(parsed);
      case "snapshot": return this.snapshot(parsed);
      case "sandboxRun": return this.sandboxRun(parsed);
      case "deployCandidate": this.assertComposeProjectName(parsed.projectName); this.assertProjectPath(parsed.workspace); return { deployed: true, output: "[mock agent] candidate deployment simulated" };
      case "rollback": return this.rollback(parsed);
    }
  }
}

export async function createAgentServer(agent: HostAgent, token = process.env.AGENT_ENROLLMENT_TOKEN ?? "", port = Number(process.env.AGENT_PORT ?? 4318)): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  app.get("/health/live", async () => ({ status: "ok", agent: "live" }));
  app.post("/v1/operations", async (request, reply) => {
    if (!token || request.headers["x-fixops-agent-token"] !== token) return reply.code(401).send({ error: "invalid agent token" });
    try { const operation = AgentOperationSchema.parse(request.body); return { ok: true, result: await agent.execute(operation) }; } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "operation failed" }); }
  });
  await app.listen({ host: process.env.AGENT_HOST ?? "127.0.0.1", port });
  return app;
}
