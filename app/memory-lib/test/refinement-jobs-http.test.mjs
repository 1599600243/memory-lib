// MEMORY-LOOP-1（第一垂直切片）——"一段对话证据落盘 ⇒ 自动产生一张可追踪的提炼待办" + 公开 HTTP 领取接口。
//
// 为什么必须打在 HTTP 这一层：本切片要的是**公开接口**能力，不是内部函数的正确性。
// 这个测试同时钉两件事：
//   ① 生产者接线：真实入口 /v1/conversations/capture 完成后，待办**已经**存在
//      （而不是"谁记得去调一下就会建"）；
//   ② 消费者接线：/v1/refinement/jobs/{list,get,claim} 真挂在真实服务上，且受认证 + 租户作用域约束
//      （新通道不许成为"有 id 就能读别人东西"的第五个口子）。
//
// 夹具刻意是**非空**的正常对话：空夹具区分不了"因为没内容所以没建待办"和"因为没接线所以没建"。
// 期望值全部来自**独立真值源**：请求里发出去的值、夹具 registry 里的身份、以及本测试自己的时钟；
// 不用被测代码的算法重算一遍期望值（那是同义反复，永远不会红）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = { agent_id: "pilot-01", role_id: "researcher" };
const SAME_TENANT = { agent_id: "pilot-01", role_id: "steward" };
const OTHER_TENANT = { agent_id: "pilot-01", role_id: "pet-steward" };
// reader 在夹具里**没有** group_id/user_id ⇒ 认证通过但身份未绑定（principal 里是 "unknown"）。
const UNBOUND_IDENTITY = { agent_id: "pilot-01", role_id: "reader" };
const WORKSPACE = "D:/MemoryLib/app/memory-lib";

