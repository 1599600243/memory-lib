// memory-lib MCP adapter — handler unit tests (in-process core).
// Run directly: node test/mcp.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createCoreClient, createMcpHandler, loadIdentityFromEnv } from "../mcp/mcp-server.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { loadRegistry } from "../src/identity-registry.mjs";
import { readAuditLines } from "../src/audit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-mcp-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const TEST_AUTH = await createTestAuth(ROOT, TMP);
const identity = JSON.parse(await fs.readFile(TEST_AUTH.registryPath, "utf8"));
for (const role of identity.frameworks[0].agents.flatMap((agent) => agent.roles)) {
  role.group_id ??= "mcp-test-group";
  role.user_id ??= "mcp-test-user";
}
await fs.writeFile(TEST_AUTH.registryPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");

const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const REGISTRY_PATH = TEST_AUTH.registryPath;
const SECRET_STORE = TEST_AUTH.secretStore;
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const CREDENTIAL_REF = TEST_AUTH.credentialRef;
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

// F7：capture 走提取链路时必须注入确定性 stub LLM，不得依赖在线模型。
// 该 stub 恒返回 skip（[]），因此 capture 的 candidateCount 恒为 0 且证据始终归档。
const captureStubLlm = { async chat() { return "[]"; } };

const libFactory = ({ scopes, agentId, principal, audit }) => createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes, agentId, principal, audit });
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0, llm: captureStubLlm });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

function makeHandler(agent, role) {
  const core = createCoreClient(BASE, { credRef: CREDENTIAL_REF, secret: DEV_SECRET, agent, role });
  return createMcpHandler(core);
}
const RESEARCHER = makeHandler("pilot-01", "researcher");
const READER = makeHandler("pilot-01", "reader");
const STEWARD = makeHandler("pilot-01", "steward");
const ADMIN = makeHandler("admin-01", "librarian-admin");

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("initialize -> protocolVersion + tools capability", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, "memory-lib-mcp");
});

test("notifications/initialized -> no response (null)", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r, null);
});

test("ping -> {}", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(r.result, {});
});

test("tools/list -> current 49-tool catalog and retired families stay absent", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = r.result.tools.map((t) => t.name);
  assert.equal(names.length, 49, "memory-lib MCP exposes the current static 49-tool catalog");
  const searchTool = r.result.tools.find((tool) => tool.name === "memory_search");
  assert.equal(searchTool.inputSchema.properties.documentQuota.description, "额外资料层配额，默认 3；0 表示关闭资料层");
  assert.equal(searchTool.inputSchema.required, undefined, "timeline enumeration must allow query to be omitted");
  assert.ok(searchTool.inputSchema.properties.offset, "timeline enumeration must expose pagination offset");
  // DAYRECALL-1 B/A：keyset 翻页与按本地日取全必须能从 MCP 面调到，否则能力只在 REST 上存在。
  assert.ok(searchTool.inputSchema.properties.cursor, "timeline enumeration must expose the keyset cursor");
  assert.ok(searchTool.inputSchema.properties.calendarDate, "timeline enumeration must expose the local calendar day filter");
  assert.ok(searchTool.inputSchema.properties.calendarTimezone, "calendarDate must expose its interpreting timezone");
  // M2.1-B1：人话日期归一必须能从 MCP 面调到（接入方=管家/学习助手就是走 MCP）。
  const resolveTool = r.result.tools.find((tool) => tool.name === "memory_resolve_date");
  assert.ok(resolveTool, "the rule-only date resolver must be exposed as an MCP tool");
  assert.deepEqual(resolveTool.inputSchema.required, ["text", "now"], "now must be mandatory: the platform does not guess the current time");
  assert.ok(resolveTool.inputSchema.properties.timezone, "the resolver must accept an explicit timezone");
  for (const n of ["memory_search", "memory_resolve_date", "memory_refinement_pending", "memory_graph_query", "memory_list", "memory_ingest", "memory_capture_conversation", "memory_capture_complete", "memory_transcript_import_status", "memory_transcript_import_scan", "memory_get", "memory_write", "memory_health", "memory_deprecate", "learning_plan_get", "pet_command", "pet_remember", "pet_drafts_put", "pet_drafts_list", "pet_drafts_clear", "pet_persona_get", "pet_persona_list", "pet_persona_put", "admin_registry", "evidence_import", "evidence_list", "recovery_plan_get", "recovery_status", "recovery_restore_validate"]) {
    assert.ok(names.includes(n), `current catalog missing ${n}`);
  }
  for (const n of ["graph_dump", "graph_stats", "graph_rebuild", "knowledge_import", "knowledge_approve", "knowledge_get", "memory_propose", "memory_review", "memory_promote", "memory_project_state", "memory_project_decision", "memory_profile_confirm"]) {
    assert.ok(!names.includes(n), `retired or unassigned tool unexpectedly exposed: ${n}`);
  }
});

