import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type FaultKind = "liveness_500" | "readiness_503" | "dependency_timeout" | "crash_loop";

type DemoEvent = {
  id: number;
  at: string;
  type: "fault" | "request" | "recovery";
  message: string;
  status?: number;
};

type DemoState = {
  activeFault: FaultKind | null;
  faultStartedAt: string | null;
  requestCount: number;
  errorCount: number;
  lastRequest: { path: string; status: number; latencyMs: number; at: string } | null;
  events: DemoEvent[];
};

const faultDefinitions: Record<FaultKind, { label: string; shortLabel: string; status: number; path: string; detail: string }> = {
  liveness_500: {
    label: "Liveness 500",
    shortLabel: "LIVE-500",
    status: 500,
    path: "/health/live",
    detail: "应用进程仍在运行，但 liveness 检查返回 500。FixOps 会优先尝试受控重启。",
  },
  readiness_503: {
    label: "Readiness 503",
    shortLabel: "READY-503",
    status: 503,
    path: "/health/ready",
    detail: "依赖检查失败，服务暂时不能接收流量。适合演示 readiness 与 liveness 的区别。",
  },
  dependency_timeout: {
    label: "Dependency timeout",
    shortLabel: "TIMEOUT",
    status: 504,
    path: "/health/ready",
    detail: "模拟支付依赖无响应，readiness 会等待 8 秒后超时。",
  },
  crash_loop: {
    label: "Crash loop",
    shortLabel: "CRASH-LOOP",
    status: 500,
    path: "/health/live + /health/ready",
    detail: "同时击穿 liveness 和 readiness；容器重启后内存中的故障开关会被清除。",
  },
};

let eventId = 0;
const state: DemoState = {
  activeFault: null,
  faultStartedAt: null,
  requestCount: 0,
  errorCount: 0,
  lastRequest: null,
  events: [],
};

const publicIndex = fileURLToPath(new URL("../public/index.html", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function now(): string {
  return new Date().toISOString();
}

function addEvent(event: Omit<DemoEvent, "id" | "at">): void {
  state.events.unshift({ ...event, id: ++eventId, at: now() });
  state.events = state.events.slice(0, 28);
}

function json(reply: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  reply.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  reply.end(body);
}

function text(reply: ServerResponse, status: number, value: string, contentType = "text/plain; charset=utf-8"): void {
  reply.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  reply.end(value);
}

function faultPayload(): Record<string, unknown> {
  const definition = state.activeFault ? faultDefinitions[state.activeFault] : undefined;
  return {
    ok: !state.activeFault,
    activeFault: state.activeFault,
    fault: definition ? { kind: state.activeFault, ...definition } : null,
    faultStartedAt: state.faultStartedAt,
    requestCount: state.requestCount,
    errorCount: state.errorCount,
    lastRequest: state.lastRequest,
    events: state.events,
    service: { name: "checkout-demo", version: "1.4.0", region: "local-docker", uptimeHint: "process memory" },
  };
}

function recordRequest(path: string, status: number, started: number): void {
  const latencyMs = Date.now() - started;
  state.requestCount += 1;
  if (status >= 400) state.errorCount += 1;
  state.lastRequest = { path, status, latencyMs, at: now() };
  if (status >= 400) addEvent({ type: "request", message: `${path} returned HTTP ${status}`, status });
}

function healthResult(path: string, status: number, detail?: string): Record<string, unknown> {
  return { status: status >= 200 && status < 300 ? "ok" : "error", service: "checkout-demo", path, ...(detail ? { detail } : {}) };
}

function setFault(kind: FaultKind): void {
  state.activeFault = kind;
  state.faultStartedAt = now();
  addEvent({ type: "fault", message: `Injected ${faultDefinitions[kind].label}` });
}

function clearFault(): void {
  const previous = state.activeFault;
  state.activeFault = null;
  state.faultStartedAt = null;
  if (previous) addEvent({ type: "recovery", message: `Cleared ${faultDefinitions[previous].label}; service is healthy` });
}

async function handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = request.method ?? "GET";
  const started = Date.now();

  if (path === "/health/live" && method === "GET") {
    const failing = state.activeFault === "liveness_500" || state.activeFault === "crash_loop";
    const status = failing ? 500 : 200;
    recordRequest(path, status, started);
    return json(reply, status, healthResult(path, status, failing ? "synthetic liveness failure" : undefined));
  }

  if (path === "/health/ready" && method === "GET") {
    if (state.activeFault === "dependency_timeout") {
      await sleep(8000);
      recordRequest(path, 504, started);
      return json(reply, 504, healthResult(path, 504, "payment provider did not respond within 8s"));
    }
    const failing = state.activeFault === "readiness_503" || state.activeFault === "crash_loop";
    const status = failing ? 503 : 200;
    recordRequest(path, status, started);
    return json(reply, status, healthResult(path, status, failing ? "dependency check failed" : undefined));
  }

  if (path === "/api/status" && method === "GET") {
    return json(reply, 200, faultPayload());
  }

  if (path === "/api/faults" && method === "GET") {
    return json(reply, 200, { faults: Object.entries(faultDefinitions).map(([kind, definition]) => ({ kind, ...definition })) });
  }

  if (path === "/api/faults/clear" && method === "POST") {
    clearFault();
    return json(reply, 200, faultPayload());
  }

  if (path.startsWith("/api/faults/") && method === "POST") {
    const kind = path.slice("/api/faults/".length) as FaultKind;
    if (!(kind in faultDefinitions)) return json(reply, 404, { error: "Unknown fault kind" });
    setFault(kind);
    return json(reply, 202, faultPayload());
  }

  if (path === "/api/checkout" && (method === "GET" || method === "POST")) {
    if (state.activeFault === "dependency_timeout") await sleep(3200);
    const failing = Boolean(state.activeFault);
    const status = !failing ? 200 : state.activeFault === "readiness_503" ? 503 : state.activeFault === "dependency_timeout" ? 504 : 500;
    recordRequest(path, status, started);
    return json(reply, status, failing
      ? { ok: false, error: "CHECKOUT_UNAVAILABLE", message: "Checkout is temporarily unavailable. FixOps has been notified." }
      : { ok: true, orderId: `demo_${Date.now().toString(36)}`, total: 128.4, currency: "USD" });
  }

  if (path === "/api/events" && method === "GET") {
    return json(reply, 200, { events: state.events });
  }

  if (path === "/api/reset" && method === "POST") {
    clearFault();
    state.requestCount = 0;
    state.errorCount = 0;
    state.lastRequest = null;
    state.events = [];
    return json(reply, 200, faultPayload());
  }

  if (path === "/" || path === "/index.html") {
    try {
      const page = await readFile(publicIndex, "utf8");
      return text(reply, 200, page, "text/html; charset=utf-8");
    } catch {
      return text(reply, 500, "Demo UI is unavailable");
    }
  }

  return json(reply, 404, { error: "Not found" });
}

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const server = createServer((request, reply) => { void handle(request, reply).catch((error: unknown) => { const message = error instanceof Error ? error.message : "request failed"; json(reply, 500, { error: message }); }); });
server.listen(port, host, () => { console.log(`FixOps demo checkout listening at http://${host}:${port}`); });

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
