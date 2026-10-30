// VISIBILITY-FIX-1 追加 —— `learning` 读路径的默认拒绝（**红先行**）。
//
// 事实（验收岗实测，本单复核 registry 确认）：部署 registry 里**有两个**角色带 `learning` 动作
//   pilot-01/learner actions=["learning"] · pilot-01/pet actions=["search","get","learning","pet"]
// 而 `learning.mjs` 的读方法**完全不接身份**（只有动作门）⇒ 拿到该动作就能读**任意 topic**。
//
// 本文件断言：
//   ① 正对照：`learner`（有 learning 动作）能读到夹具里的 topic（证明夹具非空、判据有判别力）
//   ② 无身份调用 learning 读方法 ⇒ **拒绝**（MISSING_PRINCIPAL），不是返回空
//   ③ `reader`（无 learning 动作）⇒ 403
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createLearningApi } from "../src/learning.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOPIC = "visfix1-topic";
const TOPIC_MARK = "VISFIX1-LEARNING-CONTENT";

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1-learn-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const learningRoot = path.join(workspaceRoot, "learning");
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(learningRoot, { recursive: true });

  // 学习夹具：写一个 plan（**非空**，含可辨识内容）
  const learning = createLearningApi(learningRoot);
  await learning.putPlan(TOPIC, {
    topic: TOPIC,
    modules: [{ id: "m1", title: TOPIC_MARK, status: "pending" }],
  });

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) {
    role.group_id ??= "home-circle";
    role.user_id ??= "user-owner";
  }
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return { tmp, dataRoot, workspaceRoot, learningRoot, auth };
}

async function withServer(fn) {
  const f = await fixture();
  const server = createLocalhostServer({
    registryPath: f.auth.registryPath,
    secretStore: f.auth.secretStore,
    dataRoot: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
    auditPath: path.join(f.tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory: createServerLibFactory({ dataRoot: f.dataRoot, workspaceRoot: f.workspaceRoot, vectorLane: { probe: false } }),
  });
  try {
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const mcp = (agent, role, name, args) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": f.auth.credentialRef, "x-mcp-secret": f.auth.authValue, "x-mcp-agent": agent, "x-mcp-role": role },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      const text = String(body?.result?.content?.[0]?.text ?? "");
      return { status: r.status, isError: body?.result?.isError === true, text };
    });
    return await fn({ mcp, learningRoot: f.learningRoot });
  } finally {
    await server.close();
    await fs.rm(f.tmp, { recursive: true, force: true });
  }
}

test("① 正对照：learner（有 learning 动作）读得到夹具里的 topic", async () => {
  await withServer(async ({ mcp }) => {
    const r = await mcp("pilot-01", "learner", "learning_plan_get", { topic: TOPIC });
    assert.equal(r.isError, false, `正对照不该报错：${r.text.slice(0, 300)}`);
    assert.match(r.text, new RegExp(TOPIC_MARK, "u"), `learner 必须读得到夹具内容（判别力前提）；实际 ${r.text.slice(0, 300)}`);
  });
});

test("② 无身份调用 learning 读方法必须拒绝（不许返回数据）", async () => {
  const { tmp, learningRoot } = await fixture();
  try {
    const learning = createLearningApi(learningRoot);
    for (const [label, call] of [
      ["getPlan(topic)", () => learning.getPlan(TOPIC)],
      ["getProgress(topic)", () => learning.getProgress(TOPIC)],
      ["getReview(topic)", () => learning.getReview(TOPIC)],
      ["listDueReviews()", () => learning.listDueReviews()],
      ["getProfile()", () => learning.getProfile()],
    ]) {
      await assert.rejects(
        async () => { await call(); },
        (error) => {
          assert.equal(error?.code, "MISSING_PRINCIPAL", `${label} 必须以 MISSING_PRINCIPAL 拒绝，实际：${error?.message}`);
          return true;
        },
        `${label} 在无身份时必须拒绝`,
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("③ reader（无 learning 动作）读 learning 必须 403", async () => {
  await withServer(async ({ mcp }) => {
    const r = await mcp("pilot-01", "reader", "learning_plan_get", { topic: TOPIC });
    assert.equal(r.isError, true, `reader 不该读到 learning：${r.text.slice(0, 200)}`);
    assert.match(r.text, /FORBIDDEN|ACTION_DENIED/u, r.text.slice(0, 200));
  });
});
