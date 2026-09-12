import { z } from "zod";

export const LocaleSchema = z.enum(["zh-CN", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

/** Settings for a user-selected OpenAI/ChatGPT-compatible API gateway. */
export const AiProviderConfigSchema = z.object({
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  // Never expose this value from a project response; the API masks it.
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  appName: z.string().min(1).max(200).optional(),
  appUrl: z.string().url().optional(),
  organization: z.string().min(1).max(200).optional(),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfigSchema>;

export const ServiceKindSchema = z.enum(["application", "infrastructure", "job", "ignored"]);
export type ServiceKind = z.infer<typeof ServiceKindSchema>;

export const HealthStatusSchema = z.enum(["unknown", "healthy", "degraded", "unhealthy", "recovering"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const IncidentStageSchema = z.enum([
  "detected",
  "restarting",
  "diagnosing",
  "planning",
  "patching",
  "validating",
  "deploying",
  "verifying",
  "resolved",
  "rolled_back",
  "needs_human",
]);
export type IncidentStage = z.infer<typeof IncidentStageSchema>;

export const RemediationOutcomeSchema = z.enum([
  "recovered_by_restart",
  "repaired_and_deployed",
  "rolled_back",
  "validation_failed",
  "model_unavailable",
  "timed_out",
  "needs_human",
]);
export type RemediationOutcome = z.infer<typeof RemediationOutcomeSchema>;

export const ProjectConfigSchema = z.object({
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    installationId: z.number().int().positive().optional(),
    defaultBranch: z.string().min(1).default("main"),
  }),
  agentId: z.string().min(1),
  projectPath: z.string().min(1),
  composeFiles: z.array(z.string().min(1)).min(1).default(["compose.yaml"]),
  composeProjectName: z.string().min(1),
  /**
   * Legacy model field. New projects should use ai.model so the provider
   * settings can be supplied per project. Keeping this optional lets older
   * projects continue to load while they are migrated in place.
   */
  modelId: z.string().min(1).optional(),
  /** OpenAI/ChatGPT-compatible gateway settings (Happy API included). */
  ai: AiProviderConfigSchema.default({}),
  maxIncidentCostUsd: z.number().positive().max(100).default(2),
  locale: LocaleSchema.default("zh-CN"),
  // SMTP is optional; the web console is the default notification channel.
  notificationEmails: z.array(z.string().email()).default([]),
  monitoring: z
    .object({
      intervalSeconds: z.number().int().min(5).max(3600).default(30),
      timeoutSeconds: z.number().int().min(1).max(60).default(5),
      failureThreshold: z.number().int().min(1).max(20).default(3),
      recoveryThreshold: z.number().int().min(1).max(20).default(2),
      restartGraceSeconds: z.number().int().min(10).max(900).default(60),
      verifyAttempts: z.number().int().min(1).max(20).default(5),
      verifyIntervalSeconds: z.number().int().min(5).max(300).default(15),
    })
    .default({}),
  remediation: z
    .object({
      enabled: z.boolean().default(true),
      maxMinutes: z.number().int().min(1).max(60).default(15),
      maxSteps: z.number().int().min(1).max(30).default(12),
      maxPatchIterations: z.number().int().min(1).max(3).default(2),
      autoDeploy: z.boolean().default(true),
      retainBackups: z.number().int().min(1).max(50).default(5),
    })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(120),
  config: ProjectConfigSchema,
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;

export const ServiceConfigSchema = z.object({
  critical: z.boolean().default(true),
  livenessPath: z.string().regex(/^\/[\w./-]*$/).default("/health/live"),
  readinessPath: z.string().regex(/^\/[\w./-]*$/).default("/health/ready"),
  port: z.number().int().min(1).max(65535).optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const DiscoveredServiceSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  kind: ServiceKindSchema,
  image: z.string().optional(),
  framework: z.string().optional(),
  config: ServiceConfigSchema,
  status: HealthStatusSchema.default("unknown"),
  lastCheckedAt: z.string().datetime().optional(),
});
export type DiscoveredService = z.infer<typeof DiscoveredServiceSchema>;

export const IncidentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  serviceId: z.string().uuid(),
  serviceName: z.string(),
  stage: IncidentStageSchema,
  outcome: RemediationOutcomeSchema.optional(),
  severity: z.enum(["warning", "critical"]),
  reason: z.string(),
  diagnosis: z.record(z.unknown()).optional(),
  branchName: z.string().optional(),
  pullRequestUrl: z.string().url().optional(),
  backupId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const EventSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  incidentId: z.string().uuid().optional(),
  type: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type FixOpsEvent = z.infer<typeof EventSchema>;

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  incidentId: z.string().uuid().optional(),
  phase: z.enum(["started", "finished", "failed", "info"]),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  body: z.string(),
  read: z.boolean(),
  createdAt: z.string().datetime(),
});
export type FixOpsNotification = z.infer<typeof NotificationSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  canonical_slug: z.string().optional(),
  name: z.string().optional(),
  context_length: z.number().optional(),
  pricing: z.record(z.string()).optional(),
  supported_parameters: z.array(z.string()).default([]),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const AgentOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("discover"), projectPath: z.string(), composeFiles: z.array(z.string()), projectName: z.string() }),
  z.object({ operation: z.literal("workspaceSnapshot"), projectPath: z.string(), maxFiles: z.number().int().min(1).max(1000).default(400) }),
  z.object({ operation: z.literal("createWorkspace"), projectPath: z.string(), incidentId: z.string().uuid() }),
  z.object({ operation: z.literal("applyPatch"), workspace: z.string(), patches: z.array(z.object({ path: z.string(), unifiedDiff: z.string().min(1) })).min(1) }),
  z.object({ operation: z.literal("workspaceDiff"), workspace: z.string() }),
  z.object({ operation: z.literal("workspaceFiles"), workspace: z.string(), paths: z.array(z.string()).min(1).max(200) }),
  z.object({ operation: z.literal("probe"), service: z.string(), url: z.string().url(), timeoutMs: z.number().int().positive().max(60000) }),
  z.object({ operation: z.literal("tailLogs"), projectPath: z.string(), composeFiles: z.array(z.string()), projectName: z.string(), service: z.string(), lines: z.number().int().min(1).max(2000).default(500) }),
  z.object({ operation: z.literal("restart"), projectPath: z.string(), composeFiles: z.array(z.string()), projectName: z.string(), service: z.string() }),
  z.object({ operation: z.literal("snapshot"), projectPath: z.string(), composeFiles: z.array(z.string()), projectName: z.string(), services: z.array(z.string()).min(1) }),
  z.object({ operation: z.literal("sandboxRun"), workspace: z.string(), command: z.array(z.string()).min(1), timeoutMs: z.number().int().positive().max(900000), networkMode: z.enum(["none", "package"]).default("none") }),
  z.object({ operation: z.literal("deployCandidate"), projectName: z.string(), composeFiles: z.array(z.string()).min(1), workspace: z.string(), services: z.array(z.string()).min(1), incidentId: z.string().uuid() }),
  z.object({ operation: z.literal("rollback"), projectName: z.string(), backupId: z.string() }),
]);
export type AgentOperation = z.infer<typeof AgentOperationSchema>;

export const AiDiagnosisSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  summary: z.string(),
  likelyCause: z.string(),
  confidence: z.number().min(0).max(1),
  affectedFiles: z.array(z.string()),
  plan: z.array(z.string()).min(1),
  canAutoFix: z.boolean(),
  blockedReason: z.string().nullable().optional(),
});
export type AiDiagnosis = z.infer<typeof AiDiagnosisSchema>;

export const AiPatchSchema = z.object({
  summary: z.string(),
  patches: z.array(z.object({ path: z.string(), unifiedDiff: z.string().min(1) })),
  testsToAdd: z.array(z.string()),
  validationCommands: z.array(z.array(z.string()).min(1)),
  riskNotes: z.array(z.string()),
});
export type AiPatch = z.infer<typeof AiPatchSchema>;

export const HealthResultSchema = z.object({
  status: z.enum(["healthy", "unhealthy", "timeout"]),
  statusCode: z.number().int().optional(),
  latencyMs: z.number().nonnegative(),
  detail: z.string().optional(),
});
export type HealthResult = z.infer<typeof HealthResultSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}