test("ML1 切片1：正常捕获自动产生一张待办；list/get/claim 走真实 HTTP 且限租户", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-jobs-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const pilot = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef).agents.find((item) => item.agent_id === "pilot-01");
  const roleOf = (roleId) => pilot.roles.find((item) => item.role_id === roleId);
  // 身份夹具：owner 与 same-tenant 同组同用户（不同角色）；other-tenant 是另一个租户。
  const ownerRole = roleOf("researcher");
  Object.assign(ownerRole, { group_id: "group-ml1", user_id: "user-ml1" });
  // 带 workspace 的捕获要求角色持有该项目的项目作用域（localhost-server 的捕获路由按
  // workspaceKey(workspace) 派生 project 再校验），所以这里精确授一个同名项目作用域。
  ownerRole.scopes = [...ownerRole.scopes, { layer: "memory", visibility: "project", project: "d-memorylib-app-memory-lib" }];
  Object.assign(roleOf("steward"), { group_id: "group-ml1", user_id: "user-ml1" });
  Object.assign(roleOf("pet-steward"), { group_id: "group-ml2", user_id: "user-ml2" });
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const libFactory = createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
  const startServer = () => createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    calendarTimezone: "UTC",
    libFactory,
  });

  async function post(port, url, body, principal = OWNER) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }

  const conversation = [
    { role: "user", content: "我们在 memory-lib 里加了提炼任务控制面，这一片只做待办的产生、读取和领取。" },
    { role: "assistant", content: "记下了：先只覆盖 pending → claimed，结论提交与完成度度量留到下一片。" },
  ];
  const captureBody = { messages: conversation, conversation_id: "ml1-http-conv-1", event_id: "ml1-http-event-1", source: "ml1-http-test", workspace: WORKSPACE };

  let server = startServer();
  try {
    const port = (await server.listen()).port;

    // ① 生产者：真实 HTTP 入口捕获一次正常对话。
    const captureStart = Date.now();
    const captured = await post(port, "/v1/conversations/capture", captureBody);
    const captureEnd = Date.now();
    assert.equal(captured.status, 200, `capture must succeed, got ${captured.status} ${JSON.stringify(captured.body)}`);
    const evidenceId = captured.body.evidenceId;
    assert.match(evidenceId, /^conversation-[0-9a-f]{24}$/u, "fixture evidence must be a real conversation evidence id");

    // ② 消费者：待办必须已经存在，且单子要求的字段逐条钉死。
    const listed = await post(port, "/v1/refinement/jobs/list", {});
    assert.equal(listed.status, 200, `jobs list must be a real route, got ${listed.status} ${JSON.stringify(listed.body)}`);
    assert.equal(listed.body.count, 1, `one capture must yield exactly one job, got ${JSON.stringify(listed.body.jobs)}`);
    const job = listed.body.jobs[0];
    assert.match(job.job_id, /^job-[0-9a-f]{24}$/u, `job_id shape, got ${job.job_id}`);
    assert.equal(job.conversation_id, "ml1-http-conv-1");
    assert.deepEqual(job.evidence_ids, [evidenceId]);
    assert.equal(job.workspace, WORKSPACE);
    assert.equal(job.project, "d-memorylib-app-memory-lib");
    assert.deepEqual(job.principal, { tenant_id: "default", framework_id: "deepseek-harness", group_id: "group-ml1", user_id: "user-ml1", agent_id: "pilot-01", role_id: "researcher" });
    assert.equal(job.target_layer, "project-state");
    assert.equal(job.trigger_reason, "conversation_capture");
    const createdAt = Date.parse(job.created_at);
    assert.ok(createdAt >= captureStart && createdAt <= captureEnd, `created_at must be the capture instant, got ${job.created_at}`);
    assert.equal(Date.parse(job.deadline) - createdAt, 24 * 60 * 60 * 1000, `deadline must be created_at + 24h, got ${job.deadline}`);
    assert.equal(job.state, "pending");
    assert.equal(job.claimed_by, null);
    assert.equal(job.claimed_at, null);

    // ③ 重复捕获幂等：仍是同一张待办，不许长出第二张。
    const duplicate = await post(port, "/v1/conversations/capture", captureBody);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true, "the same capture must be deduped at the evidence layer");
    assert.equal(duplicate.body.evidenceId, evidenceId);
    const afterDuplicate = await post(port, "/v1/refinement/jobs/list", {});
    assert.equal(afterDuplicate.body.count, 1, "a duplicate capture must not create a second job");
    assert.equal(afterDuplicate.body.jobs[0].job_id, job.job_id, "a duplicate capture must not create a second job_id");

    // ④ partial（未完成）捕获不产生待办 —— 这是"非 partial"这条硬条件。
    const partial = await post(port, "/v1/conversations/capture", { ...captureBody, conversation_id: "ml1-http-conv-partial", event_id: "ml1-http-event-partial", partial: true });
    assert.equal(partial.status, 200, `partial capture must succeed, got ${partial.status} ${JSON.stringify(partial.body)}`);
    assert.equal(partial.body.partial, true);
    assert.notEqual(partial.body.evidenceId, evidenceId, "the partial capture must be a distinct evidence record");
    const afterPartial = await post(port, "/v1/refinement/jobs/list", {});
    assert.equal(afterPartial.body.count, 1, `a partial capture must not create a job, got ${JSON.stringify(afterPartial.body.jobs)}`);

    // ⑤ 落盘即真相：换一个服务实例（同一个 dataRoot）必须看到同一张待办。
    await server.close();
    server = startServer();
    const port2 = (await server.listen()).port;
    const persisted = await post(port2, "/v1/refinement/jobs/list", {});
    assert.equal(persisted.body.count, 1, "the job must live under the data root, not in process memory");
    assert.equal(persisted.body.jobs[0].job_id, job.job_id);
    assert.equal(persisted.body.jobs[0].state, "pending");

    // ⑥ 没有凭证：新接口必须被拒（不许变成"没身份也放行"的通道）。
    const anonymous = await fetch(`http://127.0.0.1:${port2}/v1/refinement/jobs/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(anonymous.status, 401, `jobs list without a credential must be 401, got ${anonymous.status}`);

    // ⑦ 跨租户负向：别人的待办不下发、读不到、抢不走（换 job_id 不构成授权）。
    const foreignList = await post(port2, "/v1/refinement/jobs/list", {}, OTHER_TENANT);
    assert.equal(foreignList.status, 200);
    assert.equal(foreignList.body.count, 0, `another tenant must not see this job, got ${JSON.stringify(foreignList.body.jobs)}`);
    const foreignGet = await post(port2, "/v1/refinement/jobs/get", { job_id: job.job_id }, OTHER_TENANT);
    assert.equal(foreignGet.status, 404, `cross-tenant get must be invisible, got ${foreignGet.status} ${JSON.stringify(foreignGet.body)}`);
    const foreignClaim = await post(port2, "/v1/refinement/jobs/claim", { job_id: job.job_id }, OTHER_TENANT);
    assert.equal(foreignClaim.status, 404, `cross-tenant claim must be invisible, got ${foreignClaim.status} ${JSON.stringify(foreignClaim.body)}`);
    const stillPending = await post(port2, "/v1/refinement/jobs/get", { job_id: job.job_id });
    assert.equal(stillPending.body.job.state, "pending", "a refused cross-tenant claim must not change the job state");

    // ⑦' 有认证但**没绑身份**的角色（reader 在夹具里没有 group_id/user_id）同样什么都看不到。
    // 这是"没身份不许变成全部可见"的那半边：作用域判定的默认拒绝分支必须真的被执行到。
    const unboundList = await post(port2, "/v1/refinement/jobs/list", {}, UNBOUND_IDENTITY);
    assert.equal(unboundList.status, 200, `unbound identity list should still answer, got ${unboundList.status} ${JSON.stringify(unboundList.body)}`);
    assert.equal(unboundList.body.count, 0, `an identity-less caller must see no job, got ${JSON.stringify(unboundList.body.jobs)}`);
    const unboundGet = await post(port2, "/v1/refinement/jobs/get", { job_id: job.job_id }, UNBOUND_IDENTITY);
    assert.equal(unboundGet.status, 404, `an identity-less caller must not read the job, got ${unboundGet.status}`);

    // ⑧ 领取：pending → claimed，并落下领取者与领取时刻。
    const claimStart = Date.now();
    const claimed = await post(port2, "/v1/refinement/jobs/claim", { job_id: job.job_id });
    const claimEnd = Date.now();
    assert.equal(claimed.status, 200, `claim must succeed, got ${claimed.status} ${JSON.stringify(claimed.body)}`);
    assert.equal(claimed.body.job.state, "claimed");
    assert.equal(claimed.body.already_claimed, false);
    assert.deepEqual(claimed.body.job.claimed_by, { tenant_id: "default", framework_id: "deepseek-harness", group_id: "group-ml1", user_id: "user-ml1", agent_id: "pilot-01", role_id: "researcher" });
    const claimedAt = Date.parse(claimed.body.job.claimed_at);
    assert.ok(claimedAt >= claimStart && claimedAt <= claimEnd, `claimed_at must be the claim instant, got ${claimed.body.job.claimed_at}`);
    const afterClaim = await post(port2, "/v1/refinement/jobs/list", {});
    assert.equal(afterClaim.body.jobs[0].state, "claimed", "the list must reflect the claimed state");

    // ⑨ 同一租户的第二个角色不许抢走已被领取的待办。
    const stolen = await post(port2, "/v1/refinement/jobs/claim", { job_id: job.job_id }, SAME_TENANT);
    assert.equal(stolen.status, 409, `a second claim must conflict, got ${stolen.status} ${JSON.stringify(stolen.body)}`);
    const afterStolen = await post(port2, "/v1/refinement/jobs/get", { job_id: job.job_id });
    assert.equal(afterStolen.body.job.claimed_by.role_id, "researcher", "the refused second claim must not take the job over");

    // ⑩ 领取者重复领取是幂等的：不许重新计时。
    const reClaim = await post(port2, "/v1/refinement/jobs/claim", { job_id: job.job_id });
    assert.equal(reClaim.status, 200);
    assert.equal(reClaim.body.already_claimed, true);
    assert.equal(reClaim.body.job.claimed_at, claimed.body.job.claimed_at, "re-claiming must not reset claimed_at");

    // ⑪ 不存在的待办与未知 id 语义一致。
    const missing = await post(port2, "/v1/refinement/jobs/get", { job_id: "job-000000000000000000000000" });
    assert.equal(missing.status, 404, `unknown job_id must be 404, got ${missing.status} ${JSON.stringify(missing.body)}`);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    // ⑫ 先 partial、后完成：待办对应的是**完成**的那一次捕获 —— 分片到达（partial）不许先开一张，
    // 完成时再开一张。这条覆盖单子里的"completed/non-partial"。
    const resumed = { messages: [...conversation, { role: "user", content: "补充：这一片不碰结论提交与完成度度量。" }], conversation_id: "ml1-http-conv-2", event_id: "ml1-http-event-2", source: "ml1-http-test", workspace: WORKSPACE };
    const openPartial = await post(port2, "/v1/conversations/capture", { ...resumed, partial: true });
    assert.equal(openPartial.status, 200, `partial capture must succeed, got ${openPartial.status} ${JSON.stringify(openPartial.body)}`);
    assert.equal(openPartial.body.partial, true);
    const whilePartial = await post(port2, "/v1/refinement/jobs/list", {});
    assert.equal(whilePartial.body.count, 1, `an unfinished capture must not open a job, got ${JSON.stringify(whilePartial.body.jobs.map((item) => item.conversation_id))}`);
    const completed = await post(port2, "/v1/conversations/capture", resumed);
    assert.equal(completed.status, 200);
    assert.equal(completed.body.partial, false);
    assert.equal(completed.body.evidenceId, openPartial.body.evidenceId, "the completion must land on the same evidence record");
    const afterComplete = await post(port2, "/v1/refinement/jobs/list", {});
    assert.equal(afterComplete.body.count, 2, `a completed capture must open exactly one job, got ${JSON.stringify(afterComplete.body.jobs.map((item) => item.conversation_id))}`);
    const resumedJob = afterComplete.body.jobs.find((item) => item.conversation_id === "ml1-http-conv-2");
    assert.ok(resumedJob, "the completed capture must have its own job");
    assert.deepEqual(resumedJob.evidence_ids, [completed.body.evidenceId]);
    assert.equal(resumedJob.state, "pending");
    assert.equal(resumedJob.claimed_by, null);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
