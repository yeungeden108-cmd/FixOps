import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import nodemailer, { type Transporter } from "nodemailer";
import type { AgentOperation, Locale, ProjectConfig } from "@fixops/contracts";

export class AgentClient {
  constructor(private readonly baseUrl = process.env.AGENT_URL ?? "http://127.0.0.1:4318", private readonly token = process.env.AGENT_ENROLLMENT_TOKEN ?? "") {}
  async execute<T>(operation: AgentOperation): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/operations`, { method: "POST", headers: { "content-type": "application/json", "x-fixops-agent-token": this.token }, body: JSON.stringify(operation) });
    const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Agent request failed (${response.status})`);
    return body.result as T;
  }
}

export interface PullRequestInput {
  owner: string;
  repo: string;
  installationId?: number;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  files?: Array<{ path: string; content: string }>;
}

export interface PullRequestResult { url: string; number?: number; branch: string; simulated: boolean; }

export class GitHubService {
  private readonly appOctokit?: Octokit;
  private readonly token: string | undefined;
  private readonly appId: string | undefined;
  private readonly privateKey: string | undefined;
  constructor() {
    this.token = process.env.GITHUB_TOKEN;
    this.appId = process.env.GITHUB_APP_ID;
    this.privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (this.token) this.appOctokit = new Octokit({ auth: this.token });
  }
  private async clientFor(installationId?: number): Promise<Octokit | undefined> {
    if (this.appId && this.privateKey && installationId) {
      const auth = createAppAuth({ appId: this.appId, privateKey: this.privateKey });
      const installation = await auth({ type: "installation", installationId });
      return new Octokit({ auth: installation.token });
    }
    return this.appOctokit;
  }
  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const octokit = await this.clientFor(input.installationId);
    if (!octokit) return { url: `https://github.com/${input.owner}/${input.repo}/pulls?q=is%3Apr+head%3A${encodeURIComponent(input.branch)}`, branch: input.branch, simulated: true };
    const ref = await octokit.repos.getBranch({ owner: input.owner, repo: input.repo, branch: input.base });
    const baseSha = ref.data.commit.sha;
    try { await octokit.git.createRef({ owner: input.owner, repo: input.repo, ref: `refs/heads/${input.branch}`, sha: baseSha }); } catch (error) { if (!(error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 422)) throw error; }
    if (input.files?.length) {
      const current = await octokit.git.getCommit({ owner: input.owner, repo: input.repo, commit_sha: baseSha });
      const tree = await octokit.git.createTree({ owner: input.owner, repo: input.repo, base_tree: current.data.tree.sha, tree: input.files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })) });
      const commit = await octokit.git.createCommit({ owner: input.owner, repo: input.repo, message: input.title, tree: tree.data.sha, parents: [baseSha] });
      await octokit.git.updateRef({ owner: input.owner, repo: input.repo, ref: `heads/${input.branch}`, sha: commit.data.sha, force: true });
    }
    const pr = await octokit.pulls.create({ owner: input.owner, repo: input.repo, head: input.branch, base: input.base, title: input.title, body: input.body, draft: input.draft ?? false });
    return { url: pr.data.html_url, number: pr.data.number, branch: input.branch, simulated: false };
  }
  verifyWebhook(rawBody: string | Buffer, signature: string | undefined, secret = process.env.GITHUB_WEBHOOK_SECRET ?? ""): boolean {
    if (!secret || !signature) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const a = Buffer.from(expected); const b = Buffer.from(signature); return a.length === b.length && timingSafeEqual(a, b);
  }
}

export interface MailerConfig { host?: string; port?: number; secure?: boolean; user?: string; password?: string; from?: string; }

export class IncidentMailer {
  private readonly transporter?: Transporter;
  private readonly from: string;
  constructor(config: MailerConfig = {}) {
    this.from = config.from ?? process.env.SMTP_FROM ?? "FixOps <fixops@example.com>";
    if (config.host ?? process.env.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({ host: config.host ?? process.env.SMTP_HOST, port: config.port ?? Number(process.env.SMTP_PORT ?? 587), secure: config.secure ?? process.env.SMTP_SECURE === "true", auth: (config.user ?? process.env.SMTP_USER) ? { user: config.user ?? process.env.SMTP_USER, pass: config.password ?? process.env.SMTP_PASSWORD } : undefined });
    }
  }
  async send(input: { to: string[]; locale: Locale; phase: "started" | "finished"; projectName: string; serviceName: string; summary: string; details: string; incidentId: string; }): Promise<{ sent: boolean; preview: string }> {
    const zh = input.locale === "zh-CN";
    const subject = input.phase === "started" ? (zh ? `FixOps：${input.projectName}/${input.serviceName} 故障处理中` : `FixOps: ${input.projectName}/${input.serviceName} incident in progress`) : (zh ? `FixOps：${input.projectName}/${input.serviceName} 处理结果` : `FixOps: ${input.projectName}/${input.serviceName} remediation result`);
    const text = `${subject}\n\n${input.summary}\n\n${input.details}\n\nIncident: ${input.incidentId}`;
    if (!this.transporter) { console.warn(`[FixOps mail preview]\n${text}`); return { sent: false, preview: text }; }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await this.transporter.sendMail({ from: this.from, to: input.to, subject, text }); return { sent: true, preview: text }; }
      catch (error) { lastError = error; if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250 * (attempt + 1))); }
    }
    throw lastError instanceof Error ? lastError : new Error("SMTP delivery failed");
  }
}

export function redactConfigForExternal(config: ProjectConfig): Record<string, unknown> {
  return {
    ...config,
    github: { ...config.github, installationId: config.github.installationId ? "[configured]" : undefined },
    notificationEmails: config.notificationEmails.map(() => "[configured]"),
    ai: {
      ...config.ai,
      ...(config.ai.apiKey ? { apiKey: "[configured]" } : {}),
    },
  };
}
