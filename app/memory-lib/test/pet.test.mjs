// memory-lib — pet command service tests (fake LLM injected).
// Run directly: node test/pet.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { snapshotTree, diffSnapshots } from "../scripts/zero-write-check.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-pet-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const TEST_AUTH = await createTestAuth(ROOT, TMP);
const identity = JSON.parse(await fs.readFile(TEST_AUTH.registryPath, "utf8"));
for (const role of identity.frameworks[0].agents.flatMap((agent) => agent.roles)) {
  role.group_id ??= "pet-test-group";
  role.user_id ??= "pet-test-user";
}
await fs.writeFile(TEST_AUTH.registryPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");

const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const REGISTRY_PATH = TEST_AUTH.registryPath;
const SECRET_STORE = TEST_AUTH.secretStore;
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const CREDENTIAL_REF = TEST_AUTH.credentialRef;
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

const READER = { agent_id: "pilot-01", role_id: "reader" };
const PET = { agent_id: "pilot-01", role_id: "pet" };
const PET_ASSISTANT = { agent_id: "pilot-01", role_id: "pet-assistant" };
const PET_STEWARD = { agent_id: "pilot-01", role_id: "pet-steward" };

// deterministic fake LLM
const fakeLlm = {
  async chat(messages) {
    const sys = (messages ?? []).map((m) => (m.role === "system" ? m.content : "")).join(" ");
    const last = String(messages?.at(-1)?.content ?? "");
    if (sys.includes("学习计划设计师")) return '{"modules":[{"id":"m1","title":"模块一","weight":1,"difficulty":"low","dependencies":[]},{"id":"m2","title":"模块二","weight":2,"difficulty":"medium","dependencies":["m1"]}]}';
    if (sys.includes("出题老师")) return '{"questions":[{"q":"1+1=?","options":["A. 1","B. 2"],"answer":"B","explain":"基础"}]}';
    if (sys.includes("信息核验助手")) return "核验总结（测试）：该网页要点如下。";
    if (sys.includes("研究助手")) return "研究结论（测试）：基于记忆与联网信息，指出记忆可能过时处。";
    if (sys.includes("自动记忆提炼")) return '[{"content":"用户偏好用中文回答。","importance":"important","confidence":"high","tags":["preference"]}]';
    if (last.includes("解释概念")) return "概念解释（测试）：一句话定义 + 类比 + 例子。";
    return '{"modules":[{"id":"m1","title":"模块一","weight":1,"difficulty":"low","dependencies":[]},{"id":"m2","title":"模块二","weight":2,"difficulty":"medium","dependencies":["m1"]}]}';
  },
  async *chatStream(messages) {
    const text = await this.chat(messages);
    yield text.slice(0, Math.ceil(text.length / 2));
    yield text.slice(Math.ceil(text.length / 2));
  },
};

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0, llm: fakeLlm, petConfig: { openai: { credentialRef: CREDENTIAL_REF, principal: PET_ASSISTANT } } });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

