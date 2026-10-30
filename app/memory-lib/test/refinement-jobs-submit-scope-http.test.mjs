// MEMORY-LOOP-1 —— 放行口径复核：提炼提交的"写授权"必须与 /v1/write 对**同一份写入输入**的
// 授权一致（spec re-review 的 medium 指认：conclusionScope 按层名猜了一个 visibility）。
//
// 判别点（每个都用真实 HTTP + 盘上文件，不用布尔断言）：
//   ① 有 propose、**没有** {memory, shared} 作用域的角色（P）：
//      · 同一份输入走 /v1/write ⇒ 200，落盘 container=long-term / visibility=private；
//      · 同一份输入走 /v1/refinement/jobs/submit ⇒ **必须也是 200**（修前 403 WRITE_SCOPE_DENIED
//        SUBMIT_SCOPE_DENIED: SCOPE_DENIED —— 门禁比它守的写入口更严，就是这次要修的那一格）。
//      落盘结果还必须逐字段等于 /v1/write 写出来的那份（container/visibility 都是 long-term/private）。
//   ② document 层的默认 visibility 是 platform（所有人可读），而 /v1/write 对**显式 platform**
//      要求 admin（WRITE-DENY-1 之后是 403 WRITE_SCOPE_DENIED / detail PLATFORM_REQUIRES_ADMIN；
//      旧实现表现为 400 WRITE_REJECTED）。于是：
//      · 无 admin 的角色（Q）提交 document 结论 ⇒ **必须被拒 403**（修前 200：它能凭空写出
//        一份 platform 可见的记忆，而写入口在显式要求同一可见性时会拒它）；
//      · 有 admin 的角色（librarian-admin）提交 document 结论 ⇒ 200，落盘 platform（正对照）。
//   ③ 不能被这次改动顺手放宽的既有规则：项目层结论仍然要求该项目的项目作用域（与捕获写入口
//      同一把尺子）—— 同组同用户但没有该项目作用域的角色提交 project-state ⇒ 403、零写入。
//   ④ 零输出（no_durable_fact）仍然不需要任何写作用域（P 也没有 shared 作用域）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { DEFAULT_INSPECTION_REPORT_RELATIVE_PATH } from "../src/refinement-observability.mjs";

// REFINE-LOOP-1-REJECT1b：巡检报告的落点只有一处真值（模块导出的常量），
// 测试一律从这里派生，别再硬编码 —— 否则路径再挪一次就留下一堆过期断言。
const INSPECTION_REPORT_REL = DEFAULT_INSPECTION_REPORT_RELATIVE_PATH.split(path.sep).join("/");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GROUP = "group-ml1s";
const USER = "user-ml1s";
const PEER_USER = "user-ml1s-peer";
const WORKSPACE = "D:/MemoryLib/app/memory-lib";
const PROJECT = "d-memorylib-app-memory-lib";
const P = { agent_id: "pilot-01", role_id: "ml1-scope-project" };
const Q = { agent_id: "pilot-01", role_id: "researcher" };
const C = { agent_id: "pilot-01", role_id: "ml1-capture-with-project" };
const NO_PROJECT = { agent_id: "pilot-01", role_id: "ml1-no-project-scope" };
const ADMIN = { agent_id: "admin-01", role_id: "librarian-admin" };
const PEER = { agent_id: "ml1-peer-agent", role_id: "ml1-peer" };

