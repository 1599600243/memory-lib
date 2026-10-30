import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function conversation(id, capturedAt, groupId = "group-m21", userId = "user-m21") {
  return [
    "---",
    `id: ${id}`,
    "type: conversation",
    `capturedAt: ${capturedAt}`,
    `groupId: ${groupId}`,
    `userId: ${userId}`,
    "---",
    "",
    `Timeline excerpt for ${id}`,
  ].join("\n");
}

// ⚠️ DAY-INTERVAL-1 修订：本用例原先**自相矛盾** —— 标题与断言注释说"本地日"，
// 但用的是裸 `since/until`，而那时裸日期按 **UTC 日**解释（`calendarTimezone` 根本不参与）。
// 它"通过"只是因为夹具恰好让"UTC 10-10 的 8 条"与注释里的说法凑上了：
//   - local-10-10-early(10-09T18:00Z) → 在上海是本地 10-10 02:00，本应属于 10-10；
//   - day-6(10-10T03:06Z)             → 在上海仍是本地 10-10 11:06，属于 10-10。
// 于是"UTC 日 10-10"的 8 条 与"本地日 10-10"的 9 条**并不相等**，用例只是在替旧的 UTC 语义背书。
//
// 统一之后裸日期走本地日，本用例改成**明确测一个自洽的本地日**：
//   本地(Asia/Shanghai) 2026-10-11 = [10-10T16:00Z, 10-11T16:00Z)，恰好含这 8 条。
// 并额外断言"本地 10-10""本地 10-09"各自把谁排除在外 —— 让"哪一天"这件事有判别力。
test("empty-query search enumerates a complete local day through paginated real HTTP", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-m21-a-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversationRoot = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversationRoot, { recursive: true });
  // 本地 10-11 0 点后：10-10T16:00Z 起
  await fs.writeFile(path.join(conversationRoot, "local-10-11-first.md"), conversation("local-10-11-first", "2026-10-10T16:00:00.000Z"), "utf8");
  for (let index = 0; index < 6; index += 1) {
    await fs.writeFile(path.join(conversationRoot, `day-${index}.md`), conversation(`day-${index}`, `2026-10-10T17:0${index}:00.000Z`), "utf8");
  }
  await fs.writeFile(path.join(conversationRoot, "local-10-11-last.md"), conversation("local-10-11-last", "2026-10-11T15:59:59.999Z"), "utf8");
  // 两侧邻居：前一日本地 23:30 与次日第一毫秒
  await fs.writeFile(path.join(conversationRoot, "prev-local-2330.md"), conversation("prev-local-2330", "2026-10-10T15:30:00.000Z"), "utf8");
  await fs.writeFile(path.join(conversationRoot, "next-local-0000.md"), conversation("next-local-0000", "2026-10-11T16:00:00.000Z"), "utf8");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "group-m21";
  researcher.user_id = "user-m21";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
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
    // 与 localhost-server 第 866 行同形状：agentId/roleId 由已验证身份注入。
    // 少传 agentId 会让 memory-lib 的 self-root 兜底失效，从而**静默**漏掉角色记忆
    // （见 day-membership-role-parity.test.mjs）——测试替身不该比生产更弱。
    libFactory: ({ scopes, agentId, roleId, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, roleId, principal, vectorLane: { probe: false } }),
  });
  try {
    const address = await server.listen();
    const authBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };
    // 时区显式给上海：本用例说的"本地日"就是上海本地日（DAY-INTERVAL-1 之后裸日期也按它解释）。
    async function searchDay(day, offset = 0) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody, since: day, until: day, calendarTimezone: "Asia/Shanghai", limit: 3, offset }) });
      return { status: response.status, body: await response.json() };
    }
    const first = await searchDay("2026-10-11");
    assert.equal(first.status, 200);
    // 本地 10-11 共 8 条：first + day-0..day-5 + last
    assert.equal(first.body.total_count, 8);
    assert.equal(first.body.results.length, 3);
    assert.equal(first.body.has_more, true);
    assert.equal(first.body.next_offset, 3);
    // 解析出的范围必须真的是**上海本地** 10-11（半开）。
    assert.equal(first.body.resolvedRange.since, "2026-10-10T16:00:00.000Z");
    assert.equal(first.body.resolvedRange.untilExclusive, "2026-10-11T16:00:00.000Z");
    assert.equal(first.body.resolvedRange.calendarTimezone, "Asia/Shanghai");
    const all = [...first.body.results];
    let offset = first.body.next_offset;
    while (offset !== null) {
      const page = await searchDay("2026-10-11", offset);
      assert.equal(page.status, 200);
      all.push(...page.body.results);
      offset = page.body.next_offset;
    }
    assert.equal(all.length, 8, "pagination must retrieve the complete local day");
    assert.ok(all.every((item) => item.path && item.updatedAt && item.excerpt));
    // 边界判别性：当天的第一毫秒与最后一毫秒在内，两侧邻居在外。
    assert.equal(all.some((item) => item.path.endsWith("local-10-11-first.md")), true, "本地 10-11 00:00:00.000 必须在内");
    assert.equal(all.some((item) => item.path.endsWith("local-10-11-last.md")), true, "本地 10-11 23:59:59.999 必须在内");
    assert.equal(all.some((item) => item.path.endsWith("prev-local-2330.md")), false, "前一日本地 23:30 必须在外");
    assert.equal(all.some((item) => item.path.endsWith("next-local-0000.md")), false, "次日第一毫秒必须在外（半开区间）");
    // "本地 10-10" 是另一个自洽的日：含前一日本地 23:30，不含本地 10-11 的任何一条。
    const previous = await searchDay("2026-10-10");
    assert.equal(previous.status, 200);
    assert.equal(previous.body.resolvedRange.since, "2026-10-09T16:00:00.000Z");
    assert.equal(previous.body.resolvedRange.untilExclusive, "2026-10-10T16:00:00.000Z");
    assert.equal(previous.body.results.some((item) => item.path.endsWith("prev-local-2330.md")), true, "本地 10-10 的 23:30 属于 10-10");
    assert.equal(previous.body.results.some((item) => item.path.endsWith("local-10-11-first.md")), false, "本地 10-11 第一条不属于 10-10");
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