test("MCP memory_resolve_date returns a range for a human expression and refuses to guess", async () => {
  const ok = await RESEARCHER.handle({
    jsonrpc: "2.0", id: 50, method: "tools/call",
    params: { name: "memory_resolve_date", arguments: { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z", timezone: "Asia/Shanghai" } },
  });
  const payload = JSON.parse(ok.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.calendarDate, "2026-10-10");
  assert.equal(payload.range.since, "2026-10-09T16:00:00.000Z");
  assert.equal(payload.range.untilExclusive, "2026-10-10T16:00:00.000Z");

  // 解析不了 ⇒ 明确失败，且**没有 range**（不能被当成"搜全库"）。
  const noMatch = await RESEARCHER.handle({
    jsonrpc: "2.0", id: 51, method: "tools/call",
    params: { name: "memory_resolve_date", arguments: { text: "随便聊聊", now: "2026-10-10T01:00:00.000Z", timezone: "Asia/Shanghai" } },
  });
  assert.equal(noMatch.result.isError, true, "an unresolvable expression must be a tool error, not a silent empty result");
  assert.match(noMatch.result.content[0].text, /NO_MATCH/u, "the precise reason must survive into the tool error");
  assert.match(noMatch.result.content[0].text, /unrecognised time expression/u);
  assert.doesNotMatch(noMatch.result.content[0].text, /"range"/u, "a failure must not carry a range");
});

test("MCP memory_resolve_date exposes the broader M2.1-B2 grammar too", async () => {
  // B2 扩了语法；MCP 面必须同样能调到（否则能力只存在于模块层）。
  const rolling = await RESEARCHER.handle({
    jsonrpc: "2.0", id: 52, method: "tools/call",
    params: { name: "memory_resolve_date", arguments: { text: "最近三天聊了什么", now: "2026-10-12T04:00:00.000Z", timezone: "Asia/Shanghai" } },
  });
  const payload = JSON.parse(rolling.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.calendarDate, null, "a rolling window is not a single day");
  assert.equal(payload.range.since, "2026-10-09T16:00:00.000Z");
  assert.equal(payload.range.untilExclusive, "2026-10-12T16:00:00.000Z");

  const range = await RESEARCHER.handle({
    jsonrpc: "2.0", id: 53, method: "tools/call",
    params: { name: "memory_resolve_date", arguments: { text: "上周一到上周三", now: "2026-10-12T04:00:00.000Z", timezone: "Asia/Shanghai" } },
  });
  assert.equal(JSON.parse(range.result.content[0].text).range.since, "2026-10-04T16:00:00.000Z");

  // 反例：普通数字不许被吃掉。
  const notADate = await RESEARCHER.handle({
    jsonrpc: "2.0", id: 54, method: "tools/call",
    params: { name: "memory_resolve_date", arguments: { text: "我买了 3 个苹果", now: "2026-10-12T04:00:00.000Z", timezone: "Asia/Shanghai" } },
  });
  assert.equal(notADate.result.isError, true);
  assert.doesNotMatch(notADate.result.content[0].text, /"range"/u);
});

test("MCP without identity headers fails closed", async () => {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 39, method: "tools/call", params: { name: "memory_search", arguments: { query: "商业原则" } } }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
});

test("MCP accepts the same Bearer session token as REST", async () => {
  const login = await fetch(`${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword }) });
  assert.equal(login.status, 200);
  const { access_token: token } = await login.json();
  const response = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 401, method: "tools/call", params: { name: "memory_search", arguments: { query: "商业原则" } } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.equal(body.result.isError, false);
});

// ---- MCP_MEMORY_TOKEN forwarding (loadIdentityFromEnv) --------------------------

const MCP_ENV = ["MCP_MEMORY_TOKEN", "MCP_MEMORY_SECRET", "MCP_MEMORY_SECRET_FILE", "MCP_MEMORY_URL", "MCP_MEMORY_CRED_REF", "MCP_MEMORY_AGENT", "MCP_MEMORY_ROLE"];
function snapshotEnv(names) { const saved = {}; for (const name of names) saved[name] = process.env[name]; return saved; }
function restoreEnv(saved) { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }

test("loadIdentityFromEnv: MCP_MEMORY_TOKEN wins over machine credentials and omits credRef/secret/agent/role", async () => {
  const saved = snapshotEnv(MCP_ENV);
  try {
    process.env.MCP_MEMORY_TOKEN = "tok-forwarded-123";
    process.env.MCP_MEMORY_SECRET = DEV_SECRET;
    process.env.MCP_MEMORY_URL = "http://127.0.0.1:9999";
    const identity = await loadIdentityFromEnv();
    assert.equal(identity.token, "tok-forwarded-123");
    assert.equal(identity.url, "http://127.0.0.1:9999");
    for (const field of ["credRef", "secret", "agent", "role"]) assert.equal(Object.hasOwn(identity, field), false, `token identity must not carry ${field}`);
  } finally {
    restoreEnv(saved);
  }
});

test("loadIdentityFromEnv: no token and no secret fails with a clear message", async () => {
  const saved = snapshotEnv(MCP_ENV);
  try {
    delete process.env.MCP_MEMORY_TOKEN;
    delete process.env.MCP_MEMORY_SECRET;
    delete process.env.MCP_MEMORY_SECRET_FILE;
    await assert.rejects(() => loadIdentityFromEnv(), /MCP_MEMORY_TOKEN or MCP_MEMORY_SECRET or MCP_MEMORY_SECRET_FILE is required/);
  } finally {
    restoreEnv(saved);
  }
});

test("loadIdentityFromEnv: MCP_MEMORY_SECRET_FILE fallback reads the secret and keeps the default cred ref", async () => {
  const saved = snapshotEnv(MCP_ENV);
  const secretFile = path.join(TMP, "mcp-secret-file.txt");
  await fs.writeFile(secretFile, `${DEV_SECRET}\n`, "utf8");
  try {
    delete process.env.MCP_MEMORY_TOKEN;
    delete process.env.MCP_MEMORY_SECRET;
    process.env.MCP_MEMORY_SECRET_FILE = secretFile;
    const identity = await loadIdentityFromEnv();
    assert.equal(identity.secret, DEV_SECRET);
    assert.equal(identity.credRef, CREDENTIAL_REF);
    assert.equal(identity.agent, "pilot-01");
    assert.equal(identity.role, "researcher");
  } finally {
    restoreEnv(saved);
    await fs.rm(secretFile, { force: true }).catch(() => {});
  }
});

test("loadIdentityFromEnv: MCP_MEMORY_URL override is honored", async () => {
  const saved = snapshotEnv(MCP_ENV);
  try {
    process.env.MCP_MEMORY_TOKEN = "tok-url";
    process.env.MCP_MEMORY_URL = "http://example.test:1234";
    const identity = await loadIdentityFromEnv();
    assert.equal(identity.url, "http://example.test:1234");
  } finally {
    restoreEnv(saved);
  }
});

test("MCP_MEMORY_TOKEN forwarding drives a real Bearer-backed MCP tool call", async () => {
  const login = await fetch(`${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: TEST_AUTH.accountUsername, password: TEST_AUTH.accountPassword }) });
  assert.equal(login.status, 200);
  const { access_token: token } = await login.json();
  const saved = snapshotEnv(MCP_ENV);
  try {
    process.env.MCP_MEMORY_TOKEN = token;
    process.env.MCP_MEMORY_URL = BASE;
    delete process.env.MCP_MEMORY_SECRET;
    delete process.env.MCP_MEMORY_SECRET_FILE;
    const identity = await loadIdentityFromEnv();
    const handler = createMcpHandler(createCoreClient(identity.url, identity));
    const r = await handler.handle({ jsonrpc: "2.0", id: 450, method: "tools/call", params: { name: "memory_search", arguments: { query: "商业原则" } } });
    assert.equal(r.result.isError, false);
    const data = JSON.parse(r.result.content[0].text);
    assert.equal(data.ok, true);
    assert.equal(typeof data.count, "number");
  } finally {
    restoreEnv(saved);
  }
});

