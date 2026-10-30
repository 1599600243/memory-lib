// Regression tests for MCP authentication and the shared conversation capture contract.
// Run directly: node test/mcp-auth-capture-regression.test.mjs
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
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-mcp-regression-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const TEST_AUTH = await createTestAuth(ROOT, TMP);
const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const DEV_SECRET = (await fs.readFile(path.join(TEST_AUTH.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");
const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: TEST_AUTH.registryPath, secretStore: TEST_AUTH.secretStore, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

async function mcp(body, headers = {}) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

const identityHeaders = {
  "x-mcp-credential-ref": TEST_AUTH.credentialRef,
  "x-mcp-secret": DEV_SECRET,
  "x-mcp-agent": "pilot-01",
  "x-mcp-role": "reader",
};

function toolText(data) {
  return data?.result?.content?.[0]?.text ?? "";
}

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("MCP without identity headers fails closed for read tools", async () => {
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "原则" } } });
  assert.equal(r.status, 401);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error.code, "UNAUTHENTICATED");
});

test("MCP without identity headers fails closed for tools/list", async () => {
  const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error.code, "UNAUTHENTICATED");
});

test("MCP memory_capture_complete rejects private message fields like HTTP", async () => {
  const eventId = `mcp-complete-contract-${Date.now()}`;
  const r = await mcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_capture_complete",
      arguments: {
        source: "mcp-contract-regression",
        conversation_id: eventId,
        event_id: `${eventId}#turn-1`,
        messages: [{ role: "user", content: "contract probe", private_message_field: "must reject" }],
      },
    },
  }, { ...identityHeaders, "x-mcp-role": "researcher" });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.isError, true);
  assert.match(toolText(r.data), /UNSUPPORTED_MESSAGE_FIELDS|role=user|assistant|no other fields/i);
});

test("MCP capture tools reject private top-level fields", async () => {
  const eventId = `mcp-top-level-contract-${Date.now()}`;
  const r = await mcp({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "memory_capture_complete",
      arguments: {
        source: "mcp-contract-regression",
        conversation_id: eventId,
        event_id: `${eventId}#turn-1`,
        private_extension: "must reject",
        messages: [{ role: "user", content: "contract probe" }],
      },
    },
  }, { ...identityHeaders, "x-mcp-role": "researcher" });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.isError, true);
  assert.match(toolText(r.data), /UNSUPPORTED_FIELDS|unsupported capture fields/i);
});
