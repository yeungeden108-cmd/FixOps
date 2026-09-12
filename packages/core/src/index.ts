import type { DiscoveredService, HealthStatus, ServiceConfig, ServiceKind } from "@fixops/contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export interface ComposeServiceInput {
  name?: string;
  image?: string;
  build?: { context?: string; dockerfile?: string } | string;
  command?: string | string[];
  profiles?: string[];
  restart?: string;
  healthcheck?: unknown;
  ports?: Array<string | number | { target?: number | string; published?: number | string }>;
  labels?: Record<string, string>;
  depends_on?: Record<string, unknown> | string[];
  environment?: Record<string, string | number | null> | string[];
};

export interface ComposeConfigInput {
  name?: string;
  services?: Record<string, ComposeServiceInput>;
}

export interface FileSnapshot {
  path: string;
  content: string;
}

const ServiceConfigLikeSchema = z.object({ critical: z.boolean().optional(), livenessPath: z.string().optional(), readinessPath: z.string().optional(), port: z.number().int().positive().optional(), baseUrl: z.string().url().optional(), enabled: z.boolean().optional() });
const FixOpsOverrideSchema = z.object({ services: z.record(ServiceConfigLikeSchema).default({}) }).default({});

export function parseFixOpsOverrides(text: string): Record<string, Partial<ServiceConfig>> {
  try { const parsed = FixOpsOverrideSchema.safeParse(parseYaml(text)); return parsed.success ? parsed.data.services as Record<string, Partial<ServiceConfig>> : {}; } catch { return {}; }
}

export function classifyComposeService(service: ComposeServiceInput, files: FileSnapshot[] = []): ServiceKind {
  const name = (service.name ?? "").toLowerCase();
  const image = (service.image ?? "").toLowerCase();
  const command = Array.isArray(service.command) ? service.command.join(" ") : (service.command ?? "");
  const oneShot = /(^|[-_])(job|worker|cron|migration|migrate|seed)([-_]|$)/i.test(name) ||
    /(^|\s)(migrate|migration|seed)(\s|$)/i.test(command);
  if (oneShot && !service.restart) return "job";
  const infraPatterns = ["postgres", "mysql", "mariadb", "mongo", "redis", "memcached", "rabbitmq", "kafka", "nginx", "traefik", "prometheus", "grafana", "elasticsearch"];
  if (infraPatterns.some((pattern) => name.includes(pattern) || image.includes(pattern))) return "infrastructure";
  const hasNodeManifest = files.some((file) => /(^|\/)package\.json$/.test(file.path));
  if (hasNodeManifest || /node|next|npm|pnpm|yarn/.test(image)) return "application";
  return service.healthcheck ? "application" : "ignored";
}

export function detectNodeFramework(packageJson: unknown): string | undefined {
  if (!packageJson || typeof packageJson !== "object") return undefined;
  const value = packageJson as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  const deps = { ...(value.dependencies ?? {}), ...(value.devDependencies ?? {}) };
  if (deps["next"]) return "Next.js";
  if (deps["@nestjs/core"]) return "NestJS";
  if (deps["fastify"]) return "Fastify";
  if (deps["express"]) return "Express";
  return "Node.js";
}

export function defaultServiceConfig(service: ComposeServiceInput, kind: ServiceKind): ServiceConfig {
  const labels = service.labels ?? {};
  const port = parseServicePort(service.ports) ?? (parseInt(labels["fixops.port"] ?? "", 10) || undefined);
  const baseUrl = labels["fixops.base_url"];
  let validBaseUrl: string | undefined;
  if (baseUrl) { try { new URL(baseUrl); validBaseUrl = baseUrl; } catch { /* ignore invalid label */ } }
  return {
    critical: kind === "application" || kind === "infrastructure",
    livenessPath: labels["fixops.liveness_path"] ?? "/health/live",
    readinessPath: labels["fixops.readiness_path"] ?? "/health/ready",
    ...(port ? { port } : {}),
    ...(validBaseUrl ? { baseUrl: validBaseUrl } : {}),
    enabled: labels["fixops.enabled"] !== "false" && kind !== "job" && kind !== "ignored",
  };
}

export function parseServicePort(ports: ComposeServiceInput["ports"]): number | undefined {
  if (!ports?.length) return undefined;
  const candidate = ports[0];
  if (candidate === undefined) return undefined;
  if (typeof candidate === "number") return candidate;
  if (typeof candidate === "string") {
    const match = candidate.match(/(?:^|:)(\d+)(?:\/\w+)?$/);
    return match?.[1] ? Number(match[1]) : undefined;
  }
  const value = candidate.published ?? candidate.target;
  return value === undefined ? undefined : Number(value) || undefined;
}

