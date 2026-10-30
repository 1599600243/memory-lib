// memory-lib — learning API tests.
// Run directly: node test/learning.test.mjs
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
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-learning-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const TEST_AUTH = await createTestAuth(ROOT, TMP);

const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const LEARNING_ROOT = path.join(FIXTURE_WORKSPACE, "learning");
const REGISTRY_PATH = TEST_AUTH.registryPath;
const SECRET_STORE = TEST_AUTH.secretStore;
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const CREDENTIAL_REF = TEST_AUTH.credentialRef;
const DEV_SECRET = (await fs.readFile(path.join(SECRET_STORE.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

const READER = { agent_id: "pilot-01", role_id: "reader" };
const LEARNER = { agent_id: "pilot-01", role_id: "learner" };

const libFactory = ({ scopes }) => createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes });
const adapter = createLocalhostServer({ libFactory, registryPath: REGISTRY_PATH, secretStore: SECRET_STORE, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0 });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

async function call(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const learnerCall = (route, extra = {}) => call(route, { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: LEARNER, ...extra });

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("reader cannot use learning endpoints -> 403 ACTION_DENIED", async () => {
  const { status, data } = await call("/v1/learning/plan_get", { credential_ref: CREDENTIAL_REF, secret: DEV_SECRET, principal: READER, topic: "x" });
  assert.equal(status, 403);
  assert.equal(data.error.detail, "ACTION_DENIED");
});

test("plan_put -> plan.json written; plan_get -> same plan", async () => {
  const topic = "memory-architecture";
  const modules = [
    { id: "m1", title: "文件真源", weight: 3, difficulty: "low" },
    { id: "m2", title: "身份与授权", weight: 2, difficulty: "medium", dependencies: ["m1"] },
  ];
  const put = await learnerCall("/v1/learning/plan_put", { topic, plan: { modules } });
  assert.equal(put.status, 200);
  assert.equal(put.data.plan.map.modules.length, 2);
  assert.deepEqual(put.data.plan.map.modules[1].dependencies, ["m1"]);

  const file = path.join(LEARNING_ROOT, "memory-architecture", "plan.json");
  assert.ok(await fs.stat(file).then(() => true).catch(() => false), "plan.json written to learning root");

  const get = await learnerCall("/v1/learning/plan_get", { topic });
  assert.equal(get.status, 200);
  assert.equal(get.data.plan.map.modules[0].title, "文件真源");
});

test("progress_put/get round-trip with normalization", async () => {
  const topic = "memory-architecture";
  const put = await learnerCall("/v1/learning/progress_put", {
    topic,
    progress: { modules: { m1: { status: "learning", mastery: 0.6, attempts: 3 }, m2: { status: "not_started" } } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.progress.modules.m1.mastery, 0.6);
  assert.equal(put.data.progress.modules.m2.status, "not_started");

  const get = await learnerCall("/v1/learning/progress_get", { topic });
  assert.equal(get.data.progress.modules.m1.attempts, 3);
});

test("spaced repetition: correct advances round, wrong resets; due scheduling works", async () => {
  const topic = "memory-architecture";
  // first review, correct -> round 1, next due ~1 day later
  const r1 = await learnerCall("/v1/learning/review_put", { topic, results: [{ module_id: "m1", correct: true }] });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.review.items.m1.round, 1);
  const due1 = new Date(r1.data.review.items.m1.nextDue).getTime();
  assert.ok(due1 > Date.now(), "next due in future after correct");
  assert.ok(due1 - Date.now() < 2 * 24 * 3600 * 1000, "round-1 interval ~1 day");

  // wrong -> reset to round 0
  const r2 = await learnerCall("/v1/learning/review_put", { topic, results: [{ module_id: "m1", correct: false }] });
  assert.equal(r2.data.review.items.m1.round, 0);

  // no items due right after scheduling (future nextDue)
  const get = await learnerCall("/v1/learning/review_get", { topic });
  assert.equal(get.data.due.length, 0, "nothing due immediately after scheduling");

  // inject a past nextDue directly (file-first) -> becomes due
  const reviewFile = path.join(LEARNING_ROOT, "memory-architecture", "review.json");
  const review = JSON.parse(await fs.readFile(reviewFile, "utf8"));
  review.items.m2 = { round: 1, nextDue: new Date(Date.now() - 3600 * 1000).toISOString() };
  await fs.writeFile(reviewFile, JSON.stringify(review, null, 2), "utf8");
  const get2 = await learnerCall("/v1/learning/review_get", { topic });
  assert.equal(get2.data.due.length, 1);
  assert.equal(get2.data.due[0].module_id, "m2");
});

test("profile_put/get", async () => {
  const put = await learnerCall("/v1/learning/profile_put", { profile: { name: "测试学习者", goals: ["掌握记忆库", "理解协议"] } });
  assert.equal(put.status, 200);
  assert.equal(put.data.profile.goals.length, 2);
  const get = await learnerCall("/v1/learning/profile_get");
  assert.equal(get.data.profile.name, "测试学习者");
});

test("learning writes never touch curated", async () => {
  const before = await snapshotTree(path.join(FIXTURE_DATA, "curated"));
  await learnerCall("/v1/learning/plan_put", { topic: "another-topic", plan: { modules: [{ id: "a", title: "A" }] } });
  await learnerCall("/v1/learning/profile_put", { profile: { name: "x" } });
  const after = await snapshotTree(path.join(FIXTURE_DATA, "curated"));
  assert.deepEqual(diffSnapshots(before, after), [], "curated must be untouched");
});
