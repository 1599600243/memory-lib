// memory-lib D29 administrator smoke example (read-only).
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const DATA_ROOT = "I:\\OpenClaw\\memory-data\\memory";
const WORKSPACE_ROOT = "I:\\OpenClaw\\memory-data";
const REGISTRY_PATH = path.join(ROOT, "runtime", "identity.json");
const SECRET_STORE = { type: "file", dir: path.join(ROOT, "runtime", "secrets") };
const AUDIT_PATH = path.join(os.tmpdir(), `memory-lib-admin-demo-${Date.now()}.jsonl`);
const CREDENTIAL_REF = "memory-lib/deepseek-harness";
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");
const ADMIN = { agent_id: "admin-01", role_id: "librarian-admin" };

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: DATA_ROOT, workspaceRoot: WORKSPACE_ROOT, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

async function call(route, extra = {}) {
  const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: ADMIN, ...extra }) });
  return { status: res.status, data: await res.json() };
}

for (const route of ["/v1/admin/health", "/v1/admin/registry", "/v1/admin/audit"]) {
  const result = await call(route, route.endsWith("audit") ? { limit: 20 } : {});
  console.log(route, result.status, JSON.stringify(result.data));
}
await adapter.close();