export function discoverComposeServices(projectId: string, config: ComposeConfigInput, files: FileSnapshot[] = []): Array<Omit<DiscoveredService, "id" | "lastCheckedAt" | "status">> {
  return Object.entries(config.services ?? {}).map(([name, service]) => {
    const normalized = { ...service, name };
    const kind = classifyComposeService(normalized, files);
    return {
      projectId,
      name,
      kind,
      ...(service.image ? { image: service.image } : {}),
      ...(detectFrameworkFromFiles(files) ? { framework: detectFrameworkFromFiles(files) } : {}),
      config: defaultServiceConfig(normalized, kind),
    };
  });
}

function detectFrameworkFromFiles(files: FileSnapshot[]): string | undefined {
  const packageFile = files.find((file) => /(^|\/)package\.json$/.test(file.path));
  if (!packageFile) return undefined;
  try {
    return detectNodeFramework(JSON.parse(packageFile.content));
  } catch {
    return "Node.js";
  }
}

export interface HealthTransitionInput {
  status: HealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failureThreshold: number;
  recoveryThreshold: number;
}

export type HealthTransition = "healthy" | "degraded" | "unhealthy" | "recovering" | "unchanged";

export function transitionHealth(input: HealthTransitionInput): HealthTransition {
  if (input.consecutiveFailures >= input.failureThreshold) return "unhealthy";
  if (input.consecutiveSuccesses >= input.recoveryThreshold) return "healthy";
  if (input.status === "unhealthy" || input.status === "recovering") return "recovering";
  if (input.consecutiveFailures > 0) return "degraded";
  return "unchanged";
}

export function isAllowedPatchPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return false;
  const blocked = [
    /^\.env(?:\.|$)/i,
    /^\.fixops\.ya?ml$/i,
    /(^|\/)(secrets?|credentials?)(\/|$)/i,
    /(^|\/)(migrations?|prisma\/migrations)(\/|$)/i,
    /^\.github\/workflows\//i,
    /(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i,
  ];
  if (blocked.some((rule) => rule.test(normalized))) return false;
  return /\.(?:[cm]?[jt]sx?|json|ya?ml|md|lock)$/i.test(normalized);
}

export function isAllowedComposePatchPath(path: string): boolean {
  return /(^|\/)(?:docker-)?compose[^/]*\.ya?ml$/i.test(path.replaceAll("\\", "/"));
}

/**
 * Compose files are normally immutable to the remediation agent. The one
 * exception is the health contract needed during onboarding: healthcheck
 * fields and FixOps labels. Keep this guard intentionally conservative so a
 * model cannot smuggle ports, images, volumes, or commands into a patch.
 */
export function isAllowedHealthComposeDiff(diff: string): boolean {
  let changed = false;
  for (const line of diff.split(/\r?\n/)) {
    if (!/^[+-]/.test(line) || /^(?:\+\+\+|---)\s/.test(line)) continue;
    const value = line.slice(1).trim();
    if (!value) continue;
    if (!/^(?:healthcheck|test|interval|timeout|retries|start_period|start_interval|labels|fixops[\w.-]*|[-]\s*["']?(?:CMD(?:-SHELL)?|node|npm|pnpm|yarn|curl|wget|healthcheck)\b)/i.test(value)) return false;
    changed = true;
  }
  return changed;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/((?:api[_-]?key|token|secret|password|private[_-]?key|authorization)\s*[:=]\s*(?:Bearer\s+)?)([^\s,;"']+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-or-v1-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED_TOKEN]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]");
}

const SAFE_COMMANDS = new Set(["npm", "pnpm", "yarn", "node", "npx", "corepack", "npm.cmd", "pnpm.cmd", "yarn.cmd"]);

export function assertSafeValidationCommand(command: string[]): void {
  const executable = command[0];
  if (!executable || !SAFE_COMMANDS.has(executable)) throw new Error(`Validation command is not allowlisted: ${executable ?? "empty"}`);
  const joined = command.join(" ");
  if (/[;&|`$<>]|\b(docker|docker-compose|powershell|pwsh|curl|wget|ssh|scp|rm|del|format)\b/i.test(joined)) {
    throw new Error("Validation command contains a blocked shell or host operation");
  }
}

export function parseUnifiedDiffPaths(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path) && path !== "/dev/null"))];
}