test("MCP fails closed when authenticated role scopes cannot be resolved", async () => {
  const registry = await loadRegistry(REGISTRY_PATH);
  const framework = registry.frameworks.find((item) => item.credential_ref === CREDENTIAL_REF);
  const agent = framework.agents.find((item) => item.agent_id === "pilot-01");
  const role = agent.roles.find((item) => item.role_id === "reader");
  const originalScopes = role.scopes;
  role.scopes = [];
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
  try {
    const response = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcp-credential-ref": CREDENTIAL_REF,
        "x-mcp-secret": DEV_SECRET,
        "x-mcp-agent": "pilot-01",
        "x-mcp-role": "reader",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/list" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "SCOPE_DENIED");
  } finally {
    role.scopes = originalScopes;
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
  }
});

test("MCP memory_capture_complete validates the same message contract as conversation capture", async () => {
  const eventId = `mcp-complete-validation-${Date.now()}`;
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "memory_capture_complete", arguments: {
    source: "mcp-test", conversation_id: eventId, event_id: `${eventId}#turn-1`, messages: [{ role: "user", content: "invalid private field", private_message_field: "must reject" }],
  } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /UNSUPPORTED_MESSAGE_FIELDS|no other fields/i);
});

test("MCP memory_capture_conversation -> evidence-compatible result", async () => {
  const eventId = `mcp-capture-${Date.now()}`;
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "memory_capture_conversation", arguments: {
    source: "mcp-test", conversation_id: eventId, event_id: `${eventId}#turn-1`, workspace: "pilot", tags: ["mcp", "workspace"], extract: true, messages: [{ role: "user", content: "MCP workspace capture smoke，不作为长期记忆。" }],
  } } });
  assert.equal(r.result.isError, false);
  const data = JSON.parse(r.result.content[0].text);
  assert.match(data.evidenceId, /^conversation-/);
  assert.equal(data.candidateCount, 0);
  assert.deepEqual(data.candidates, []);
  assert.equal(data.extracted, false);
  const evidence = await fs.readFile(data.evidencePath, "utf8");
  assert.match(evidence, /workspace: "pilot"/);
  assert.match(evidence, /tags: \["mcp", "workspace"\]/);
});

