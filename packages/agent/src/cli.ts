import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { DockerHostAgent, MockHostAgent, createAgentServer } from "./index.js";

const rootEnv = resolve(process.cwd(), "../../.env");
loadDotenv({ path: existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env") });
const mode = (process.env.FIXOPS_AGENT_MODE ?? "docker").toLowerCase();
const agent = mode === "mock" ? new MockHostAgent() : new DockerHostAgent();
await createAgentServer(agent);
console.log(`FixOps Agent (${mode === "mock" ? "mock / no Docker" : "docker"}) listening on ${process.env.AGENT_HOST ?? "127.0.0.1"}:${process.env.AGENT_PORT ?? 4318}`);
