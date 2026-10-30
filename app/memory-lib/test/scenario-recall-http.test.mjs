// SCENARIO-1 端到端：参考实现打**真实 HTTP 服务**（不是假 fetch）。
//
// 单元测试证明了"按正确的顺序发正确的请求"；这一层证明"这条链在真实入口上真的走得通"：
//   /v1/date/resolve → /v1/search（空 query 按天枚举 + keyset 翻页）→ 取全
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { recallScenario } from "../src/scenario-recall.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-10-12T04:00:00.000Z"; // 上海本地 2026-10-12（周一）12:00
const TZ = "Asia/Shanghai";

function conversation(id, capturedAt, body) {
  return ["---", `id: ${id}`, "type: conversation", `capturedAt: ${capturedAt}`, 'groupId: "group-sc"', 'userId: "user-sc"', "---", "", body].join("\n");
}

test("the scenario runs end to end over the real HTTP routes and takes the whole day", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scenario-recall-e2e-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversationRoot = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversationRoot, { recursive: true });

  // 上海本地 2026-10-10 = [10-09T16:00Z, 10-10T16:00Z)。放 9 条（与产品岗实测同量级），
  // 外加两个边界邻居，必须被排除在外。
  const inside = [
    "2026-10-09T16:00:00.000Z", // 本地 10-10 00:00:00.000
    "2026-10-09T16:30:00.000Z", // 本地 00:30
    "2026-10-09T22:00:00.000Z",
    "2026-10-10T00:00:00.000Z",
    "2026-10-10T02:00:00.000Z",
    "2026-10-10T04:00:00.000Z",
    "2026-10-10T06:00:00.000Z",
    "2026-10-10T12:00:00.000Z",
    "2026-10-10T15:59:59.999Z", // 本地 23:59:59.999
  ];
  for (const [index, capturedAt] of inside.entries()) {
    await fs.writeFile(path.join(conversationRoot, `day-${index}.md`), conversation(`day-${index}`, capturedAt, `第 ${index} 段对话，讲的是游戏玩法`), "utf8");
  }
  await fs.writeFile(path.join(conversationRoot, "outside-before.md"), conversation("outside-before", "2026-10-09T15:30:00.000Z", "前一天晚上"), "utf8");
  await fs.writeFile(path.join(conversationRoot, "outside-after.md"), conversation("outside-after", "2026-10-10T16:00:00.000Z", "第二天凌晨"), "utf8");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "group-sc";
  researcher.user_id = "user-sc";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const server = createLocalhostServer({
    registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
    indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: TZ,
    libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
  });

  try {
    const address = await server.listen();
    const credentials = { credential_ref: auth.credentialRef, secret: auth.authValue };
    const principal = { agent_id: "pilot-01", role_id: "researcher" };

    // ── 场景门正题：小页故意设成 2，逼出翻页 ──
    const answer = await recallScenario({ text: "10/10 我们聊了什么", now: NOW, timezone: TZ, baseUrl: `http://127.0.0.1:${address.port}`, credentials, principal, pageSize: 2 });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.kind, "answer");
    assert.equal(answer.calendarDate, "2026-10-10");
    assert.equal(answer.range.since, "2026-10-09T16:00:00.000Z");
    assert.equal(answer.range.untilExclusive, "2026-10-10T16:00:00.000Z");
    // ★ 取全断言：取回条数 == total_count
    assert.equal(answer.count, 9, `必须取回那天的全部 9 条，实际 ${answer.count}`);
    assert.equal(answer.totalCount, 9);
    assert.equal(answer.complete, true);
    assert.ok(answer.pages >= 5, `每页 2 条、共 9 条 ⇒ 至少要翻 5 页，实际 ${answer.pages}`);
    // 边界邻居必须在外
    assert.equal(answer.items.some((entry) => entry.path.endsWith("outside-before.md")), false);
    assert.equal(answer.items.some((entry) => entry.path.endsWith("outside-after.md")), false);
    // 素材只来自库
    assert.ok(answer.items.every((entry) => entry.capturedAt && typeof entry.excerpt === "string"));
    assert.equal(answer.modelCalls, 0);

    // ── 相对日 ──
    const yesterday = await recallScenario({ text: "昨天聊了什么", now: NOW, timezone: TZ, baseUrl: `http://127.0.0.1:${address.port}`, credentials, principal, pageSize: 10 });
    assert.equal(yesterday.kind, "answer");
    assert.equal(yesterday.calendarDate, "2026-10-11");
    assert.equal(yesterday.count, yesterday.totalCount, "相对日也要取全");

    // ── 区间（3 天） ──
    const threeDays = await recallScenario({ text: "最近三天聊了什么", now: NOW, timezone: TZ, baseUrl: `http://127.0.0.1:${address.port}`, credentials, principal, pageSize: 4 });
    assert.equal(threeDays.kind, "answer");
    assert.equal(threeDays.calendarDate, null, "区间不是某一天");
    assert.equal(threeDays.range.untilExclusive, "2026-10-12T16:00:00.000Z");
    assert.equal(threeDays.count, threeDays.totalCount, "区间也要取全");
    assert.ok(threeDays.count >= 9, "区间至少覆盖 10-10 的那 9 条");

    // ── 反例：没有时间范围 ⇒ 明确拒绝，且一条都不检索 ──
    const refused = await recallScenario({ text: "随便聊聊", now: NOW, timezone: TZ, baseUrl: `http://127.0.0.1:${address.port}`, credentials, principal });
    assert.equal(refused.ok, false);
    assert.equal(refused.kind, "no-time-range");
    assert.equal(refused.resolvedRange, undefined);
    assert.equal(refused.items, undefined, "拒绝时不许带任何检索结果");

    // ── 歧义：给候选、不合并、不先检索 ──
    const ambiguous = await recallScenario({ text: "10/11 聊了什么", now: NOW, timezone: TZ, locale: null, baseUrl: `http://127.0.0.1:${address.port}`, credentials, principal });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.kind, "ambiguous");
    assert.equal(ambiguous.candidates.length, 2);
    assert.equal(ambiguous.items, undefined);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