// 夹具：**按生产身份的形状**造角色，不造假前提。
//   P           有 propose、没有 {memory, shared}（正是"门禁比写入口更严"的那一类）
//   Q           生产 researcher 形状（memory/shared + knowledge/shared），没有 admin
//   C           能带 workspace 捕获（需要该项目的项目作用域）
//   NO_PROJECT  同组同用户、能领（group/user 相同）但没有该项目作用域
//   PEER        同组、另一个 agent + 另一个 user + 另一个 role，只有 {memory, shared}（区分真共享）
async function setup() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-refinement-scope-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const framework = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef);
  const pilot = framework.agents.find((item) => item.agent_id === "pilot-01");
  const adminAgent = framework.agents.find((item) => item.agent_id === "admin-01");
  const roleOf = (agent, roleId) => agent.roles.find((item) => item.role_id === roleId);

  pilot.roles.push({
    role_id: P.role_id,
    scopes: [{ layer: "memory", visibility: "project", project: PROJECT }, { layer: "memory", visibility: "user", project: USER }],
    actions: ["search", "get", "propose"],
    group_id: GROUP,
    user_id: USER,
  });
  Object.assign(roleOf(pilot, "researcher"), { group_id: GROUP, user_id: USER });
  roleOf(pilot, "researcher").scopes = [...roleOf(pilot, "researcher").scopes, { layer: "memory", visibility: "project", project: PROJECT }];
  pilot.roles.push({
    role_id: C.role_id,
    scopes: [{ layer: "memory", visibility: "project", project: PROJECT }, { layer: "memory", visibility: "shared" }],
    actions: ["search", "get", "propose"],
    group_id: GROUP,
    user_id: USER,
  });
  pilot.roles.push({
    role_id: NO_PROJECT.role_id,
    scopes: [{ layer: "memory", visibility: "shared" }],
    actions: ["search", "get", "propose"],
    group_id: GROUP,
    user_id: USER,
  });
  framework.agents.push({
    agent_id: PEER.agent_id,
    roles: [{ role_id: PEER.role_id, scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get"], group_id: GROUP, user_id: PEER_USER }],
  });
  Object.assign(roleOf(adminAgent, "librarian-admin"), { group_id: GROUP, user_id: USER });
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  // 夹具自检：P 确实没有 shared 作用域、确实有 propose（否则"没有 shared 也能写"是空判据）。
  const pRole = roleOf(pilot, P.role_id);
  assert.equal(pRole.scopes.some((scope) => scope.layer === "memory" && scope.visibility === "shared"), false, "fixture: P must not hold a memory/shared scope");
  assert.equal(pRole.actions.includes("propose"), true, "fixture: P must hold the propose action");

  const server = createLocalhostServer({
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
    libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
  });

  async function post(port, url, body, principal) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }
  const relOf = (filePath) => path.relative(dataRoot, filePath).split(path.sep).join("/");
  // 正式记忆文件清单：排除**不是这次提交产物**的两处 —— 原文证据层，以及每次捕获都会被
  // refinement-observability 自动重写的提炼巡检报告（它已挪出检索根，落在 runtime/ 下）。
  const EXCLUDED_RELATIVE_PREFIXES = ["evidence/", INSPECTION_REPORT_REL];
  async function formalMemoryFiles() {
    const found = [];
    const stack = [dataRoot];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
        const relative = relOf(full);
        if (EXCLUDED_RELATIVE_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue;
        found.push(relative);
      }
    }
    return found.sort();
  }
  const frontmatterAt = async (relative) => parseFrontmatterTyped(await fs.readFile(path.join(dataRoot, relative), "utf8")).frontmatter;
  async function captureAndClaim(port, principal, { session, workspace = null }) {
    const captured = await post(port, "/v1/conversations/capture", {
      messages: [
        { role: "user", content: `${session}：这段对话用来量提交门禁与 /v1/write 的放行口径。` },
        { role: "assistant", content: "记下了：同一份写入输入，两条入口必须是同一把尺子。" },
      ],
      conversation_id: session,
      event_id: `${session}-event`,
      source: "ml1-scope-http-test",
      ...(workspace ? { workspace } : {}),
    }, principal);
    assert.equal(captured.status, 200, `capture must succeed, got ${captured.status} ${JSON.stringify(captured.body)}`);
    const listed = await post(port, "/v1/refinement/jobs/list", {}, principal);
    assert.equal(listed.status, 200);
    const job = listed.body.jobs.find((item) => item.conversation_id === session);
    assert.ok(job, `expected a job for ${session}, got ${JSON.stringify(listed.body.jobs.map((item) => item.conversation_id))}`);
    return { evidenceId: captured.body.evidenceId, job };
  }
  async function claimJob(port, jobId, principal) {
    const claimed = await post(port, "/v1/refinement/jobs/claim", { job_id: jobId }, principal);
    assert.equal(claimed.status, 200, `claim must succeed, got ${claimed.status} ${JSON.stringify(claimed.body)}`);
    assert.equal(claimed.body.job.state, "claimed");
    return claimed.body.job;
  }
  return {
    tmp, dataRoot, workspaceRoot, server, registryPath: auth.registryPath,
    post, formalMemoryFiles, frontmatterAt, captureAndClaim, claimJob,
    async close() { await server.close(); await fs.rm(tmp, { recursive: true, force: true }); },
  };
}

