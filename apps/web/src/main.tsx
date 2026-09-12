import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import i18n from "i18next";
import "./styles.css";

const resources = {
  "zh-CN": { translation: { brand: "FixOps", tagline: "让服务先恢复，再让团队知道为什么", overview: "总览", projects: "项目", incidents: "事故", services: "服务", notifications: "通知", unread: "未读", allCaughtUp: "全部已读", markRead: "标记已读", noNotifications: "暂无站内通知", healthy: "健康", degraded: "降级", unhealthy: "故障", unknown: "未知", refresh: "刷新", scan: "立即巡检", addProject: "接入项目", noProjects: "还没有接入项目", noIncidents: "暂无事故记录", status: "状态", repository: "代码仓库", action: "操作", serviceCount: "服务数", incidentCount: "事故数", model: "AI 模型", aiBaseUrl: "ChatGPT 兼容 API 地址", aiApiKey: "API Key（可选）", aiAppName: "App 名称（可选）", aiAppUrl: "App 地址（可选）", aiSettingsHint: "Happy API 或其他兼容 ChatGPT 协议的网关都可以填写；模型名称由你自己指定。", language: "语言", notificationEmails: "邮件收件人（可选）", smtpOptional: "留空即可使用网站通知；配置 SMTP 后会额外发送邮件。", open: "处理中", resolved: "已恢复", needs_human: "需要人工", detected: "已发现", restarting: "重启中", diagnosing: "诊断中", planning: "规划修复", patching: "应用补丁", validating: "验证中", deploying: "部署中", verifying: "验证候选版本", rolled_back: "已回滚", startScan: "开始巡检", lastChecked: "最近检查", chooseLanguage: "切换语言" } },
  en: { translation: { brand: "FixOps", tagline: "Recover first. Explain clearly.", overview: "Overview", projects: "Projects", incidents: "Incidents", services: "Services", notifications: "Notifications", unread: "unread", allCaughtUp: "All caught up", markRead: "Mark as read", noNotifications: "No in-app notifications", healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy", unknown: "Unknown", refresh: "Refresh", scan: "Run checks", addProject: "Connect project", noProjects: "No projects connected yet", noIncidents: "No incidents yet", status: "Status", repository: "Repository", action: "Action", serviceCount: "Services", incidentCount: "Incidents", model: "AI model", aiBaseUrl: "ChatGPT-compatible API URL", aiApiKey: "API key (optional)", aiAppName: "App name (optional)", aiAppUrl: "App URL (optional)", aiSettingsHint: "Enter Happy API or any ChatGPT-compatible gateway; you choose the model name.", language: "Language", notificationEmails: "Email recipients (optional)", smtpOptional: "Leave blank to use website notifications; SMTP adds email delivery when configured.", open: "In progress", resolved: "Resolved", needs_human: "Needs human", detected: "Detected", restarting: "Restarting", diagnosing: "Diagnosing", planning: "Planning fix", patching: "Applying patch", validating: "Validating", deploying: "Deploying", verifying: "Verifying candidate", rolled_back: "Rolled back", startScan: "Run checks", lastChecked: "Last checked", chooseLanguage: "Language" } },
};
i18n.use(initReactI18next).init({ resources, lng: localStorage.getItem("fixops-locale") ?? "zh-CN", fallbackLng: "en", interpolation: { escapeValue: false } });

type Project = { id: string; name: string; status: string; config: { github: { owner: string; repo: string }; modelId?: string; ai?: { baseUrl?: string; model?: string; appName?: string; apiKeyConfigured?: boolean }; locale: string } };
type Service = { id: string; name: string; kind: string; status: string; framework?: string; config: { critical: boolean; livenessPath: string; readinessPath: string; port?: number } };
type Incident = { id: string; serviceName: string; stage: string; outcome?: string; severity: string; reason: string; createdAt: string; pullRequestUrl?: string };
type Notification = { id: string; projectId: string; incidentId?: string; phase: string; severity: string; title: string; body: string; read: boolean; createdAt: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function StatusPill({ value }: { value: string }) {
  const { t } = useTranslation();
  return <span className={`pill pill-${value}`}>{t(value, { defaultValue: value.replaceAll("_", " ") })}</span>;
}

function NotificationBell({ notifications, onRefresh }: { notifications: Notification[]; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((notification) => !notification.read).length;

  async function markRead(notification: Notification) {
    if (notification.read) return;
    try {
      await api(`/api/v1/notifications/${notification.id}/read`, { method: "POST" });
      onRefresh();
    } catch {
      // A stale notification should not prevent the rest of the dashboard from working.
    }
  }

  return <div className="notification-wrap">
    <button className={`notification-button${open ? " active" : ""}`} type="button" aria-label={t("notifications")} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span className="notification-glyph">◔</span>
      {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <div className="notification-panel" role="dialog" aria-label={t("notifications")}>
      <div className="notification-head"><div><strong>{t("notifications")}</strong><span>{unread ? `${unread} ${t("unread")}` : t("allCaughtUp")}</span></div><button className="icon-button" type="button" aria-label={t("refresh")} onClick={onRefresh}>↻</button></div>
      {!notifications.length ? <div className="notification-empty">{t("noNotifications")}</div> : <div className="notification-list">{notifications.slice(0, 20).map((notification) => <button type="button" className={`notification-item${notification.read ? "" : " unread"}`} key={notification.id} onClick={() => void markRead(notification)}><span className={`notification-severity severity-${notification.severity}`}></span><span className="notification-copy"><strong>{notification.title}</strong><span>{notification.body}</span><small>{new Date(notification.createdAt).toLocaleString()}</small></span>{!notification.read && <span className="notification-unread-dot" aria-label={t("unread")}></span>}</button>)}</div>}
    </div>}
  </div>;
}

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedProject, setSelectedProject] = useState<string | undefined>();
  const [showConnect, setShowConnect] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/api/v1/projects") });
  const incidents = useQuery({ queryKey: ["incidents"], queryFn: () => api<Incident[]>("/api/v1/incidents") });
  const notifications = useQuery({ queryKey: ["notifications"], queryFn: () => api<Notification[]>("/api/v1/notifications") });
  const project = projects.data?.find((item) => item.id === selectedProject) ?? projects.data?.[0];
  const services = useQuery({ queryKey: ["services", project?.id], queryFn: () => api<Service[]>(`/api/v1/projects/${project?.id}/services`), enabled: Boolean(project?.id) });

  useEffect(() => { if (!selectedProject && projects.data?.[0]) setSelectedProject(projects.data[0].id); }, [projects.data, selectedProject]);
  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    const eventNames = ["project.discovered", "service.health", "incident.detected", "incident.stage", "incident.finished", "incident.error", "service.instrumentation_finished", "notification.created", "notification.failed"];
    const refresh = () => { void queryClient.invalidateQueries(); };
    for (const name of eventNames) source.addEventListener(name, refresh);
    return () => { for (const name of eventNames) source.removeEventListener(name, refresh); source.close(); };
  }, [queryClient]);

  const stats = useMemo(() => { const list = services.data ?? []; return { total: list.length, healthy: list.filter((item) => item.status === "healthy").length, issues: list.filter((item) => ["unhealthy", "degraded"].includes(item.status)).length }; }, [services.data]);
  async function scan() { if (!project) return; await api(`/api/v1/projects/${project.id}/checks/run`, { method: "POST", body: "{}" }); await queryClient.invalidateQueries(); }

  return <div className="shell">
    <aside className="sidebar"><div className="logo"><span className="logo-mark">✦</span><span>{t("brand")}</span></div><p className="tagline">{t("tagline")}</p><nav><a className="active">◈ <span>{t("overview")}</span></a><a>⌁ <span>{t("projects")}</span></a><a>⚠ <span>{t("incidents")}</span></a><a className="demo-link" href="http://127.0.0.1:4100" target="_blank" rel="noreferrer">⚡ <span>Demo Lab</span></a></nav><div className="sidebar-footer"><button className="ghost" onClick={() => { const next = i18n.language === "zh-CN" ? "en" : "zh-CN"; void i18n.changeLanguage(next); localStorage.setItem("fixops-locale", next); }}>{t("chooseLanguage")} · {i18n.language === "zh-CN" ? "EN" : "中文"}</button><span className="version">v0.1.0 · self-hosted</span></div></aside>
    <main className="main"><header className="topbar"><div><div className="eyebrow">{t("overview")}</div><h1>{project?.name ?? t("brand")}</h1></div><div className="top-actions"><NotificationBell notifications={notifications.data ?? []} onRefresh={() => { void queryClient.invalidateQueries({ queryKey: ["notifications"] }); }} /><button className="secondary" onClick={() => void scan()} disabled={!project}>{t("scan")}</button><button className="primary" onClick={() => setShowConnect(true)}>＋ {t("addProject")}</button></div></header>
      <section className="hero"><div><div className="hero-kicker">LIVE RELIABILITY CONTROL</div><h2>{stats.issues ? `${stats.issues} ${t("unhealthy").toLowerCase()}` : t("healthy")}</h2><p>{project ? `${project.config.github.owner}/${project.config.github.repo}` : t("noProjects")}</p></div><div className="pulse"><span></span><span></span><span></span><b>{stats.healthy}/{stats.total || 0}</b><small>{t("services")}</small></div></section>
      <section className="stat-grid"><div className="stat-card"><span>{t("serviceCount")}</span><strong>{stats.total}</strong><small>{t("services")}</small></div><div className="stat-card"><span>{t("healthy")}</span><strong className="green">{stats.healthy}</strong><small>{stats.total ? `${Math.round(stats.healthy / stats.total * 100)}%` : "—"}</small></div><div className="stat-card"><span>{t("incidentCount")}</span><strong>{incidents.data?.length ?? 0}</strong><small>{t("incidents")}</small></div><div className="stat-card"><span>{t("model")}</span><strong className="model-value">{project?.config.ai?.model ?? project?.config.modelId ?? "—"}</strong><small>ChatGPT API</small></div></section>
      <section className="content-grid"><div className="panel services-panel"><div className="panel-head"><div><div className="section-label">01 / {t("services")}</div><h3>{t("services")}</h3></div><button className="icon-button" onClick={() => void services.refetch()} aria-label={t("refresh")}>↻</button></div>{services.isLoading ? <div className="empty">Loading…</div> : !services.data?.length ? <div className="empty">{t("noProjects")}</div> : <div className="service-list">{services.data.map((service) => <div className="service-row" key={service.id}><div className="service-indicator"><i className={service.status}></i></div><div className="service-main"><strong>{service.name}</strong><span>{service.framework ?? service.kind} · {service.config.livenessPath}</span></div><StatusPill value={service.status} /></div>)}</div>}</div><div className="panel incident-panel"><div className="panel-head"><div><div className="section-label">02 / {t("incidents")}</div><h3>{t("incidents")}</h3></div><span className="counter">{incidents.data?.length ?? 0}</span></div>{!incidents.data?.length ? <div className="empty empty-tall"><div className="empty-icon">✓</div><strong>{t("noIncidents")}</strong><span>FixOps will keep watching your services.</span></div> : <div className="incident-list">{incidents.data.slice(0, 8).map((incident) => <div className="incident-row" key={incident.id}><div className="incident-dot"></div><div><strong>{incident.serviceName}</strong><span>{new Date(incident.createdAt).toLocaleString()}</span></div><StatusPill value={incident.outcome ?? incident.stage} /></div>)}</div>}</div></section>
      {!projects.data?.length && <div className="getting-started"><span className="step-number">→</span><div><strong>Connect your first Compose project</strong><p>FixOps will discover services, install health checks and begin watching.</p></div><button className="secondary" onClick={() => setShowConnect(true)}>{t("addProject")}</button></div>}
    </main>{showConnect && <ConnectModal onClose={() => setShowConnect(false)} onCreated={() => { setShowConnect(false); void queryClient.invalidateQueries(); }} />}</div>;
}

function ConnectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: "", owner: "", repo: "", projectPath: "", composeFile: "compose.yaml", composeProjectName: "", agentId: "local-agent", aiBaseUrl: "", aiApiKey: "", model: "", appName: "", appUrl: "", emails: "", failureThreshold: "3", restartGraceSeconds: "60" });
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try {
      await api("/api/v1/projects", { method: "POST", body: JSON.stringify({ name: form.name, config: { github: { owner: form.owner, repo: form.repo, defaultBranch: "main" }, agentId: form.agentId, projectPath: form.projectPath, composeFiles: [form.composeFile], composeProjectName: form.composeProjectName || form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), ai: { ...(form.aiBaseUrl ? { baseUrl: form.aiBaseUrl } : {}), ...(form.aiApiKey ? { apiKey: form.aiApiKey } : {}), ...(form.model ? { model: form.model } : {}), ...(form.appName ? { appName: form.appName } : {}), ...(form.appUrl ? { appUrl: form.appUrl } : {}) }, notificationEmails: form.emails.split(",").map((email) => email.trim()).filter(Boolean), locale: "zh-CN", monitoring: { failureThreshold: Number(form.failureThreshold), restartGraceSeconds: Number(form.restartGraceSeconds) } } }) });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not connect project"); }
  }
  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal" onSubmit={(event) => void submit(event)}><div className="modal-head"><div><div className="section-label">SETUP / 01</div><h2>{t("addProject")}</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div><p className="modal-copy">Connect a GitHub Compose project. The local path must be inside the Agent's allowed project root.</p>{error && <div className="form-error">{error}</div>}<label>Project name<input required value={form.name} onChange={update("name")} placeholder="Payments API" /></label><div className="form-row"><label>GitHub owner<input required value={form.owner} onChange={update("owner")} placeholder="acme" /></label><label>Repository<input required value={form.repo} onChange={update("repo")} placeholder="payments" /></label></div><label>Local project path<input required value={form.projectPath} onChange={update("projectPath")} placeholder="/srv/projects/payments" /></label><div className="form-row"><label>Compose file<input required value={form.composeFile} onChange={update("composeFile")} placeholder="compose.yaml" /></label><label>Compose project name<input value={form.composeProjectName} onChange={update("composeProjectName")} placeholder="payments" /></label></div><div className="section-label ai-section-label">AI / CHATGPT PROTOCOL</div><small className="field-hint ai-hint">{t("aiSettingsHint")}</small><label>{t("aiBaseUrl")}<input type="url" value={form.aiBaseUrl} onChange={update("aiBaseUrl")} placeholder="https://api.happy.example/v1" /></label><div className="form-row"><label>{t("aiApiKey")}<input type="password" value={form.aiApiKey} onChange={update("aiApiKey")} placeholder="sk-…" autoComplete="new-password" /></label><label>{t("model")}<input value={form.model} onChange={update("model")} placeholder="gpt-4o-mini / your-model" /></label></div><div className="form-row"><label>{t("aiAppName")}<input value={form.appName} onChange={update("appName")} placeholder="FixOps" /></label><label>{t("aiAppUrl")}<input type="url" value={form.appUrl} onChange={update("appUrl")} placeholder="https://your-app.example" /></label></div><div className="form-row"><label>{t("notificationEmails")}<input value={form.emails} onChange={update("emails")} placeholder="oncall@example.com, dev@example.com" /><small className="field-hint">{t("smtpOptional")}</small></label><label>Failure threshold<input required type="number" min="1" max="20" value={form.failureThreshold} onChange={update("failureThreshold")} /></label></div><label>Restart grace (seconds)<input required type="number" min="10" max="900" value={form.restartGraceSeconds} onChange={update("restartGraceSeconds")} /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" type="submit">{t("addProject")} →</button></div></form></div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={new QueryClient()}><I18nextProvider i18n={i18n}><App /></I18nextProvider></QueryClientProvider></React.StrictMode>);
