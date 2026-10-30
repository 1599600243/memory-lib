import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d17-http-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.cp(path.join(here, "fixtures", "workspace"), workspaceRoot, { recursive: true });
const auth = await createTestAuth(root, tmp);
const auditPath = path.join(tmp, "audit.jsonl");
const adapter = createLocalhostServer({ libFactory: ({ scopes }) => createMemoryLib({ dataRoot, workspaceRoot, scopes }), registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath, host: "127.0.0.1", port: 0, ollama: { enabled: false } });
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;
after(async () => { await adapter.close(); await fs.rm(tmp, { recursive: true, force: true }); });

async function login(username, password) {
  const response = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}
async function post(route, body, token) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function getWithMcpAuth(route, role = "librarian-admin", agent = "admin-01") {
  const response = await fetch(`${base}${route}`, { headers: { "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": agent, "x-mcp-role": role } });
  return { status: response.status, data: await response.json() };
}
async function mcpTool(name, arguments_, token, id) {
  const response = await post("/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } }, token);
  return { status: response.status, data: response.data, result: response.data.result?.content?.[0]?.text ? JSON.parse(response.data.result.content[0].text) : null };
}

test("POST /v1/ingest previews, imports, indexes, audits, and enforces path range", async () => {
  const adminToken = await login(auth.accountUsername, auth.accountPassword);
  const readerToken = await login("pilot@example", "F11-pilot-account-password");
  const external = path.join(tmp, "external-doc.md");
  const importsRoot = path.join(workspaceRoot, "imports");
  await fs.mkdir(importsRoot, { recursive: true });
  await fs.writeFile(external, "D17外部文档唯一检索词：霁青索引", "utf8");
  await fs.writeFile(path.join(importsRoot, "reader-note.txt"), "restricted role fixture", "utf8");

  const request = { paths: [external], kind: "document", source: "external:http", tags: ["d17"], dry_run: true };
  const preview = await post("/v1/ingest", request, adminToken);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.counts.planned, 1);
  assert.equal(preview.data.role_range, "any-path");
  assert.equal(preview.data.imports_path, importsRoot);
  assert.equal(await fs.stat(path.join(dataRoot, "runtime", "ingest", ".import-state.json")).catch(() => null), null);

  const imported = await post("/v1/ingest", { ...request, dry_run: false }, adminToken);
  assert.equal(imported.status, 200);
  assert.equal(imported.data.counts.imported, 1);
  const search = await post("/v1/search", { query: "霁青索引" }, adminToken);
  assert.equal(search.status, 200);
  assert.ok(search.data.results.some((item) => item.sourceType === "document" && (item.path.includes("evidence/documents") || item.path.includes("evidence\\documents"))), "default search must expose imported documents as the document layer");

  const mcpExternal = path.join(tmp, "mcp-external-doc.md");
  await fs.writeFile(mcpExternal, "D17 MCP即时索引词：松烟检索", "utf8");
  const mcpRequest = { paths: [mcpExternal], kind: "document", source: "external:mcp", dry_run: true };
  const mcpPreview = await mcpTool("memory_ingest", mcpRequest, adminToken, 1701);
  assert.equal(mcpPreview.status, 200);
  assert.equal(mcpPreview.result.counts.planned, 1);
  const mcpImported = await mcpTool("memory_ingest", { ...mcpRequest, dry_run: false }, adminToken, 1702);
  assert.equal(mcpImported.result.counts.imported, 1);
  const mcpSearch = await post("/v1/search", { query: "松烟检索" }, adminToken);
  assert.ok(mcpSearch.data.results.some((item) => item.path.includes("evidence/documents") || item.path.includes("evidence\\documents")));

  const denied = await post("/v1/ingest", { paths: [external], dry_run: true }, readerToken);
  assert.equal(denied.status, 403);
  const allowed = await post("/v1/ingest", { paths: [importsRoot], kind: "document", source: "reader", dry_run: true }, readerToken);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.role_range, "imports-only");

  const mcpStatus = await getWithMcpAuth("/v1/ingest/status");
  assert.equal(mcpStatus.status, 200, "API clients may query ingest status with X-MCP credentials");
  assert.equal(mcpStatus.data.role_range, "any-path");
  assert.equal(mcpStatus.data.imports_path, importsRoot);

  const lines = (await fs.readFile(auditPath, "utf8")).trim().split(/\r?\n/u).map(JSON.parse).filter((event) => event.action === "memory-ingest");
  assert.ok(lines.some((event) => event.allow && event.dryRun === true));
  assert.ok(lines.some((event) => event.allow && event.dryRun === false && event.ingest_counts.imported === 1));
  assert.ok(lines.some((event) => !event.allow && event.denyReason === "PATH_DENIED"));
  assert.ok(lines.some((event) => event.allow && event.ingest_counts?.imported === 1 && event.resourceId === "1 imported / 0 skipped"));
  assert.ok(lines.every((event) => !(event.ingest_paths || []).some((value) => path.isAbsolute(value))), "audit must not persist absolute ingest paths");
});
