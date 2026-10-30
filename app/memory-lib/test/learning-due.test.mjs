// memory-lib — F7 due-review query tests (/v1/learning/review_get, topic omitted).
// Isolated: own TMP workspace + own registry copy, so nothing here can touch the
// real learning data or curated memory. Read-only assertions use zero-write-check.
// Run directly: node test/learning-due.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createCoreClient, createMcpHandler } from "../mcp/mcp-server.mjs";
import { snapshotTree, diffSnapshots } from "../scripts/zero-write-check.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-learning-due-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const TEST_AUTH = await createTestAuth(ROOT, TMP);

const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const LEARNING_ROOT = path.join(FIXTURE_WORKSPACE, "learning");
const CURATED_ROOT = path.join(FIXTURE_DATA, "curated");
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const CREDENTIAL_REF = TEST_AUTH.credentialRef;
const SECRET_STORE = TEST_AUTH.secretStore;
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

const READER = { agent_id: "pilot-01", role_id: "reader" };
const LEARNER = { agent_id: "pilot-01", role_id: "learner" };

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: TEST_AUTH.registryPath, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

const learnerHandler = createMcpHandler(createCoreClient(BASE, { credRef: CREDENTIAL_REF, secret: DEV_SECRET, agent: "pilot-01", role: "learner" }));

async function call(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const learnerCall = (route, extra = {}) => call(route, { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: LEARNER, ...extra });
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

// File-first review writes (same shape putReview produces), so we can place items in the past.
async function writeReview(topic, items) {
  const file = path.join(LEARNING_ROOT, topic, "review.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ topic, items, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
}

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("review_get without topic -> empty aggregate when nothing is scheduled", async () => {
  const { status, data } = await learnerCall("/v1/learning/review_get");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.scope, "all");
  assert.equal(data.count, 0);
  assert.deepEqual(data.due, []);
  assert.deepEqual(data.topics, []);
  assert.equal("all_items" in data, false, "aggregate must not dump every review item");
});

test("review_get without topic -> past-due items across topics, titled from plan.json, sorted by next_due", async () => {
  await learnerCall("/v1/learning/plan_put", { topic: "f7-alpha", plan: { modules: [
    { id: "m1", title: "Alpha 基础", weight: 2, difficulty: "low" },
    { id: "m2", title: "Alpha 进阶", weight: 1, difficulty: "high" },
  ] } });
  await learnerCall("/v1/learning/plan_put", { topic: "f7-beta", plan: { modules: [{ id: "b1", title: "Beta 概念" }] } });

  // f7-alpha: m2 past due, m1 future, plus an unparseable nextDue that must be ignored
  await writeReview("f7-alpha", {
    m2: { round: 2, nextDue: hoursFromNow(-3) },
    m1: { round: 1, nextDue: hoursFromNow(24) },
    m3: { round: 0, nextDue: "not-a-date" },
  });
  await writeReview("f7-beta", { b1: { round: 1, nextDue: hoursFromNow(-1) } });
  // f7-gamma has a review but no plan.json -> module_title falls back to null
  await writeReview("f7-gamma", { g1: { round: 3, nextDue: hoursFromNow(-5) } });

  const { status, data } = await learnerCall("/v1/learning/review_get");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.scope, "all");
  assert.equal(data.count, 3);
  assert.deepEqual(data.topics, ["f7-alpha", "f7-beta", "f7-gamma"], "topics enumerated from review.json dirs");
  assert.deepEqual(data.due.map((d) => [d.topic, d.module_id]), [["f7-gamma", "g1"], ["f7-alpha", "m2"], ["f7-beta", "b1"]], "earliest next_due first");

  assert.deepEqual(data.due[0], { topic: "f7-gamma", module_id: "g1", round: 3, next_due: data.due[0].next_due, module_title: null });
  assert.equal(data.due[1].module_title, "Alpha 进阶", "module title comes from that topic's plan.json");
  assert.equal(data.due[2].module_title, "Beta 概念");
  for (const item of data.due) {
    assert.ok(new Date(item.next_due).getTime() <= Date.now(), `${item.module_id} is due`);
    assert.deepEqual(Object.keys(item).sort(), ["module_id", "module_title", "next_due", "round", "topic"]);
  }

  // sorted ascending by next_due
  const times = data.due.map((d) => new Date(d.next_due).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  // an explicit empty topic behaves exactly like an omitted one
  const empty = await learnerCall("/v1/learning/review_get", { topic: "" });
  assert.deepEqual(empty.data, data);
});

test("review_get with topic -> existing per-topic response preserved", async () => {
  const { status, data } = await learnerCall("/v1/learning/review_get", { topic: "f7-alpha" });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.topic, "f7-alpha");
  assert.deepEqual(Object.keys(data).sort(), ["all_items", "due", "ok", "topic"], "no aggregate fields on the per-topic response");
  assert.deepEqual(data.due.map((d) => d.module_id), ["m2"], "only past-due modules of that topic");
  assert.deepEqual(Object.keys(data.due[0]).sort(), ["module_id", "next_due", "round"]);
  assert.equal(data.all_items.m1.round, 1, "per-topic response still returns all_items");

  const missing = await learnerCall("/v1/learning/review_get", { topic: "no-such-topic" });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data.due, []);
});

test("reader cannot read due reviews (aggregate) -> 403 ACTION_DENIED", async () => {
  const { status, data } = await call("/v1/learning/review_get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER });
  assert.equal(status, 403);
  assert.equal(data.error.detail, "ACTION_DENIED");
});

test("MCP learning_review_get without topic -> same aggregate; schema no longer requires topic", async () => {
  const list = await learnerHandler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = list.result.tools.find((t) => t.name === "learning_review_get");
  assert.ok(tool, "learning_review_get is exposed");
  assert.equal(tool.inputSchema.required, undefined, "topic is optional");

  const r = await learnerHandler.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "learning_review_get", arguments: {} } });
  assert.equal(r.result.isError, false);
  const data = JSON.parse(r.result.content[0].text);
  assert.equal(data.count, 3);
  assert.equal(data.due[0].module_title, null);
  assert.deepEqual(data.due.map((d) => d.topic), ["f7-gamma", "f7-alpha", "f7-beta"]);

  const perTopic = await learnerHandler.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "learning_review_get", arguments: { topic: "f7-beta" } } });
  const perTopicData = JSON.parse(perTopic.result.content[0].text);
  assert.equal(perTopicData.topic, "f7-beta");
  assert.equal(perTopicData.due[0].module_id, "b1");
});

test("due query is read-only: learning files and curated unchanged", async () => {
  const learningBefore = await snapshotTree(LEARNING_ROOT);
  const curatedBefore = await snapshotTree(CURATED_ROOT);

  await learnerCall("/v1/learning/review_get");
  await learnerCall("/v1/learning/review_get", { topic: "f7-alpha" });
  await learnerHandler.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "learning_review_get", arguments: {} } });

  assert.deepEqual(diffSnapshots(curatedBefore, await snapshotTree(CURATED_ROOT)), [], "curated must be untouched");
  assert.deepEqual(diffSnapshots(learningBefore, await snapshotTree(LEARNING_ROOT)), [], "due reads must not rewrite learning files");
  const review = JSON.parse(await fs.readFile(path.join(LEARNING_ROOT, "f7-alpha", "review.json"), "utf8"));
  assert.equal(review.items.m2.nextDue, (await learnerCall("/v1/learning/review_get", { topic: "f7-alpha" })).data.all_items.m2.nextDue, "stored schedule unchanged");
});