test("ML1 放行口径①：同一份写入输入，/v1/write 放行 ⇒ 提交门禁也必须放行（无 shared 作用域的角色）", async () => {
  const f = await setup();
  const { post, dataRoot, captureAndClaim, claimJob, formalMemoryFiles, frontmatterAt } = f;
  try {
    const port = (await f.server.listen()).port;

    const pCapture = await captureAndClaim(port, P, { session: "ml1s-p-shared" });
    assert.equal(pCapture.job.target_layer, "curated-shared");
    assert.equal(pCapture.job.project, null);
    await claimJob(port, pCapture.job.job_id, P);

    // 参照物：同一份输入走 /v1/write（P 没有 {memory, shared}，/v1/write 依然放行）。
    const direct = await post(port, "/v1/write", {
      layer: "curated-shared",
      id: "ml1s-direct-shared",
      body: "同一份输入的 /v1/write 对照：门禁不该比它更严。",
      evidence_refs: [pCapture.evidenceId],
    }, P);
    assert.equal(direct.status, 200, `/v1/write must accept the reference input, got ${direct.status} ${JSON.stringify(direct.body)}`);
    const directOnDisk = await frontmatterAt("curated/shared/ml1s-direct-shared.md");
    assert.equal(directOnDisk.container, "long-term", `the reference write lands in the long-term container, got ${JSON.stringify(directOnDisk.container)}`);
    assert.equal(directOnDisk.visibility, "private", `the reference write keeps the writer default visibility, got ${JSON.stringify(directOnDisk.visibility)}`);
    // 参照物不是"组内共享"：同组另一个 agent/user 读不到。写者自己也读不到 —— /v1/write 的放行
    // 只要求 propose，本来就不承诺给你读作用域（回执可回读由读作用域保证，见下面的 Q 用例）。
    assert.equal((await post(port, "/v1/get", { id: "ml1s-direct-shared" }, PEER)).status, 404, "the private reference write must not be group-readable");
    assert.equal((await post(port, "/v1/get", { id: "ml1s-direct-shared" }, P)).status, 404, "the write entry grants no read scope: P cannot read back its own /v1/write artifact either");

    // 判别点：同一份输入走提交门禁。
    const beforeSubmit = await formalMemoryFiles();
    const submitted = await post(port, "/v1/refinement/jobs/submit", {
      job_id: pCapture.job.job_id,
      conclusions: [{ layer: "curated-shared", id: "ml1s-submit-shared", body: "同一份输入走提交门禁：必须和 /v1/write 一样被放行。", evidence_refs: [pCapture.evidenceId] }],
    }, P);
    assert.equal(submitted.status, 200, `the submit entry must authorize exactly like /v1/write for the same write input, got ${submitted.status} ${JSON.stringify(submitted.body)}`);
    assert.equal(submitted.body.job.state, "completed");
    assert.equal(submitted.body.receipt.outcome, "written");
    const sharedWrite = submitted.body.receipt.writes[0];
    assert.equal(sharedWrite.id, "ml1s-submit-shared");
    assert.equal(sharedWrite.path, path.join(dataRoot, "curated", "shared", "ml1s-submit-shared.md"), `the conclusion must land in curated/shared, got ${sharedWrite.path}`);
    const submittedOnDisk = await frontmatterAt("curated/shared/ml1s-submit-shared.md");
    assert.equal(submittedOnDisk.container, directOnDisk.container, "the submit entry and /v1/write must produce the same container");
    assert.equal(submittedOnDisk.visibility, directOnDisk.visibility, "the submit entry and /v1/write must produce the same default visibility");
    assert.equal(submittedOnDisk.layer, directOnDisk.layer, "the submit entry and /v1/write must produce the same frontmatter layer");
    assert.equal((await post(port, "/v1/get", { id: "ml1s-submit-shared" }, PEER)).status, 404, "the written conclusion is private (same artifact as /v1/write), so another group member must not read it");
    assert.deepEqual(
      await formalMemoryFiles(),
      [...beforeSubmit, "curated/shared/ml1s-submit-shared.md"].sort(),
      `exactly one formal memory may be added by the accepted conclusion, got ${JSON.stringify(await formalMemoryFiles())}`,
    );

    // 回执可回读这一条**由读作用域保证**，不是由门禁保证：持有 {memory, shared} 的角色（Q）提交
    // 同一层 ⇒ 200，且能立刻按回执读回；旁观者仍读不到（写入的默认可见性就是 private）。
    const qSharedCapture = await captureAndClaim(port, Q, { session: "ml1s-q-shared" });
    await claimJob(port, qSharedCapture.job.job_id, Q);
    const qSharedSubmit = await post(port, "/v1/refinement/jobs/submit", {
      job_id: qSharedCapture.job.job_id,
      conclusions: [{ layer: "curated-shared", id: "ml1s-q-shared-ok", body: "持有该层读作用域的角色提交后必须能立刻读回回执。", evidence_refs: [qSharedCapture.evidenceId] }],
    }, Q);
    assert.equal(qSharedSubmit.status, 200, `a claimant holding the layer read scope must be able to submit, got ${qSharedSubmit.status} ${JSON.stringify(qSharedSubmit.body)}`);
    assert.equal(qSharedSubmit.body.receipt.writes[0].id, "ml1s-q-shared-ok");
    const qReadBack = await post(port, "/v1/get", { id: "ml1s-q-shared-ok" }, Q);
    assert.equal(qReadBack.status, 200, `the claimant must be able to read its receipt back, got ${qReadBack.status}`);
    assert.equal(qReadBack.body.item.path, path.join(dataRoot, "curated", "shared", "ml1s-q-shared-ok.md"));
    assert.equal((await post(port, "/v1/get", { id: "ml1s-q-shared-ok" }, PEER)).status, 404, "the default visibility of a curated-shared write is private: another group member must not read it");

    // ④ 零输出仍然不需要任何写作用域（P 也没有 shared 作用域）。
    const zeroCapture = await captureAndClaim(port, P, { session: "ml1s-p-zero" });
    await claimJob(port, zeroCapture.job.job_id, P);
    const beforeZero = await formalMemoryFiles();
    const zero = await post(port, "/v1/refinement/jobs/submit", { job_id: zeroCapture.job.job_id, no_durable_fact: { reason: "no_durable_fact", note: "这一段只是口径说明" } }, P);
    assert.equal(zero.status, 200, `a zero-output completion must not need a write scope, got ${zero.status} ${JSON.stringify(zero.body)}`);
    assert.equal(zero.body.receipt.outcome, "no_durable_fact");
    assert.deepEqual(zero.body.receipt.writes, [], "a zero-output completion writes nothing");
    assert.deepEqual(await formalMemoryFiles(), beforeZero, "a zero-output completion must not touch the formal layers");
  } finally {
    await f.close();
  }
});

