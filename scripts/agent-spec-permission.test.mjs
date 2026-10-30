import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../app/memory-lib/src/memory-lib.mjs";
import { createLocalhostServer } from "../app/memory-lib/src/localhost-server.mjs";
import { createTestAuth } from "../app/memory-lib/test/test-auth.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1))), "..", "app", "memory-lib");

test("manifest read role cannot POST conversation capture", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-reader-"));
  const workspace = path.join(tmp, "workspace");
  const data = path.join(workspace, "memory");
  await fs.mkdir(data, { recursive: true });
  const auth = await createTestAuth(root, tmp);
  const adapter = createLocalhostServer({
    libFactory: () => createMemoryLib({ dataRoot: data, workspaceRoot: workspace }),
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
  });
  const address = await adapter.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/conversations/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" }, source: "openclaw", conversation_id: "reader-denial", event_id: "reader-denial:1", messages: [{ role: "user", content: "must deny" }] }),
    });
    assert.equal(response.status, 403);
  } finally {
    await adapter.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