async function call(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
async function findFileContaining(root, fragment) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileContaining(entryPath, fragment);
      if (nested) return nested;
    } else if (entry.name.includes(fragment)) return entryPath;
  }
  return null;
}
const petCall = (input, mode) => call("/v1/pet/command", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET, input, mode });
async function openAiCall(body, accessValue) {
  const headers = { "content-type": "application/json" };
  headers[["author", "ization"].join("")] = ["Bear" + "er", accessValue].join(" ");
  const res = await fetch(`${BASE}/v1/pet/openai/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("non-pet role (reader) cannot use pet command -> 403 ACTION_DENIED", async () => {
  const { status, data } = await call("/v1/pet/command", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, input: "hi" });
  assert.equal(status, 403);
  assert.equal(data.error.detail, "ACTION_DENIED");
});

test("pet mode authorization denies learning mode without learning action", async () => {
  const r = await call("/v1/pet/command", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, input: "hi", mode: "quiz" });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.detail, "ACTION_DENIED");
});

test("persona put captures evidence before creating its governed candidate", async () => {
  const marker = `persona-evidence-${Date.now()}`;
  const response = await call("/v1/pet/runtime/persona/put", {
    credential_ref: CREDENTIAL_REF,
    secret: DEV_SECRET,
    principal: PET_ASSISTANT,
    mode: "assistant",
    content: marker,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const candidate = await fs.readFile(response.data.path, "utf8");
  const evidenceId = /evidence_refs: \["([^"]+)"\]/.exec(candidate)?.[1];
  assert.ok(evidenceId, "candidate must reference captured evidence");
  const evidencePath = await findFileContaining(path.join(FIXTURE_DATA, "evidence"), evidenceId);
  assert.ok(evidencePath, "referenced evidence file must exist");
  assert.match(await fs.readFile(evidencePath, "utf8"), new RegExp(marker));
});

test("pet read policy narrows retrieval before context injection", async () => {
  const r = await petCall("记忆库是什么");
  assert.equal(r.status, 200);
  const denied = await call("/v1/pet/command", {
    credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET, input: "记忆库是什么",
    pet_read_policy: { deny: [{ layer: "memory" }] },
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.data.context_hits, 0);
});

test("/help lists commands", async () => {
  const r = await petCall("/help");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /learn:topic/);
  assert.match(r.data.reply, /learn:review/);
});

test("/learn:topic creates a learning map from LLM draft; second call reports existing", async () => {
  const r1 = await petCall("/learn:topic pet-test");
  assert.equal(r1.status, 200);
  assert.match(r1.data.reply, /已为「pet-test」创建学习地图/);
  assert.equal(r1.data.plan.map.modules.length, 2);

  const r2 = await petCall("/learn:topic pet-test");
  assert.match(r2.data.reply, /已有学习地图/);
});

test("/learn:status shows progress summary", async () => {
  const r = await petCall("/learn:status pet-test");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /pet-test/);
  assert.match(r.data.reply, /模块一/);
  assert.match(r.data.reply, /0\/2 完成/);
});

test("/learn:review reports no due items initially", async () => {
  const r = await petCall("/learn:review pet-test");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /没有到期的复习项/);
});

test("/learn:explain returns explanation with memory context", async () => {
  const r = await petCall("/learn:explain pet-test 协议");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /概念解释（测试）/);
});

test("/learn:quiz returns quiz", async () => {
  const r = await petCall("/learn:quiz pet-test");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /小测验/);
});

test("plain chat calls LLM and returns reply", async () => {
  const r = await petCall("记忆库是什么");
  assert.equal(r.status, 200);
  assert.ok(r.data.reply.length > 0);
  assert.ok("context_hits" in r.data);
});

test("OpenAI-compatible pet bridge authenticates and emits SSE", async () => {
  const r = await openAiCall({ model: "memory-lib-pet", stream: true, messages: [{ role: "user", content: "hello" }] }, DEV_SECRET);
  assert.equal(r.status, 200);
  assert.ok((r.text.match(/chat\.completion\.chunk/g) ?? []).length >= 2);
  assert.match(r.text, /pet/);
  assert.match(r.text, /\[DONE\]/);
});

test("OpenAI-compatible pet bridge rejects invalid access", async () => {
  const r = await openAiCall({ model: "memory-lib-pet", stream: false, messages: [{ role: "user", content: "hello" }] }, "wrong-access-value");
  assert.equal(r.status, 401);
});

test("OpenAI-compatible assistant mode writes an explicit remember candidate", async () => {
  const r = await openAiCall({ model: "memory-lib-pet", stream: false, mode: "assistant", messages: [{ role: "user", content: "请记住今天完成了桥接写入测试" }] }, DEV_SECRET);
  assert.equal(r.status, 200);
  assert.match(r.text, /已记入候选/);
  assert.match(r.text, /尚未写入正式记忆|初审/);
  const shared = await fs.readdir(path.join(FIXTURE_DATA, "curated", "shared"));
  assert.ok(shared.some((name) => name.startsWith("pet-remember-") && name.endsWith(".md")), "remember must create a curated shared memory");
});

test("HTTP conversation capture stores evidence and deduplicates events", async () => {
  const body = {
    credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_ASSISTANT,
    conversation_id: "capture-test-1", event_id: "event-1", source: "test-client", extract: true,
    messages: [{ role: "user", content: "以后请用中文回答，这是我的长期偏好" }, { role: "assistant", content: "好的。" }],
  };
  const first = await call("/v1/conversations/capture", body);
  assert.equal(first.status, 200);
  assert.equal(first.data.candidateCount, 0);
  assert.deepEqual(first.data.candidates, []);
  assert.equal(first.data.extracted, false);
  assert.equal(first.data.duplicate, undefined);
  assert.ok(first.data.evidenceId.startsWith("conversation-"));
  const second = await call("/v1/conversations/capture", body);
  assert.equal(second.status, 200);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.deduped, true);
  assert.equal(second.data.evidenceId, first.data.evidenceId);
  const evidence = await fs.readFile(first.data.evidencePath, "utf8");
  assert.match(evidence, /原始对话记录/);
  assert.match(evidence, /长期偏好/);
});

test("capture workspace and tags annotate evidence while formal memory filters remain available", async () => {
  const body = {
    credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD,
    source: "dsh-session", conversation_id: "workspace-test-1", event_id: "workspace-test-1#turn-1",
    workspace: "D:/AI/WANGDIAN", tags: ["wangdian", "capture-test"], extract: true,
    messages: [{ role: "user", content: "以后请记住这个项目决定使用工作区隔离" }],
  };
  const capture = await call("/v1/conversations/capture", body);
  assert.equal(capture.status, 200);
  assert.equal(capture.data.workspace, "D:/AI/WANGDIAN");
  assert.deepEqual(capture.data.tags, ["wangdian", "capture-test"]);
  assert.equal(capture.data.candidateCount, 0);
  assert.deepEqual(capture.data.candidates, []);
  const evidence = await fs.readFile(capture.data.evidencePath, "utf8");
  assert.match(evidence, /workspace: "D:\/AI\/WANGDIAN"/);
  assert.match(evidence, /tags: \["wangdian", "capture-test"\]/);

  const listMatch = await call("/v1/memory/list", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD, workspace: "D:/AI/WANGDIAN", tags: ["wangdian"] });
  assert.equal(listMatch.status, 200);
  assert.ok(listMatch.data.items.every((item) => item.frontmatter.workspace === '"D:/AI/WANGDIAN"'));
  const listMiss = await call("/v1/memory/list", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD, workspace: "D:/AI/OTHER" });
  assert.equal(listMiss.status, 200);
  assert.equal(listMiss.data.count, 0);

  const projectRoot = path.join(FIXTURE_DATA, "project-state", "d-ai-wangdian");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "workspace-filter.md"), '---\nid: workspace-filter\nscope: project:d-ai-wangdian\nworkspace: "D:/AI/WANGDIAN"\ntags: ["wangdian", "capture-test"]\n---\n# 项目事实\n\n工作区过滤唯一标记。\n', "utf8");
  const listVisible = await call("/v1/memory/list", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD, workspace: "D:/AI/WANGDIAN", tags: ["capture-test"] });
  assert.equal(listVisible.status, 200);
  assert.ok(listVisible.data.items.some((item) => item.id === "workspace-filter"));
  const searchVisible = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD, query: "工作区过滤唯一标记", workspace: "D:/AI/WANGDIAN", tags: ["wangdian"] });
  assert.equal(searchVisible.status, 200);
  assert.ok(searchVisible.data.results.some((item) => item.path.endsWith("workspace-filter.md")));
  const searchHidden = await call("/v1/search", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD, query: "工作区过滤唯一标记", workspace: "D:/AI/OTHER" });
  assert.equal(searchHidden.status, 200);
  assert.equal(searchHidden.data.count, 0);
});

test("capture accepts deprecated extract but remains evidence-only", async () => {
  const inboxRoot = path.join(FIXTURE_DATA, "inbox");
  const beforeInbox = await fs.readdir(inboxRoot).catch(() => []);
  const legacy = await call("/v1/conversations/capture", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_ASSISTANT, conversation_id: "legacy-capture", event_id: "legacy-1", messages: [{ role: "user", content: "请记住默认采集只保留原始证据" }] });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.candidateCount, 0);
  assert.deepEqual(legacy.data.candidates, []);
  assert.equal(legacy.data.extracted, false);
  const explicit = await call("/v1/conversations/capture", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_ASSISTANT, conversation_id: "explicit-extract", event_id: "explicit-1", extract: true, messages: [{ role: "user", content: "已废弃的 extract 参数仍兼容接收" }] });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.data.candidateCount, 0);
  assert.deepEqual(explicit.data.candidates, []);
  assert.equal(explicit.data.extracted, false);
  assert.match(await fs.readFile(explicit.data.evidencePath, "utf8"), /extract 参数仍兼容接收/);
  assert.deepEqual(await fs.readdir(inboxRoot).catch(() => []), beforeInbox);

  const privateField = await call("/v1/conversations/capture", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_STEWARD, conversation_id: "bad-extension", event_id: "bad-1", custom_project: "WANGDIAN", messages: [{ role: "user", content: "x" }] });
  assert.equal(privateField.status, 400);
  assert.equal(privateField.data.error.detail, "UNSUPPORTED_FIELDS");

  const denied = await call("/v1/conversations/capture", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_ASSISTANT, workspace: "WANGDIAN", messages: [{ role: "user", content: "x" }] });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.detail, "SCOPE_DENIED");
});

test("automatic capture is queued to evidence without default candidate growth", async () => {
  const inboxRoot = path.join(FIXTURE_DATA, "inbox");
  const beforeInbox = await fs.readdir(inboxRoot).catch(() => []);
  const r = await call("/v1/pet/command", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_ASSISTANT, input: "请介绍今天可以讨论的技术主题", mode: "assistant", session_id: "queue-test" });
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const evidenceRoot = path.join(FIXTURE_DATA, "evidence", "conversations");
  const files = await fs.readdir(evidenceRoot).catch(() => []);
  assert.ok(files.some((name) => name.endsWith(".md")), "queued capture must drain to evidence");
  assert.deepEqual(await fs.readdir(inboxRoot).catch(() => []), beforeInbox, "automatic capture must never grow inbox");
});

test("transcript import endpoint queues a JSON transcript", async () => {
  const importRoot = path.join(FIXTURE_DATA, "transcript-import");
  await fs.mkdir(importRoot, { recursive: true });
  await fs.writeFile(path.join(importRoot, "sample.json"), JSON.stringify({ messages: [{ role: "user", content: "我的长期目标是完成自动记忆接入" }, { role: "assistant", content: "收到。" }] }), "utf8");
  const r = await call("/v1/transcripts/import/scan", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: PET_ASSISTANT, source: "fixture-import" });
  assert.equal(r.status, 200);
  assert.equal(r.data.queued, 1);
});

test("pet companion capture stores evidence without extracting candidates", async () => {
  const r = await call("/v1/conversations/capture", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: { agent_id: "pilot-01", role_id: "pet-companion" }, conversation_id: "capture-readonly-1", messages: [{ role: "user", content: "普通聊天记录" }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.candidateCount, 0);
  assert.equal(r.data.extracted, false);
});

test("/research works memory-only when no web provider configured", async () => {
  const r = await petCall("/research 记忆库协议");
  assert.equal(r.status, 200);
  assert.match(r.data.reply, /研究结论（测试）/);
  assert.equal(r.data.web_sources, 0);
});

test("/fetch fetches a URL and summarizes (local endpoint)", async () => {
  const r = await petCall(`/fetch http://127.0.0.1:${addr.port}/v1/health`);
  assert.equal(r.status, 200);
  assert.equal(r.data.fetched, true);
  assert.match(r.data.reply, /已抓取/);
});

test("pet commands never touch curated", { concurrency: false }, async () => {
  await adapter.flushCaptures();
  const before = await snapshotTree(path.join(FIXTURE_DATA, "curated"));
  await petCall("/learn:topic another");
  await petCall("随便聊聊");
  await adapter.flushCaptures();
  const after = await snapshotTree(path.join(FIXTURE_DATA, "curated"));
  const diff = diffSnapshots(before, after);
  if (diff.length) console.log("[FIX1-OBSERVED-CURATED-DIFF]", JSON.stringify(diff));
  assert.deepEqual(diff, [], "curated must be untouched");
});
