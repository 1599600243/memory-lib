import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-mem-write-1-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(workspaceRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const framework = registry.frameworks[0];
const pilot = framework.agents.find((item) => item.agent_id === "pilot-01");
for (const item of pilot.roles) {
  item.group_id = "home-circle";
  item.user_id = item.role_id === "researcher" ? "user-owner" : `user-${item.role_id}`;
  item.actions = [...new Set([...(item.actions ?? []), "search", "get", "propose"])]
  item.scopes = [...(item.scopes ?? []), { layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "user", project: item.user_id }]
}
pilot.roles.push({ role_id: "same-group", group_id: "home-circle", user_id: "same-user", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "user", project: "same-user" }] });
pilot.roles.push({ role_id: "other-group", group_id: "other-circle", user_id: "other-user", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "user", project: "other-user" }] });
await fs.writeFile(auth.registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
const secret = (await fs.readFile(path.join(auth.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).trim();
const server = createLocalhostServer({ registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot, auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0, libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }) });
const address = await server.listen();
const base = `http://127.0.0.1:${address.port}`;
function handler(role) { return createMcpHandler(createCoreClient(base, { credRef: auth.credentialRef, secret, agent: "pilot-01", role })); }
async function mcp(role, args) { const result = await handler(role).handle({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "memory_write", arguments: args } }); const text = result.result.content[0].text; try { return JSON.parse(text); } catch { return { ok: false, error: { code: "WRITE_REJECTED", message: text } }; } }
async function http(role, route, body) { const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret, principal: { agent_id: "pilot-01", role_id: role }, ...(route === "/v1/get" ? { id: body.id } : body) }) }); return { status: response.status, data: await response.json() }; }
const baseWrite = (id) => ({ layer: "curated-shared", id, body: id, evidence_refs: [`evidence:${id}`] });

test("real MCP memory_write visibility is principal-scoped and key HTTP reads enforce isolation", async () => {
  const cases = [
    { visibility: "user", id: "mem-write-user", allowed: ["researcher"], denied: ["same-group", "other-group"] },
    { visibility: "shared", id: "mem-write-shared", allowed: ["researcher", "same-group"], denied: ["other-group"] },
  ];
  for (const item of cases) {
    const written = await mcp("researcher", { ...baseWrite(item.id), visibility: item.visibility });
    assert.equal(written.ok, true, `${item.visibility}: ${JSON.stringify(written)}`);
    const file = await fs.readFile(path.join(dataRoot, "curated", "shared", `${item.id}.md`), "utf8");
    assert.match(file, new RegExp(`visibility: [\"']?${item.visibility}`));
    assert.match(file, /user_id: [\"']?user-owner/);
    for (const role of item.allowed) {
      const read = await http(role, "/v1/get", { id: item.id });
      assert.equal(read.status, 200, `${item.visibility} allowed ${role}: ${JSON.stringify(read.data)}`);
    }
    for (const role of item.denied) {
      const read = await http(role, "/v1/get", { id: item.id });
      assert.equal(read.status, 404, `${item.visibility} denied ${role}: ${JSON.stringify(read.data)}`);
    }
  }
});

test("real MCP memory_write rejects forged ownership, invalid visibility, and platform escalation", async () => {
  for (const args of [
    { ...baseWrite("mem-write-forged-user"), visibility: "user", user_id: "same-user" },
    { ...baseWrite("mem-write-forged-group"), visibility: "shared", group_id: "other-circle" },
    { ...baseWrite("mem-write-platform"), visibility: "platform" },
    { ...baseWrite("mem-write-invalid"), visibility: "not-a-visibility" },
  ]) {
    const result = await mcp("researcher", args);
    assert.equal(result.ok, false, JSON.stringify({ args, result }));
    assert.match(JSON.stringify(result), /WRITE_SCOPE_DENIED|BAD_REQUEST|FORBIDDEN/u);
  }
});

test("real MCP memory_write without visibility keeps private default behavior", async () => {
  const result = await mcp("researcher", baseWrite("mem-write-default"));
  assert.equal(result.ok, true, JSON.stringify(result));
  const file = await fs.readFile(path.join(dataRoot, "curated", "shared", "mem-write-default.md"), "utf8");
  assert.match(file, /visibility: [\"']?private/);
  const self = await http("researcher", "/v1/get", { id: "mem-write-default" });
  const sameAgentDifferentRole = await http("same-group", "/v1/get", { id: "mem-write-default" });
  assert.equal(self.status, 200);
  assert.equal(sameAgentDifferentRole.status, 200, "private default retains existing same-agent visibility semantics");
});

after(async () => { await server.close(); await fs.rm(tmp, { recursive: true, force: true }); });
