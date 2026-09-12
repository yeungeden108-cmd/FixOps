# FixOps Checkout Demo

这是一个故障可控的 Node.js Checkout 服务，页面和 API 同源运行在 `4100` 端口。它不连接真实支付系统，所有状态都在内存中，适合演示健康探测与容器重启。

```powershell
pnpm --filter @fixops/demo dev
# 或从仓库根目录启动 Docker 服务
pnpm demo:up
```

页面：`http://127.0.0.1:4100`

| 端点 | 用途 |
| --- | --- |
| `GET /health/live` | liveness 探针 |
| `GET /health/ready` | readiness 探针 |
| `GET/POST /api/checkout` | 用户结算路径 |
| `GET /api/status` | 页面状态与事件快照 |
| `GET /api/events` | 最近事件流 |
| `POST /api/faults/liveness_500` | 注入 liveness 500 |
| `POST /api/faults/readiness_503` | 注入 readiness 503 |
| `POST /api/faults/dependency_timeout` | 注入依赖超时 |
| `POST /api/faults/crash_loop` | 同时击穿两类探针 |
| `POST /api/faults/clear` | 手动恢复 |

`compose.yaml` 与 `.fixops.yml` 已准备好，直接把 `demo/` 作为项目接入 FixOps 即可。容器重启会清空进程内的故障开关，因此适合观察 `recovered_by_restart` 事故结果。

单独运行本目录的 Compose 时，项目名是 `fixops-demo`；如果使用仓库根目录的 `docker compose up`，请在 FixOps 项目配置里使用根项目名 `fixops`。