test("MCP capture without propose -> tool error", async () => {
  const r = await READER.handle({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "memory_capture_conversation", arguments: {
    source: "mcp-test", conversation_id: "mcp-reader", event_id: "mcp-reader#turn-1", messages: [{ role: "user", content: "reader must be denied" }],
  } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /ACTION_DENIED|403|propose/);
});

test("MCP memory_list -> filtered result", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "memory_list", arguments: { limit: 10, workspace: "pilot", tags: ["mcp"] } } });
  assert.equal(r.result.isError, false);
  const data = JSON.parse(r.result.content[0].text);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.items));
});

test("tools/call memory_search (researcher) -> hits in content", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { query: "商业原则" } } });
  assert.equal(r.result.isError, false);
  const data = JSON.parse(r.result.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(typeof data.count, "number");
});

test("tools/call memory_get -> ok", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_get", arguments: { id: "mem_fixture_shared_business" } } });
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0].text, /mem_fixture_shared_business/);
});

test("tools/call retired governance tool -> unknown tool", async () => {
  for (const name of ["memory_propose", "memory_review", "memory_promote"]) {
    const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(r.error.code, -32602, name);
  }
});

test("tools/call memory_write -> persists direct write", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "memory_write", arguments: { layer: "curated-shared", id: "mcp-direct-write", body: "MCP direct write", evidence_refs: ["evidence:mcp-write"] } } });
  assert.equal(r.result.isError, false);
  const data = JSON.parse(r.result.content[0].text);
  assert.match(data.path, /mcp-direct-write\.md/);
});

test("MCP direct write rejects missing evidence_refs", async () => {
  const result = await ADMIN.handle({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "memory_write", arguments: { layer: "project-state", project: "d15-no-evidence", body: "missing evidence" } } });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /evidence_refs/i);
});

test("MCP evidence import uses current evidence tool", async () => {
  const result = await ADMIN.handle({ jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "evidence_import", arguments: { id: `mcp-evidence-${Date.now()}`, content: "MCP evidence" } } });
  assert.equal(result.result.isError, false);
});

test("tools/call retired review tool -> unknown tool", async () => {
  const r = await STEWARD.handle({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "memory_review", arguments: {} } });
  assert.equal(r.error.code, -32602);
});

test("tools/call admin_registry (admin) -> frameworks list", async () => {
  const r = await ADMIN.handle({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "admin_registry", arguments: {} } });
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0].text, /deepseek-harness/);
});

test("tools/call retired graph tools -> unknown tool", async () => {
  for (const name of ["graph_dump", "graph_stats", "graph_rebuild", "knowledge_import", "knowledge_approve", "knowledge_get"]) {
    const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(r.error.code, -32602, name);
  }
});

test("unknown tool -> -32602", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } });
  assert.equal(r.error.code, -32602);
});

test("unknown method -> -32601", async () => {
  const r = await RESEARCHER.handle({ jsonrpc: "2.0", id: 10, method: "bogus" });
  assert.equal(r.error.code, -32601);
});
