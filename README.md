# FixOps

FixOps 是一个自托管的 AI 服务可靠性控制面：它发现 Docker Compose 服务，为 Node.js/TypeScript 应用建立 liveness/readiness 检查，持续探测服务，在连续故障时先重启一次，然后在隔离工作区使用 OpenRouter 诊断、修复、测试、备份、部署并自动回滚。

## 快速开始

最快本地演示只要求 Node.js 22+ 和 pnpm 11+；`.env.example` 默认启用不依赖 Docker 的 Mock Agent。真实 Compose 重启/构建演练才需要 Docker Engine、Compose v2（Windows 使用 Docker Desktop 的 WSL2 Linux 容器模式）。

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev
```

复制的 `.env` 默认使用 `FIXOPS_AGENT_MODE=mock`，所以 Docker Desktop 未启动也能运行控制台、原生 Demo、健康探测、事故状态和站内通知。要切换回真实 Docker Agent，把它改成 `FIXOPS_AGENT_MODE=docker`，并清空 `FIXOPS_MOCK_RESET_URL`。

本地未启动 PostgreSQL 时，`.env.example` 的空 `DATABASE_URL` 会使用内存仓库；生产部署请填写 PostgreSQL 连接串，或直接使用下方 Docker Compose。

如果希望分别启动各个进程，也可以另开终端运行：

```powershell
pnpm dev:worker
pnpm dev:agent
pnpm --filter @fixops/web dev
# 或一次启动 API、Worker、Agent、控制台和 Demo
pnpm dev
```

## 故障演练 Demo

仓库内置了一个可被 FixOps 真实探测的 Checkout API 演练项目，页面在 `http://127.0.0.1:4100`。它提供 `/health/live`、`/health/ready`、`/api/checkout`，并且可以在页面上注入 liveness 500、readiness 503、依赖超时和 crash loop。故障状态保存在进程内存中，所以 FixOps 的受控容器重启会自然清除故障并产生 `recovered_by_restart` 结果。

先启动演练服务（只看页面可用本地开发；要让 FixOps 执行真实 Compose 重启，请使用 Docker）：

```powershell
pnpm dev:demo
# 或
pnpm demo:up
```

`pnpm dev:demo` 适合只预览 Demo 页面；默认的 `pnpm dev` 会同时启动原生 Demo 和 Mock Agent，可在没有 Docker 的情况下完成快速演示。真实容器演练才使用 `pnpm demo:up`，因为 Docker Agent 需要通过 Compose 重启 `checkout-demo` 容器。

如果使用下面的完整 `docker compose up`，演练服务会属于根 Compose 项目 `fixops`，接入项目时把 `composeProjectName` 填成 `fixops`；单独运行 `pnpm demo:up` 时则使用 `fixops-demo`。

然后打开 Demo 页面，在 FixOps 控制台选择“接入项目”，填入：

```text
项目名称：FixOps Checkout Demo
项目路径：<这个仓库的绝对路径>\demo
Compose 文件：compose.yaml
Compose project name：fixops-demo
GitHub owner/repo：demo/checkout-lab（演示值即可）
模型：openrouter/auto（没有 API key 时也可先演示探测和重启）
通知邮箱：留空（使用控制台站内通知）
```

建议把监控 `failureThreshold` 设为 `1`、`restartGraceSeconds` 设为 `10`，这样点击故障按钮后再点“立即巡检”，就能快速看到事故被发现、受控重启和恢复。页面里的“打开控制台”链接可直接回到 FixOps Web 控制台。

生产/自托管部署（会同时启动 Checkout Demo）：

```powershell
docker compose up -d --build
```

主控制台默认在 `http://127.0.0.1:3000`，故障演练页面在 `http://127.0.0.1:4100`（可用 `DEMO_PORT` 修改）。

Linux 上如果 API/Worker 以容器连接宿主机 Agent，请让 Agent 监听宿主机可达的私有地址（例如 `AGENT_HOST=0.0.0.0`，并用防火墙限制 4318 端口）；Agent 始终要求 `AGENT_ENROLLMENT_TOKEN`。Windows Docker Desktop 会通过 `host.docker.internal` 连接。

首次部署前，把 `.env` 中的 `OPENROUTER_API_KEY`、`AGENT_ENROLLMENT_TOKEN` 和 GitHub Webhook Secret 填好。SMTP 是可选配置：即使 `SMTP_HOST` 等字段为空，事故开始/结束通知仍会保存到控制台的站内通知（右上角铃铛），配置 SMTP 后才会额外发送邮件。控制台默认在 `http://127.0.0.1:3000`；不建议把未加认证的控制台暴露到公网。GitHub Webhook 可以通过反向代理只暴露 `/api/v1/webhooks/github`，请求必须携带有效 HMAC 签名。

## 接入项目

在控制台选择 “接入项目”，或调用：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/projects \
  -H 'content-type: application/json' \
  -d '{
    "name": "Payments API",
    "config": {
      "github": {"owner": "acme", "repo": "payments", "defaultBranch": "main"},
      "agentId": "local-agent",
      "projectPath": "/srv/projects/payments",
      "composeFiles": ["compose.yaml"],
      "composeProjectName": "payments",
      "modelId": "anthropic/claude-sonnet-4.5",
      "maxIncidentCostUsd": 2,
      "locale": "zh-CN",
      "notificationEmails": []
    }
  }'
```

`modelId` 必须从 `GET /api/v1/openrouter/models` 返回的兼容模型中选择。项目目录必须位于 Agent 的允许根目录中。应用镜像不能依赖生产源码 bind mount；数据库迁移、密钥、数据卷、端口和 CI 工作流不会被 AI 自动修改。

## API 入口

- `GET /health/live`、`GET /health/ready`
- `GET/POST/PATCH /api/v1/projects`
- `POST /api/v1/projects/:id/discover`
- `GET /api/v1/projects/:id/services`
- `POST /api/v1/projects/:id/checks/run`
- `POST /api/v1/projects/:id/instrument`
- `GET /api/v1/incidents`、`GET /api/v1/incidents/:id`
- `POST /api/v1/incidents/:id/retry`
- `POST /api/v1/incidents/:id/rollback`
- `GET /api/v1/notifications`、`POST /api/v1/notifications/:id/read`
- `GET /api/v1/events`（SSE）
- `POST /api/v1/webhooks/github`
- `GET /api/v1/openapi.json`

## 自动修复边界

默认每 30 秒探测，连续 3 次失败后创建事故并自动重启一次。重启后仍失败才进入 AI 流程。AI 运行在无 Docker Socket、无生产密钥、非 root 的一次性容器中，工具循环和费用都有上限。候选镜像必须连续通过健康验证；失败会恢复备份。成功版本会创建 `fixops/incident-*` PR，合并 PR 后再同步默认分支，关闭 PR 则回滚候选版本。

## 测试

```powershell
pnpm typecheck
pnpm test
pnpm build
```

不配置 SMTP 也可以完成本地功能测试：通知会显示在控制台右上角的铃铛中，点击通知即可标记已读。没有 OpenRouter key 时可先测试 Compose 发现、健康检查、受控重启、事故状态和站内通知；要测试 AI 诊断/补丁/PR，再配置 OpenRouter（GitHub 凭证仅用于真实创建 PR）。完整恢复演练需要真实 Docker Engine；SMTP 只在需要验证邮件发送时配置。
