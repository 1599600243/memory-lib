import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint6-"));
const auth = await createTestAuth(ROOT, TMP);
const dataRoot = path.join(TMP, "workspace", "memory");
const workspaceRoot = path.join(TMP, "workspace");
const secret = (await fs.readFile(path.join(auth.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).trim();
const libFactory = ({ scopes, agentId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, principal, audit });
const adapter = createLocalhostServer({ libFactory, dataRoot, workspaceRoot, registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath: path.join(TMP, "audit.jsonl"), host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const base = `http://127.0.0.1:${addr.port}`;
// 写授权按"写出来的可见性"判定（WRITE-DENY-1）：document 层 ⇒ container knowledge ⇒ 默认
// visibility=platform，evidence_import 同样落 knowledge/platform ⇒ 两者都需要 admin 动作。
// 因此这条用例必须同时握着两个身份：
//   · researcher（pilot-01）—— 没有 admin 动作 ⇒ 负向控制（必须被拒，且拒得有理）
//   · librarian-admin（admin-01）—— 有 admin 动作 + memory/project/* ⇒ 正向控制（真的写成）
// 只有一边时断言不可能同时"拒绝"和"存在"，历史版本正是因为只用 researcher 才从绿变红。
const researcherHandler = createMcpHandler(createCoreClient(base, { credRef: auth.credentialRef, secret, agent: "pilot-01", role: "researcher" }));
const adminHandler = createMcpHandler(createCoreClient(base, { credRef: auth.credentialRef, secret, agent: "admin-01", role: "librarian-admin" }));

function parseToolResult(response) {
  return JSON.parse(response.result.content[0].text);
}

function toolText(response) {
  return response.result.content.map((part) => part.text ?? "").join("\n");
}

after(async () => { await adapter.close(); await fs.rm(TMP, { recursive: true, force: true }); });

test("MAINT6 knowledge document write requires admin and the document stays searchable", async () => {
  const marker = `MAINT6-KNOWLEDGE-${Date.now()}`;

  // 负向控制：非 admin 写 document（会被写成 platform 可见性）必须被拒。
  const denied = await researcherHandler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_write", arguments: { layer: "document", id: "maint6-knowledge-denied", body: marker, evidence_refs: ["maint6-evidence"] } } });
  assert.equal(denied.result.isError, true, "a non-admin document write must fail");
  const deniedText = toolText(denied);
  assert.match(deniedText, /WRITE_SCOPE_DENIED/u, `the refusal must name the write scope, got ${deniedText}`);
  assert.match(deniedText, /PLATFORM_REQUIRES_ADMIN/u, `the refusal must name the admin requirement, got ${deniedText}`);

  // 被拒的那次写入不能留下任何东西：marker 在库里搜不到（否则"拒绝"只是嘴上拒绝）。
  const phantom = await researcherHandler.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query: marker, documentQuota: 10, graphExpand: false } } });
  assert.equal(phantom.result.isError, false);
  assert.equal(parseToolResult(phantom).results.length, 0, "the denied write must not leave a searchable document");

  // 正向控制：同一个写入走 admin 身份必须真的落盘。
  const written = await adminHandler.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_write", arguments: { layer: "document", id: "maint6-knowledge", body: marker, evidence_refs: ["maint6-evidence"] } } });
  assert.equal(written.result.isError, false, toolText(written));
  const writeData = parseToolResult(written);
  assert.match(writeData.path, /evidence[\\/]documents[\\/]maint6-knowledge\.md$/);
  assert.equal(await fs.readFile(writeData.path, "utf8").then((text) => text.includes(marker)), true);

  // 门禁只挡写：非 admin 仍然能读到 admin 写的那份文档（documentQuota 检索不变弱）。
  const searched = await researcherHandler.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { query: marker, documentQuota: 10, graphExpand: false } } });
  assert.equal(searched.result.isError, false);
  const searchData = parseToolResult(searched);
  assert.ok(searchData.results.some((item) => item.path.endsWith("maint6-knowledge.md")), `the admin-written document must be searchable, got ${JSON.stringify(searchData.results.map((item) => item.path))}`);
  console.log(JSON.stringify({ capability: "knowledge-write-read", marker, non_admin_denied: deniedText.slice(0, 120), write_path: writeData.path, search_hits: searchData.results.length }));
});

test("MAINT6 MCP graph query mirrors REST and has no edge maintenance tool", async () => {
  const listed = await researcherHandler.handle({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.equal(names.includes("memory_graph_query"), true);
  assert.equal(names.some((name) => name.includes("graph") && name !== "memory_search" && name !== "memory_graph_query"), false);

  // 负向控制：非 admin 的 evidence_import 也落 knowledge/platform ⇒ 必须被拒。
  const deniedEvidence = await researcherHandler.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "evidence_import", arguments: { id: "maint6-evidence-denied", content: "MAINT6 graph evidence denied" } } });
  assert.equal(deniedEvidence.result.isError, true, "a non-admin evidence_import must fail");
  const deniedEvidenceText = toolText(deniedEvidence);
  assert.match(deniedEvidenceText, /WRITE_SCOPE_DENIED|PLATFORM_REQUIRES_ADMIN/u, `the refusal must name the write scope, got ${deniedEvidenceText}`);

  // 图谱的两个生产者（证据 + 项目决策）都由 admin 身份写成：
  // evidence_import 需要 admin 动作；项目决策需要 maint6-project 的项目作用域，只有 admin 的
  // memory/project/* 覆盖它（researcher 只有 memory/project/pilot）。
  const deniedDecision = await researcherHandler.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "memory_write", arguments: { layer: "project-decision", project: "maint6-project", id: "maint6-decision-denied", body: "MAINT6 graph producer marker", evidence_refs: ["maint6-evidence"] } } });
  assert.equal(deniedDecision.result.isError, true, "a non-admin write outside its project scope must fail");
  assert.match(toolText(deniedDecision), /WRITE_SCOPE_DENIED/u, `the refusal must name the write scope, got ${toolText(deniedDecision)}`);

  const evidence = await adminHandler.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "evidence_import", arguments: { id: "maint6-evidence", content: "MAINT6 graph evidence" } } });
  assert.equal(evidence.result.isError, false, toolText(evidence));
  const written = await adminHandler.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_write", arguments: { layer: "project-decision", project: "maint6-project", id: "maint6-decision", body: "MAINT6 graph producer marker", evidence_refs: ["maint6-evidence"] } } });
  assert.equal(written.result.isError, false, toolText(written));
  const queried = await researcherHandler.handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "memory_graph_query", arguments: { project_id: "maint6-project" } } });
  assert.equal(queried.result.isError, false, queried.result.content?.[0]?.text);
  const graphData = parseToolResult(queried);
  assert.ok(graphData.graph.memories.includes("maint6-decision"));
  assert.equal(graphData.graph.project_id, "project:maint6-project");
  const restResponse = await fetch(`${base}/v1/graph/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: auth.credentialRef, secret, principal: { agent_id: "pilot-01", role_id: "researcher" }, project_id: "maint6-project" }) });
  assert.equal(restResponse.status, 200);
  const restData = await restResponse.json();
  assert.deepEqual(restData.graph, graphData.graph);
  console.log(JSON.stringify({ capability: "graph-query", available: true, tool_count: names.length, project_id: graphData.graph.project_id, memories: graphData.graph.memories, non_admin_denied: deniedEvidenceText.slice(0, 120), rest_parity: true }));
  console.log(JSON.stringify({ capability: "graph-edge-maintenance", available: false, reason: "edges are produced by write/project/rebuild paths" }));
});
