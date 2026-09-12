import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { createRepository } from "./index.js";

const rootEnv = resolve(process.cwd(), "../../.env");
loadDotenv({ path: existsSync(rootEnv) ? rootEnv : resolve(process.cwd(), ".env") });
const repository = createRepository();
await repository.init();
await repository.close();
console.log("FixOps database is ready.");
