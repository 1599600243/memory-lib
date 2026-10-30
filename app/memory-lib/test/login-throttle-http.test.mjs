import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-login-throttle-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(tmp, "workspace"), { recursive: true });
const auth = await createTestAuth(root, tmp);
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const adapter = createLocalhostServer({
  libFactory: ({ scopes }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, vectorLane: { probe: false } }),
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
});
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;

after(async () => {
  await adapter.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function login(username, password) {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), data: await response.json() };
}

test("unknown-account failures cannot lock another account on the loopback peer", async () => {
  let ghost;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    ghost = await login("ghost@example", "wrong-password-value");
  }
  assert.equal(ghost.status, 429);
  assert.match(ghost.retryAfter ?? "", /^\d+$/u);

  const pilot = await login("pilot@example", "F11-pilot-account-password");
  assert.equal(pilot.status, 200);
  assert.equal(pilot.data.principal.agent, "pilot-01");

  const stillLocked = await login("ghost@example", "wrong-password-value");
  assert.equal(stillLocked.status, 429);
  assert.match(stillLocked.retryAfter ?? "", /^\d+$/u);
});
