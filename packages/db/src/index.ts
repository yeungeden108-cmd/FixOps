import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  DiscoveredService,
  FixOpsEvent,
  FixOpsNotification,
  HealthResult,
  Incident,
  IncidentStage,
  ProjectConfig,
  ProjectCreateInput,
} from "@fixops/contracts";

export interface ProjectRecord {
  id: string;
  name: string;
  config: ProjectConfig;
  status: "onboarding" | "monitoring" | "paused" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface IncidentCreateInput {
  projectId: string;
  serviceId: string;
  serviceName: string;
  reason: string;
  severity: "warning" | "critical";
}

export interface Repository {
  init(): Promise<void>;
  close(): Promise<void>;
  createProject(input: ProjectCreateInput): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | undefined>;
  updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "config" | "status">>): Promise<ProjectRecord | undefined>;
  replaceServices(projectId: string, services: Array<Omit<DiscoveredService, "id" | "lastCheckedAt" | "status">>): Promise<DiscoveredService[]>;
  listServices(projectId: string): Promise<DiscoveredService[]>;
  getService(id: string): Promise<DiscoveredService | undefined>;
  updateService(id: string, patch: Partial<Pick<DiscoveredService, "config" | "status" | "lastCheckedAt">>): Promise<DiscoveredService | undefined>;
  createIncident(input: IncidentCreateInput): Promise<Incident>;
  getIncident(id: string): Promise<Incident | undefined>;
  listIncidents(projectId?: string): Promise<Incident[]>;
  updateIncident(id: string, patch: Partial<Pick<Incident, "stage" | "outcome" | "diagnosis" | "branchName" | "pullRequestUrl" | "backupId" | "error">>): Promise<Incident | undefined>;
  addEvent(input: Omit<FixOpsEvent, "id" | "createdAt">): Promise<FixOpsEvent>;
  listEvents(filter?: { projectId?: string; incidentId?: string; limit?: number }): Promise<FixOpsEvent[]>;
  recordHealthSample?(input: { projectId: string; serviceId: string; status: "healthy" | "unhealthy" | "timeout"; live: HealthResult; ready: HealthResult; checkedAt?: string }): Promise<void>;
  createInAppNotification?(input: Omit<FixOpsNotification, "id" | "createdAt" | "read"> & { idempotencyKey: string; createdAt?: string }): Promise<FixOpsNotification>;
  listNotifications?(filter?: { projectId?: string; unreadOnly?: boolean; limit?: number }): Promise<FixOpsNotification[]>;
  markNotificationRead?(id: string): Promise<FixOpsNotification | undefined>;
  claimNotification(input: { incidentId: string; phase: "started" | "finished"; recipient: string; idempotencyKey: string }): Promise<boolean>;
  releaseNotification?(idempotencyKey: string): Promise<void>;
  claimWebhookDelivery?(deliveryId: string): Promise<boolean>;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'onboarding',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  image text,
  framework text,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  last_checked_at timestamptz,
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  service_name text NOT NULL,
  stage text NOT NULL,
  outcome text,
  severity text NOT NULL,
  reason text NOT NULL,
  diagnosis jsonb,
  branch_name text,
  pull_request_url text,
  backup_id text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS health_samples (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status text NOT NULL,
  live jsonb NOT NULL,
  ready jsonb NOT NULL,
  checked_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS backups (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  manifest jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  image_manifest jsonb NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  phase text NOT NULL,
  recipient text NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS in_app_notifications (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  phase text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  actor text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_project_created_idx ON incidents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_incident_created_idx ON events(incident_id, created_at ASC);
CREATE INDEX IF NOT EXISTS health_samples_service_checked_idx ON health_samples(service_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS in_app_notifications_project_created_idx ON in_app_notifications(project_id, created_at DESC);
`;

function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id), name: String(row.name), config: row.config as ProjectConfig,
    status: row.status as ProjectRecord["status"], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function serviceFromRow(row: Record<string, unknown>): DiscoveredService {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), kind: row.kind as DiscoveredService["kind"],
    ...(row.image ? { image: String(row.image) } : {}), ...(row.framework ? { framework: String(row.framework) } : {}),
    config: row.config as DiscoveredService["config"], status: row.status as DiscoveredService["status"],
    ...(row.last_checked_at ? { lastCheckedAt: new Date(String(row.last_checked_at)).toISOString() } : {}),
  };
}

function incidentFromRow(row: Record<string, unknown>): Incident {
  return {
    id: String(row.id), projectId: String(row.project_id), serviceId: String(row.service_id), serviceName: String(row.service_name),
    stage: row.stage as IncidentStage, ...(row.outcome ? { outcome: row.outcome as Incident["outcome"] } : {}),
    severity: row.severity as Incident["severity"], reason: String(row.reason), ...(row.diagnosis ? { diagnosis: row.diagnosis as Record<string, unknown> } : {}),
    ...(row.branch_name ? { branchName: String(row.branch_name) } : {}), ...(row.pull_request_url ? { pullRequestUrl: String(row.pull_request_url) } : {}),
    ...(row.backup_id ? { backupId: String(row.backup_id) } : {}), ...(row.error ? { error: String(row.error) } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function eventFromRow(row: Record<string, unknown>): FixOpsEvent {
  return {
    id: String(row.id), ...(row.project_id ? { projectId: String(row.project_id) } : {}), ...(row.incident_id ? { incidentId: String(row.incident_id) } : {}),
    type: String(row.type), payload: row.payload as Record<string, unknown>, createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function notificationFromRow(row: Record<string, unknown>): FixOpsNotification {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    ...(row.incident_id ? { incidentId: String(row.incident_id) } : {}),
    phase: row.phase as FixOpsNotification["phase"],
    severity: row.severity as FixOpsNotification["severity"],
    title: String(row.title),
    body: String(row.body),
    read: !row.read_at,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export class PostgresRepository implements Repository {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 10 }); }
  async init(): Promise<void> { await this.pool.query(SCHEMA_SQL); }
  async close(): Promise<void> { await this.pool.end(); }
  async createProject(input: ProjectCreateInput): Promise<ProjectRecord> {
    const id = randomUUID(); const now = new Date().toISOString(); const config = input.config;
    const result = await this.pool.query("INSERT INTO projects (id,name,config,status,created_at,updated_at) VALUES ($1,$2,$3,'onboarding',$4,$4) RETURNING *", [id, input.name, config, now]);
    return projectFromRow(result.rows[0] as Record<string, unknown>);
  }
  async listProjects(): Promise<ProjectRecord[]> { const result = await this.pool.query("SELECT * FROM projects ORDER BY created_at DESC"); return result.rows.map(projectFromRow); }
  async getProject(id: string): Promise<ProjectRecord | undefined> { const result = await this.pool.query("SELECT * FROM projects WHERE id=$1", [id]); return result.rows[0] ? projectFromRow(result.rows[0]) : undefined; }
  async updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "config" | "status">>): Promise<ProjectRecord | undefined> {
    const current = await this.getProject(id); if (!current) return undefined; const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const result = await this.pool.query("UPDATE projects SET name=$2, config=$3, status=$4, updated_at=$5 WHERE id=$1 RETURNING *", [id, next.name, next.config, next.status, next.updatedAt]);
    return result.rows[0] ? projectFromRow(result.rows[0]) : undefined;
  }
  async replaceServices(projectId: string, services: Array<Omit<DiscoveredService, "id" | "lastCheckedAt" | "status">>): Promise<DiscoveredService[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM services WHERE project_id=$1", [projectId]);
      for (const service of services) {
        await client.query("INSERT INTO services (id,project_id,name,kind,image,framework,config,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'unknown')", [randomUUID(), projectId, service.name, service.kind, service.image ?? null, service.framework ?? null, service.config]);
      }
      await client.query("COMMIT");
      return this.listServices(projectId);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async listServices(projectId: string): Promise<DiscoveredService[]> { const result = await this.pool.query("SELECT * FROM services WHERE project_id=$1 ORDER BY name", [projectId]); return result.rows.map(serviceFromRow); }
  async getService(id: string): Promise<DiscoveredService | undefined> { const result = await this.pool.query("SELECT * FROM services WHERE id=$1", [id]); return result.rows[0] ? serviceFromRow(result.rows[0]) : undefined; }
  async updateService(id: string, patch: Partial<Pick<DiscoveredService, "config" | "status" | "lastCheckedAt">>): Promise<DiscoveredService | undefined> {
    const current = await this.getService(id); if (!current) return undefined; const next = { ...current, ...patch };
    const result = await this.pool.query("UPDATE services SET config=$2,status=$3,last_checked_at=$4 WHERE id=$1 RETURNING *", [id, next.config, next.status, next.lastCheckedAt ?? null]);
    return result.rows[0] ? serviceFromRow(result.rows[0]) : undefined;
  }
  async createIncident(input: IncidentCreateInput): Promise<Incident> {
    const id = randomUUID(); const now = new Date().toISOString();
    const result = await this.pool.query("INSERT INTO incidents (id,project_id,service_id,service_name,stage,severity,reason,created_at,updated_at) VALUES ($1,$2,$3,$4,'detected',$5,$6,$7,$7) RETURNING *", [id, input.projectId, input.serviceId, input.serviceName, input.severity, input.reason, now]);
    return incidentFromRow(result.rows[0]);
  }
  async getIncident(id: string): Promise<Incident | undefined> { const result = await this.pool.query("SELECT * FROM incidents WHERE id=$1", [id]); return result.rows[0] ? incidentFromRow(result.rows[0]) : undefined; }
  async listIncidents(projectId?: string): Promise<Incident[]> { const result = projectId ? await this.pool.query("SELECT * FROM incidents WHERE project_id=$1 ORDER BY created_at DESC", [projectId]) : await this.pool.query("SELECT * FROM incidents ORDER BY created_at DESC"); return result.rows.map(incidentFromRow); }
  async updateIncident(id: string, patch: Partial<Pick<Incident, "stage" | "outcome" | "diagnosis" | "branchName" | "pullRequestUrl" | "backupId" | "error">>): Promise<Incident | undefined> {
    const current = await this.getIncident(id); if (!current) return undefined; const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const result = await this.pool.query("UPDATE incidents SET stage=$2,outcome=$3,diagnosis=$4,branch_name=$5,pull_request_url=$6,backup_id=$7,error=$8,updated_at=$9 WHERE id=$1 RETURNING *", [id, next.stage, next.outcome ?? null, next.diagnosis ?? null, next.branchName ?? null, next.pullRequestUrl ?? null, next.backupId ?? null, next.error ?? null, next.updatedAt]);
    return result.rows[0] ? incidentFromRow(result.rows[0]) : undefined;
  }
  async addEvent(input: Omit<FixOpsEvent, "id" | "createdAt">): Promise<FixOpsEvent> { const event = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }; await this.pool.query("INSERT INTO events (id,project_id,incident_id,type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [event.id, event.projectId ?? null, event.incidentId ?? null, event.type, event.payload, event.createdAt]); return event; }
  async listEvents(filter: { projectId?: string; incidentId?: string; limit?: number } = {}): Promise<FixOpsEvent[]> { const conditions: string[] = []; const params: unknown[] = []; if (filter.projectId) { params.push(filter.projectId); conditions.push(`project_id=$${params.length}`); } if (filter.incidentId) { params.push(filter.incidentId); conditions.push(`incident_id=$${params.length}`); } params.push(Math.min(filter.limit ?? 200, 1000)); const result = await this.pool.query(`SELECT * FROM events ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at ASC LIMIT $${params.length}`, params); return result.rows.map(eventFromRow); }
  async recordHealthSample(input: { projectId: string; serviceId: string; status: "healthy" | "unhealthy" | "timeout"; live: HealthResult; ready: HealthResult; checkedAt?: string }): Promise<void> { await this.pool.query("INSERT INTO health_samples (id,project_id,service_id,status,live,ready,checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), input.projectId, input.serviceId, input.status, input.live, input.ready, input.checkedAt ?? new Date().toISOString()]); }
  async createInAppNotification(input: Omit<FixOpsNotification, "id" | "createdAt" | "read"> & { idempotencyKey: string; createdAt?: string }): Promise<FixOpsNotification> { const id = randomUUID(); const createdAt = input.createdAt ?? new Date().toISOString(); const result = await this.pool.query("INSERT INTO in_app_notifications (id,project_id,incident_id,phase,severity,title,body,idempotency_key,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO UPDATE SET id=in_app_notifications.id RETURNING *", [id, input.projectId, input.incidentId ?? null, input.phase, input.severity, input.title, input.body, input.idempotencyKey, createdAt]); return notificationFromRow(result.rows[0] as Record<string, unknown>); }
  async listNotifications(filter: { projectId?: string; unreadOnly?: boolean; limit?: number } = {}): Promise<FixOpsNotification[]> { const conditions: string[] = []; const params: unknown[] = []; if (filter.projectId) { params.push(filter.projectId); conditions.push(`project_id=$${params.length}`); } if (filter.unreadOnly) conditions.push("read_at IS NULL"); params.push(Math.min(filter.limit ?? 50, 200)); const result = await this.pool.query(`SELECT * FROM in_app_notifications ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params); return result.rows.map(notificationFromRow); }
  async markNotificationRead(id: string): Promise<FixOpsNotification | undefined> { const result = await this.pool.query("UPDATE in_app_notifications SET read_at=COALESCE(read_at,$2) WHERE id=$1 RETURNING *", [id, new Date().toISOString()]); return result.rows[0] ? notificationFromRow(result.rows[0] as Record<string, unknown>) : undefined; }
  async claimNotification(input: { incidentId: string; phase: "started" | "finished"; recipient: string; idempotencyKey: string }): Promise<boolean> { const result = await this.pool.query("INSERT INTO notifications (id,incident_id,phase,recipient,status,idempotency_key,created_at) VALUES ($1,$2,$3,$4,'claimed',$5,$6) ON CONFLICT (idempotency_key) DO UPDATE SET status='claimed' WHERE notifications.status='failed' RETURNING id", [randomUUID(), input.incidentId, input.phase, input.recipient, input.idempotencyKey, new Date().toISOString()]); return result.rowCount === 1; }
  async releaseNotification(idempotencyKey: string): Promise<void> { await this.pool.query("UPDATE notifications SET status='failed' WHERE idempotency_key=$1", [idempotencyKey]); }
  async claimWebhookDelivery(deliveryId: string): Promise<boolean> { const result = await this.pool.query("INSERT INTO webhook_deliveries (delivery_id,received_at) VALUES ($1,$2) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id", [deliveryId, new Date().toISOString()]); return result.rowCount === 1; }
}

export class MemoryRepository implements Repository {
  private projects = new Map<string, ProjectRecord>();
  private services = new Map<string, DiscoveredService>();
  private incidents = new Map<string, Incident>();
  private events: FixOpsEvent[] = [];
  private healthSamples: Array<{ projectId: string; serviceId: string; status: "healthy" | "unhealthy" | "timeout"; live: HealthResult; ready: HealthResult; checkedAt: string }> = [];
  private inAppNotifications = new Map<string, FixOpsNotification>();
  private inAppNotificationKeys = new Map<string, string>();
  private notificationClaims = new Map<string, "claimed" | "failed">();
  private webhookDeliveries = new Set<string>();
  async init(): Promise<void> { /* no-op */ }
  async close(): Promise<void> { /* no-op */ }
  async createProject(input: ProjectCreateInput): Promise<ProjectRecord> { const id = randomUUID(); const now = new Date().toISOString(); const record: ProjectRecord = { id, name: input.name, config: input.config, status: "onboarding", createdAt: now, updatedAt: now }; this.projects.set(id, record); return record; }
  async listProjects(): Promise<ProjectRecord[]> { return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async getProject(id: string): Promise<ProjectRecord | undefined> { return this.projects.get(id); }
  async updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "config" | "status">>): Promise<ProjectRecord | undefined> { const current = this.projects.get(id); if (!current) return undefined; const next = { ...current, ...patch, updatedAt: new Date().toISOString() }; this.projects.set(id, next); return next; }
  async replaceServices(projectId: string, services: Array<Omit<DiscoveredService, "id" | "lastCheckedAt" | "status">>): Promise<DiscoveredService[]> { for (const existing of [...this.services.values()]) if (existing.projectId === projectId) this.services.delete(existing.id); const result = services.map((service) => ({ ...service, id: randomUUID(), status: "unknown" as const })); result.forEach((service) => this.services.set(service.id, service)); return result; }
  async listServices(projectId: string): Promise<DiscoveredService[]> { return [...this.services.values()].filter((service) => service.projectId === projectId).sort((a, b) => a.name.localeCompare(b.name)); }
  async getService(id: string): Promise<DiscoveredService | undefined> { return this.services.get(id); }
  async updateService(id: string, patch: Partial<Pick<DiscoveredService, "config" | "status" | "lastCheckedAt">>): Promise<DiscoveredService | undefined> { const current = this.services.get(id); if (!current) return undefined; const next = { ...current, ...patch }; this.services.set(id, next); return next; }
  async createIncident(input: IncidentCreateInput): Promise<Incident> { const id = randomUUID(); const now = new Date().toISOString(); const incident: Incident = { id, projectId: input.projectId, serviceId: input.serviceId, serviceName: input.serviceName, stage: "detected", severity: input.severity, reason: input.reason, createdAt: now, updatedAt: now }; this.incidents.set(id, incident); return incident; }
  async getIncident(id: string): Promise<Incident | undefined> { return this.incidents.get(id); }
  async listIncidents(projectId?: string): Promise<Incident[]> { return [...this.incidents.values()].filter((incident) => !projectId || incident.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async updateIncident(id: string, patch: Partial<Pick<Incident, "stage" | "outcome" | "diagnosis" | "branchName" | "pullRequestUrl" | "backupId" | "error">>): Promise<Incident | undefined> { const current = this.incidents.get(id); if (!current) return undefined; const next = { ...current, ...patch, updatedAt: new Date().toISOString() }; this.incidents.set(id, next); return next; }
  async addEvent(input: Omit<FixOpsEvent, "id" | "createdAt">): Promise<FixOpsEvent> { const event: FixOpsEvent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }; this.events.push(event); return event; }
  async listEvents(filter: { projectId?: string; incidentId?: string; limit?: number } = {}): Promise<FixOpsEvent[]> { return this.events.filter((event) => (!filter.projectId || event.projectId === filter.projectId) && (!filter.incidentId || event.incidentId === filter.incidentId)).slice(-(filter.limit ?? 200)); }
  async recordHealthSample(input: { projectId: string; serviceId: string; status: "healthy" | "unhealthy" | "timeout"; live: HealthResult; ready: HealthResult; checkedAt?: string }): Promise<void> { this.healthSamples.push({ ...input, checkedAt: input.checkedAt ?? new Date().toISOString() }); }
  async createInAppNotification(input: Omit<FixOpsNotification, "id" | "createdAt" | "read"> & { idempotencyKey: string; createdAt?: string }): Promise<FixOpsNotification> { const existingId = this.inAppNotificationKeys.get(input.idempotencyKey); if (existingId) return this.inAppNotifications.get(existingId)!; const notification: FixOpsNotification = { ...input, id: randomUUID(), read: false, createdAt: input.createdAt ?? new Date().toISOString() }; this.inAppNotificationKeys.set(input.idempotencyKey, notification.id); this.inAppNotifications.set(notification.id, notification); return notification; }
  async listNotifications(filter: { projectId?: string; unreadOnly?: boolean; limit?: number } = {}): Promise<FixOpsNotification[]> { return [...this.inAppNotifications.values()].filter((item) => (!filter.projectId || item.projectId === filter.projectId) && (!filter.unreadOnly || !item.read)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(filter.limit ?? 50, 200)); }
  async markNotificationRead(id: string): Promise<FixOpsNotification | undefined> { const current = this.inAppNotifications.get(id); if (!current) return undefined; const updated = { ...current, read: true }; this.inAppNotifications.set(id, updated); return updated; }
  async claimNotification(input: { incidentId: string; phase: "started" | "finished"; recipient: string; idempotencyKey: string }): Promise<boolean> { const status = this.notificationClaims.get(input.idempotencyKey); if (status === "claimed") return false; this.notificationClaims.set(input.idempotencyKey, "claimed"); return true; }
  async releaseNotification(idempotencyKey: string): Promise<void> { if (this.notificationClaims.has(idempotencyKey)) this.notificationClaims.set(idempotencyKey, "failed"); }
  async claimWebhookDelivery(deliveryId: string): Promise<boolean> { if (this.webhookDeliveries.has(deliveryId)) return false; this.webhookDeliveries.add(deliveryId); return true; }
}

export function createRepository(connectionString = process.env.DATABASE_URL): Repository {
  return connectionString ? new PostgresRepository(connectionString) : new MemoryRepository();
}

export type JobName = "discover" | "health-check" | "remediate" | "instrument" | "reconcile-pr";
export interface JobPayload { projectId: string; serviceId?: string; incidentId?: string; }
type BossLike = { start(): Promise<unknown>; stop(): Promise<unknown>; send(name: string, payload: JobPayload): Promise<unknown>; work<T>(name: string, handler: (job: { data: T }) => Promise<void>): Promise<unknown> };

export class JobQueue {
  private boss: BossLike | undefined;
  private memory = new Map<JobName, Array<{ id: string; payload: JobPayload }>>();
  private memoryTimers: ReturnType<typeof setInterval>[] = [];
  constructor(private readonly connectionString = process.env.DATABASE_URL) {}
  async start(): Promise<void> { if (this.connectionString) { const module = await import("pg-boss"); const PgBoss = module.default as unknown as new (options: { connectionString: string }) => BossLike; this.boss = new PgBoss({ connectionString: this.connectionString }); await this.boss.start(); } }
  async stop(): Promise<void> { for (const timer of this.memoryTimers) clearInterval(timer); this.memoryTimers = []; if (this.boss) await this.boss.stop(); }
  async publish(name: JobName, payload: JobPayload): Promise<string> { const id = randomUUID(); if (this.boss) { await this.boss.send(name, payload); return id; } const queue = this.memory.get(name) ?? []; queue.push({ id, payload }); this.memory.set(name, queue); return id; }
  async work(name: JobName, handler: (payload: JobPayload) => Promise<void>): Promise<void> { if (this.boss) { await this.boss.work<JobPayload>(name, async (job: { data: JobPayload }) => { await handler(job.data); }); return; } const queue = this.memory.get(name) ?? []; this.memory.set(name, queue); const timer = setInterval(async () => { const next = queue.shift(); if (next) { try { await handler(next.payload); } catch (error) { console.error(`[FixOps job ${name}]`, error); } } }, 250); this.memoryTimers.push(timer); }
}