test("ML1 放行口径③'：其余可写层的口径按『写出来的可见性』算（tool 要 admin；agent/plan/profile 只看身份）", async (t) => {
  const f = await setup();
  const { post, captureAndClaim, claimJob } = f;
  try {
    const port = (await f.server.listen()).port;
    // PP：propose + {memory, shared} + {memory, platform}，**没有 admin**。
    // 旧门禁对 tool 要 {memory, platform}（它有 ⇒ 放行），对 agent/plan/profile 要的
    // {memory, role} / {memory, private} 在 resolveRootsForScopes 里都是 0 个检索根、
    // 它也都没有 ⇒ 一律 403。按"写出来的可见性"算：tool 写 platform ⇒ 要 admin ⇒ 403；
    // agent(role)/plan(private)/profile(private) 只看服务端绑定的身份 ⇒ 200。
    const PP = { agent_id: "pilot-01", role_id: "ml1-layer-probe" };
    const registry = JSON.parse(await fs.readFile(f.registryPath, "utf8"));
    const pilot = registry.frameworks[0].agents.find((agent) => agent.agent_id === "pilot-01");
    pilot.roles.push({
      role_id: PP.role_id,
      scopes: [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "platform" }],
      actions: ["search", "get", "propose"],
      group_id: GROUP,
      user_id: USER,
    });
    await fs.writeFile(f.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const submitLayer = async (layer) => {
      const capture = await captureAndClaim(port, PP, { session: `ml1s-pp-${layer}` });
      await claimJob(port, capture.job.job_id, PP);
      return post(port, "/v1/refinement/jobs/submit", {
        job_id: capture.job.job_id,
        conclusions: [{ layer, id: `ml1s-pp-${layer}`, body: `层 ${layer} 的结论：可见性由既有的默认值规则决定（不新增判据）。`, evidence_refs: [capture.evidenceId] }],
      }, PP);
    };

    // 每个层一个子测试：修前它们各自红，失败点才看得见（不会被前一个断言挡住）。
    await t.test("tool：写出来是 platform 可见性 ⇒ 要 admin", async () => {
      const result = await submitLayer("tool");
      assert.equal(result.status, 403, `layer "tool" writes visibility "platform", which requires the admin action, got ${result.status} ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error.code, "WRITE_SCOPE_DENIED");
      assert.deepEqual(await fs.readdir(path.join(f.dataRoot, "tools-memory")).catch(() => []), [], "the refused tool conclusion must write nothing");
    });

    for (const [layer, expected] of [["agent", { container: "role", visibility: "role" }], ["plan", { container: "plan", visibility: "private" }], ["profile", { container: "long-term", visibility: "private" }]]) {
      await t.test(`${layer}：只按服务端绑定身份（${expected.container}/${expected.visibility}）`, async () => {
        const result = await submitLayer(layer);
        assert.equal(result.status, 200, `layer ${layer} must follow the same ruler as /v1/write, got ${result.status} ${JSON.stringify(result.body)}`);
        const written = result.body.receipt.writes[0];
        const relative = path.relative(f.dataRoot, written.path).split(path.sep).join("/");
        const onDisk = await f.frontmatterAt(relative);
        assert.equal(onDisk.container, expected.container, `layer ${layer} container, got ${JSON.stringify(onDisk.container)}`);
        assert.equal(onDisk.visibility, expected.visibility, `layer ${layer} visibility, got ${JSON.stringify(onDisk.visibility)}`);
      });
    }
  } finally {
    await f.close();
  }
});
test("ML1 放行口径②③：platform 可见性要 admin；项目层的项目作用域规则不被放宽", async () => {
  const f = await setup();
  const { post, dataRoot, captureAndClaim, claimJob, formalMemoryFiles, frontmatterAt } = f;
  try {
    const port = (await f.server.listen()).port;

    // ② document 的默认 visibility 是 platform ⇒ 写入口对"显式 platform"要 admin
    //    （WRITE-DENY-1 之后是 403 WRITE_SCOPE_DENIED + detail PLATFORM_REQUIRES_ADMIN，
    //     旧实现把它当成输入不合法回 400 BAD_REQUEST / WRITE_REJECTED）。
    const qCapture = await captureAndClaim(port, Q, { session: "ml1s-q-doc" });
    await claimJob(port, qCapture.job.job_id, Q);
    const explicitPlatform = await post(port, "/v1/write", {
      layer: "document",
      id: "ml1s-direct-platform",
      body: "显式 platform 的对照：写入口要求 admin。",
      visibility: "platform",
      evidence_refs: [qCapture.evidenceId],
    }, Q);
    assert.equal(explicitPlatform.status, 403, `an explicit platform write without admin must be refused by /v1/write, got ${explicitPlatform.status} ${JSON.stringify(explicitPlatform.body)}`);
    assert.equal(explicitPlatform.body.error.code, "WRITE_SCOPE_DENIED", `the refusal must be a write-scope denial, got ${JSON.stringify(explicitPlatform.body.error)}`);
    assert.equal(explicitPlatform.body.error.detail, "PLATFORM_REQUIRES_ADMIN", `the refusal must name the resulting visibility, got ${JSON.stringify(explicitPlatform.body.error)}`);

    const beforeDoc = await formalMemoryFiles();
    const docSubmit = await post(port, "/v1/refinement/jobs/submit", {
      job_id: qCapture.job.job_id,
      conclusions: [{ layer: "document", id: "ml1s-submit-doc", body: "document 层的默认可见性是 platform（所有人可读），没有 admin 的动作不该写出这种记忆。", evidence_refs: [qCapture.evidenceId] }],
    }, Q);
    assert.equal(docSubmit.status, 403, `a platform-visible conclusion must require the admin action, got ${docSubmit.status} ${JSON.stringify(docSubmit.body)}`);
    assert.equal(docSubmit.body.error.code, "WRITE_SCOPE_DENIED", `the refusal must be a write-scope denial, got ${JSON.stringify(docSubmit.body.error)}`);
    assert.deepEqual(await formalMemoryFiles(), beforeDoc, "a refused platform-visible conclusion must write nothing");
    assert.deepEqual(await fs.readdir(path.join(dataRoot, "evidence", "documents")).catch(() => []), [], "no document may be created by the refused conclusion");

    // 正对照：有 admin 动作的角色写 document ⇒ 200，落盘 container=knowledge / visibility=platform。
    const adminCapture = await captureAndClaim(port, ADMIN, { session: "ml1s-admin-doc" });
    await claimJob(port, adminCapture.job.job_id, ADMIN);
    const adminSubmit = await post(port, "/v1/refinement/jobs/submit", {
      job_id: adminCapture.job.job_id,
      conclusions: [{ layer: "document", id: "ml1s-admin-doc-ok", body: "admin 角色的 document 结论：platform 可见性由既有 admin 规则放行。", evidence_refs: [adminCapture.evidenceId] }],
    }, ADMIN);
    assert.equal(adminSubmit.status, 200, `an admin role must be able to write a platform-visible conclusion, got ${adminSubmit.status} ${JSON.stringify(adminSubmit.body)}`);
    const adminDoc = await frontmatterAt("evidence/documents/ml1s-admin-doc-ok.md");
    assert.equal(adminDoc.container, "knowledge", `document writes the knowledge container, got ${JSON.stringify(adminDoc.container)}`);
    assert.equal(adminDoc.visibility, "platform", `document writes platform visibility, got ${JSON.stringify(adminDoc.visibility)}`);
    assert.equal((await post(port, "/v1/get", { id: "ml1s-admin-doc-ok" }, PEER)).status, 200, "a platform-visible memory must be readable by another group member");

    // ③ 项目层结论仍然要求该项目的项目作用域（与捕获写入口同一规则；本次不放宽）。
    const projectCapture = await captureAndClaim(port, C, { session: "ml1s-project-job", workspace: WORKSPACE });
    assert.equal(projectCapture.job.target_layer, "project-state", "a workspace job targets the project layer");
    assert.equal(projectCapture.job.project, PROJECT);
    await claimJob(port, projectCapture.job.job_id, NO_PROJECT);
    const beforeProject = await formalMemoryFiles();
    const projectDenied = await post(port, "/v1/refinement/jobs/submit", {
      job_id: projectCapture.job.job_id,
      conclusions: [{ layer: "project-state", project: PROJECT, id: "ml1s-project-denied", body: "没有该项目作用域的主体不能写项目层。", evidence_refs: [projectCapture.evidenceId] }],
    }, NO_PROJECT);
    assert.equal(projectDenied.status, 403, `a role without the project scope must not write the project layer, got ${projectDenied.status} ${JSON.stringify(projectDenied.body)}`);
    assert.equal(projectDenied.body.error.code, "WRITE_SCOPE_DENIED");
    assert.deepEqual(await formalMemoryFiles(), beforeProject, "a refused project-layer conclusion must write nothing");

    const ownProjectCapture = await captureAndClaim(port, C, { session: "ml1s-project-own", workspace: WORKSPACE });
    await claimJob(port, ownProjectCapture.job.job_id, C);
    const projectAccepted = await post(port, "/v1/refinement/jobs/submit", {
      job_id: ownProjectCapture.job.job_id,
      conclusions: [{ layer: "project-state", project: PROJECT, id: "ml1s-project-ok", body: "持有该项目作用域的捕获者可以写项目层。", evidence_refs: [ownProjectCapture.evidenceId] }],
    }, C);
    assert.equal(projectAccepted.status, 200, `the project-scope holder must be able to write the project layer, got ${projectAccepted.status} ${JSON.stringify(projectAccepted.body)}`);
    assert.equal(projectAccepted.body.receipt.outcome, "written");
    const projectOnDisk = await frontmatterAt(`project-state/${PROJECT}/current-state.md`);
    assert.equal(projectOnDisk.visibility, "project", `project-state writes project visibility, got ${JSON.stringify(projectOnDisk.visibility)}`);
  } finally {
    await f.close();
  }
});
