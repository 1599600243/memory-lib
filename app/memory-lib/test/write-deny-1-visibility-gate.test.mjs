// WRITE-DENY-1 —— 写入侧的门：**写出来的可见性决定需要什么权限**。
//
// 纪律：每条"拒绝/看不到"都配同夹具的**正对照**（该能写的必须写得进、该能读的必须读得到），
// 并且拒绝时必须断言**零写入**（文件没多出来），否则"403 了但文件已经落盘"这种半截失败查不出来。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { createRefinementObservability, inspectionReportPath, isInsideRetrievalRoot, REFINED_DIRS } from "../src/refinement-observability.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-write-deny-1-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(workspaceRoot, { recursive: true });
const importsRoot = path.join(workspaceRoot, "imports");
await fs.mkdir(importsRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const pilot = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01");
// OTHER 必须是**另一个 agent**：private 可见性允许"同一个 agent"读，
// 若 OTHER 挂在 pilot-01 上，跨组 404 的负对照会被同 agent 读放行掩盖。
const OTHER_AGENT = "wd1-other-agent";
const ROLE = {
  A: { role_id: "wd1-a", group_id: "group-a", user_id: "user-a", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }] },
  PROJ: { role_id: "wd1-proj", group_id: "group-a", user_id: "user-a", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "project", project: "proj-a" }] },
  PROPOSE_ONLY: { role_id: "wd1-propose-only", group_id: "group-a", user_id: "user-p", actions: ["search", "get", "propose"], scopes: [{ layer: "tool", visibility: "platform" }] },
  ADMIN: { role_id: "wd1-admin", group_id: "group-a", user_id: "user-admin", actions: ["search", "get", "propose", "admin"], scopes: [{ layer: "memory", visibility: "shared" }] },
  OTHER: { role_id: "wd1-other", group_id: "group-b", user_id: "user-b", actions: ["search", "get", "propose"], scopes: [{ layer: "memory", visibility: "shared" }] },
};
for (const [key, role] of Object.entries(ROLE)) if (key !== "OTHER") pilot.roles.push({ ...role });
registry.frameworks[0].agents.push({ agent_id: OTHER_AGENT, roles: [{ ...ROLE.OTHER }] });
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
const secret = (await fs.readFile(path.join(auth.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).trim();
const server = createLocalhostServer({
  registryPath: auth.registryPath,
  secretStore: auth.secretStore,
  dataRoot,
  workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"),
  host: "127.0.0.1",
  port: 0,
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});
const address = await server.listen();
const base = `http://127.0.0.1:${address.port}`;
after(async () => { await server.close(); });

async function http(roleKey, route, body = {}) {
  // OTHER 走它自己的 agent（wd1-other-agent）；其余角色仍挂在 pilot-01 上。
  const agentId = roleKey === "OTHER" ? OTHER_AGENT : "pilot-01";
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: auth.credentialRef, secret, principal: { agent_id: agentId, role_id: ROLE[roleKey].role_id }, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
async function mcpWrite(roleKey, args) {
  const handler = createMcpHandler(createCoreClient(base, { credRef: auth.credentialRef, secret, agent: "pilot-01", role: ROLE[roleKey].role_id }));
  const result = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_write", arguments: args } });
  const text = result.result?.content?.[0]?.text ?? "";
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { isError: result.result?.isError === true, text, data: parsed };
}

/** 目录里的文件清单（相对 dataRoot，排序）：用来断言"拒绝时零写入"。 */
async function fileList() {
  const rows = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { rows.push(`${path.relative(dataRoot, absolute).replaceAll("\\", "/")}/`); await walk(absolute); }
      else rows.push(path.relative(dataRoot, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(dataRoot);
  return rows.sort();
}
async function frontmatterOf(relative) {
  const text = await fs.readFile(path.join(dataRoot, relative), "utf8");
  const frontmatter = {};
  for (const line of text.split(/\r?\n/u).slice(1)) {
    if (line.trim() === "---") break;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u);
    if (match) frontmatter[match[1]] = match[2].trim().replace(/^"|"$/gu, "");
  }
  return frontmatter;
}

test("WRITE-DENY-1 ①非 admin 写 document/tool ⇒ 403 且零写入；admin ⇒ 200 且别的 group 能读到", async () => {
  const before = await fileList();

  for (const layer of ["document", "tool"]) {
    const denied = await http("A", "/v1/write", { layer, id: `wd1-denied-${layer}`, body: `应该被拒的 ${layer}`, evidence_refs: [`wd1:${layer}`] });
    assert.equal(denied.status, 403, `non-admin ${layer} must be refused with 403, got ${denied.status} ${JSON.stringify(denied.data)}`);
    assert.equal(denied.data.error.code, "WRITE_SCOPE_DENIED", `the refusal must be a write-scope denial, got ${JSON.stringify(denied.data.error)}`);
    assert.equal(denied.data.error.detail, "PLATFORM_REQUIRES_ADMIN", `the reason must name the resulting visibility, got ${JSON.stringify(denied.data.error)}`);
  }
  assert.deepEqual(await fileList(), before, "refused document/tool writes must create no file at all");

  // 正对照：admin 写 document ⇒ 200、落 platform、**另一个 group 能读到**
  const allowed = await http("ADMIN", "/v1/write", { layer: "document", id: "wd1-admin-doc", body: "admin 写的 document", evidence_refs: ["wd1:admin-doc"] });
  assert.equal(allowed.status, 200, `admin document write must succeed, got ${allowed.status} ${JSON.stringify(allowed.data)}`);
  const doc = await frontmatterOf("evidence/documents/wd1-admin-doc.md");
  assert.equal(doc.container, "knowledge", `document lands in the knowledge container, got ${doc.container}`);
  assert.equal(doc.visibility, "platform", `document lands with platform visibility, got ${doc.visibility}`);
  const otherRead = await http("OTHER", "/v1/get", { id: "wd1-admin-doc" });
  assert.equal(otherRead.status, 200, `platform data must be readable from another group (this is the allowed path), got ${otherRead.status}`);
});

test("WRITE-DENY-1 ②propose-only 写 curated-shared 必须 200（不许把 MEMORY-LOOP-1 修好的改回去）", async () => {
  const written = await http("PROPOSE_ONLY", "/v1/write", { layer: "curated-shared", id: "wd1-propose-only-cs", body: "propose-only 的共享记忆", evidence_refs: ["wd1:cs"] });
  assert.equal(written.status, 200, `a propose-only role must be able to write curated-shared, got ${written.status} ${JSON.stringify(written.data)}`);
  const fm = await frontmatterOf("curated/shared/wd1-propose-only-cs.md");
  assert.equal(fm.container, "long-term", `curated-shared lands in the long-term container, got ${fm.container}`);
  assert.equal(fm.visibility, "private", `curated-shared defaults to private, got ${fm.visibility}`);
  const otherRead = await http("OTHER", "/v1/get", { id: "wd1-propose-only-cs" });
  assert.equal(otherRead.status, 404, `a private record must not be readable from another group, got ${otherRead.status}`);
});

test("WRITE-DENY-1 ③项目可见性：缺作用域 ⇒ 403；有 ⇒ 200 且同组可读", async () => {
  const before = await fileList();
  const denied = await http("A", "/v1/write", { layer: "project-state", project: "proj-a", id: "wd1-proj-denied", body: "缺项目作用域", evidence_refs: ["wd1:proj"] });
  assert.equal(denied.status, 403, `writing into a project scope without the grant must be 403, got ${denied.status} ${JSON.stringify(denied.data)}`);
  assert.equal(denied.data.error.detail, "PROJECT_SCOPE_SCOPE_DENIED", `the reason must name the project scope, got ${JSON.stringify(denied.data.error)}`);
  assert.deepEqual(await fileList(), before, "a refused project write must create no file at all");

  const allowed = await http("PROJ", "/v1/project/state", { project: "proj-a", sections: { 目标: "持有项目作用域的写入", 当前进展: "门禁正对照", 下一步: "断言落盘可见性", 阻塞: "当前无阻塞" }, body: "持有项目作用域的写入", evidence_refs: ["wd1:proj-ok"] });
  assert.equal(allowed.status, 200, `the role holding the project scope must be able to write it, got ${allowed.status} ${JSON.stringify(allowed.data)}`);
  const state = await frontmatterOf("project-state/proj-a/current-state.md");
  assert.equal(state.visibility, "project", `project-state lands with project visibility, got ${state.visibility}`);
});

test("WRITE-DENY-1 ④MCP memory_write 与 REST 同一把尺子（document ⇒ 需要 admin）", async () => {
  const denied = await mcpWrite("A", { layer: "document", id: "wd1-mcp-doc-denied", body: "MCP 上的 document", evidence_refs: ["wd1:mcp"] });
  assert.equal(denied.isError, true, `MCP memory_write of a document must be refused for a non-admin, got ${JSON.stringify(denied.data ?? denied.text)}`);
  assert.match(denied.text, /WRITE_SCOPE_DENIED|PLATFORM_REQUIRES_ADMIN/u, `the refusal must name the write scope, got ${denied.text}`);
  await assert.rejects(fs.stat(path.join(dataRoot, "evidence/documents/wd1-mcp-doc-denied.md")), "the refused MCP write must create no file");

  const allowed = await mcpWrite("ADMIN", { layer: "document", id: "wd1-mcp-doc-ok", body: "MCP 上的 document（admin）", evidence_refs: ["wd1:mcp-ok"] });
  assert.equal(allowed.isError, false, `an admin must be able to write a document over MCP, got ${JSON.stringify(allowed.data ?? allowed.text)}`);
  const otherRead = await http("OTHER", "/v1/get", { id: "wd1-mcp-doc-ok" });
  assert.equal(otherRead.status, 200, `the MCP-written platform record must be readable across groups, got ${otherRead.status}`);
});

test("WRITE-DENY-1 ⑤分层直写端点与导入类入口也按写出来的可见性判权", async () => {
  // tools/note：写进 tools-memory ⇒ platform ⇒ 需要 admin
  const toolDenied = await http("A", "/v1/tools/note", { tool_name: "wd1-tool", sections: { 用途: "工具笔记", 接入方式: "HTTP /v1/tools/note", 关键参数: "tool_name", 已知坑: "缺段会被 400 拒", 验证方式: "断言 403" }, body: "工具笔记", evidence_refs: ["wd1:tool"] });
  assert.equal(toolDenied.status, 403, `a non-admin tool note must be refused, got ${toolDenied.status} ${JSON.stringify(toolDenied.data)}`);
  const toolAllowed = await http("ADMIN", "/v1/tools/note", { tool_name: "wd1-tool-admin", sections: { 用途: "工具笔记（admin）", 接入方式: "HTTP /v1/tools/note", 关键参数: "tool_name", 已知坑: "缺段会被 400 拒", 验证方式: "断言 200 且跨组可读" }, body: "工具笔记（admin）", evidence_refs: ["wd1:tool-admin"] });
  assert.equal(toolAllowed.status, 200, `an admin tool note must succeed, got ${toolAllowed.status} ${JSON.stringify(toolAllowed.data)}`);
  assert.equal((await http("OTHER", "/v1/tools/get", { tool_name: "wd1-tool-admin" })).status, 200, "the admin tool note must be readable across groups (platform)");

  // evidence/import：写进 evidence/documents ⇒ platform ⇒ 需要 admin
  const evidenceDenied = await http("A", "/v1/evidence/import", { id: "wd1-evidence-denied", content: "证据" });
  assert.equal(evidenceDenied.status, 403, `a non-admin evidence import must be refused, got ${evidenceDenied.status} ${JSON.stringify(evidenceDenied.data)}`);
  const evidenceAllowed = await http("ADMIN", "/v1/evidence/import", { id: "wd1-evidence-ok", content: "证据（admin）" });
  assert.equal(evidenceAllowed.status, 200, `an admin evidence import must succeed, got ${evidenceAllowed.status} ${JSON.stringify(evidenceAllowed.data)}`);

  // ingest：**执行**导入写出 documents ⇒ 需要 admin；纯预览不写盘，不受影响
  // 预览指纹是**身份绑定**的（framework_id + agent_id + role_id），所以 admin 的执行
  // 必须配一次**同参数的 admin 预览**，否则拿到的是 DRY_RUN_REQUIRED，不是权限结论。
  await fs.writeFile(path.join(importsRoot, "wd1-note.md"), "# 导入\n\nWD1 import marker\n", "utf8");
  const importPath = path.join(importsRoot, "wd1-note.md");
  const importParams = { paths: [importPath], kind: "document", source: "wd1" };
  const preview = await http("A", "/v1/ingest", { ...importParams, dry_run: true });
  assert.equal(preview.status, 200, `a dry-run preview writes nothing and must stay allowed, got ${preview.status} ${JSON.stringify(preview.data)}`);
  const before = await fileList();
  const executeDenied = await http("A", "/v1/ingest", { ...importParams, dry_run: false });
  assert.equal(executeDenied.status, 403, `executing an import writes platform documents, so a non-admin must be refused, got ${executeDenied.status} ${JSON.stringify(executeDenied.data)}`);
  assert.deepEqual(await fileList(), before, "a refused import must create no file at all");
  const adminPreview = await http("ADMIN", "/v1/ingest", { ...importParams, dry_run: true });
  assert.equal(adminPreview.status, 200, `an admin dry-run preview with the same parameters must succeed, got ${adminPreview.status} ${JSON.stringify(adminPreview.data)}`);
  const executeAllowed = await http("ADMIN", "/v1/ingest", { ...importParams, dry_run: false });
  assert.equal(executeAllowed.status, 200, `an admin import must succeed, got ${executeAllowed.status} ${JSON.stringify(executeAllowed.data)}`);
});

test("WRITE-DENY-1 ⑥巡检报告不进检索根：默认落 runtime/，project-state 那份不生成", async () => {
  const captured = await http("A", "/v1/conversations/capture", {
    source: "wd1",
    conversation_id: "wd1-conv",
    event_id: "wd1-event",
    messages: [{ role: "user", content: "写侧门禁的捕获对照" }, { role: "assistant", content: "好的" }],
  });
  assert.equal(captured.status, 200, `capture must succeed for a propose-capable identity, got ${captured.status} ${JSON.stringify(captured.data)}`);
  // 正对照：这次捕获的证据确实写下来了，而且只对写者可见
  const evidenceId = captured.data.evidenceId;
  assert.ok(evidenceId, `capture must return an evidence id, got ${JSON.stringify(captured.data)}`);
  assert.equal((await http("A", "/v1/get", { id: evidenceId })).status, 200, "the writer must read back its own evidence");
  assert.equal((await http("OTHER", "/v1/get", { id: evidenceId })).status, 404, "conversation evidence must stay owner-scoped");

  // REFINE-LOOP-1-REJECT1C：产品岗裁决「巡检报告不该进检索根」——它是运维指标，不是记忆。
  // 默认落点 = <dataRoot>/runtime/refinement-inspection.md（runtime/ 不在 REFINED_DIRS 内）。
  // project-state/ 那份只能是运维显式指定（见 ⑥b），绝不做默认。
  const reportPath = inspectionReportPath(dataRoot);
  assert.equal(reportPath, path.join(dataRoot, "runtime", "refinement-inspection.md"), `默认必须落在 runtime/，实际 ${reportPath}`);
  assert.equal(isInsideRetrievalRoot(reportPath, dataRoot), false, "巡检报告不许落进检索根");
  const reportStat = await fs.stat(reportPath).catch(() => null);
  assert.ok(reportStat, `the inspection report must be produced at ${reportPath}`);
  for (const dir of REFINED_DIRS) {
    const inside = await fs.stat(path.join(dataRoot, dir, "memory-system", "refinement-inspection.md")).catch(() => null);
    assert.equal(inside, null, `the inspection report must not be written under ${dir}/ (retrieval root)`);
  }
  // 检索根里的这份不该存在 —— 因此任何身份都不可能通过 /v1/get 读到仪表
  const legacy = await fs.stat(path.join(dataRoot, "project-state", "memory-system", "refinement-inspection.md")).catch(() => null);
  assert.equal(legacy, null, "the retired project-state/ copy must NOT be written any more (one report, not two)");
  assert.equal((await http("OTHER", "/v1/get", { id: "refinement-inspection" })).status, 404, "运维指标不可被别的身份读走");
});

test("WRITE-DENY-1 ⑥b opt-in：显式把报告指定到 project-state 时只在那一处、默认 runtime/ 不生成", async () => {
  // REJECT1C 裁决：project-state/ 那份只作为「需要时显式指定」的可选项，绝不做默认。
  // 这条守住"opt-in 真的能用、且仍然只写一处"。
  const optInRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-wd1-optin-"));
  try {
    const optIn = path.join(optInRoot, "project-state", "memory-system", "refinement-inspection.md");
    const obs = createRefinementObservability({ dataRoot: optInRoot, threshold: 1, reportPath: optIn });
    const result = await obs.inspect();
    assert.equal(result.report_path, path.resolve(optIn), "指定的 reportPath 必须被尊重");
    assert.ok(await fs.stat(optIn).catch(() => null), "opt-in 下报告应落在指定位置");
    const byDefault = await fs.stat(path.join(optInRoot, "runtime", "refinement-inspection.md")).catch(() => null);
    assert.equal(byDefault, null, "指定了 reportPath 就不许再写默认位置（单落点）");
  } finally {
    await fs.rm(optInRoot, { recursive: true, force: true });
  }
});
