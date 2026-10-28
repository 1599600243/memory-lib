// ATOMICWRITE-1 缺陷二：**输入校验类错误不许以 500 出现**。
//
// 复核实测：`POST /v1/search {calendarDate:"2026-13-45", calendarTimezone:"Asia/Shanghai"}`
// ⇒ `500 INTERNAL`。那是"抛异常"而不是"校验输入"：污染监控、误导调用方
// （调用方会以为服务端坏了并重试，而不是修自己的参数）。
//
// 这批测试先把**每个非法输入各自的期望状态码**固定住，再修实现。
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

test("invalid input is reported as a client error (4xx), never as 500 INTERNAL", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-input-4xx-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversationRoot = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversationRoot, { recursive: true });
  await fs.writeFile(path.join(conversationRoot, "a.md"), ["---", "id: a", "type: conversation", "capturedAt: 2026-10-10T01:00:00.000Z", 'groupId: "g"', 'userId: "u"', "---", "", "body"].join("\n"), "utf8");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "g";
  researcher.user_id = "u";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const server = createLocalhostServer({
    registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
    indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: "Asia/Shanghai",
    libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
  });

  try {
    const address = await server.listen();
    const authBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };
    async function post(route, body) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...authBody, ...body }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    // 单子点名的三个非法 calendarDate，外加跨时区与其它入口的非法输入。
    // 这两组必须回 4xx：**解析得出、但值非法** ⇒ 明确的参数错误。
    const mustBe4xx = [
      { label: "calendarDate 月份/日都越界", route: "/v1/search", body: { query: "", calendarDate: "2026-13-45", calendarTimezone: "Asia/Shanghai" } },
      { label: "calendarDate 2 月 30 日", route: "/v1/search", body: { query: "", calendarDate: "2026-02-30", calendarTimezone: "Asia/Shanghai" } },
      { label: "calendarDate 带时刻后缀", route: "/v1/search", body: { query: "", calendarDate: "2026-10-10T99", calendarTimezone: "Asia/Shanghai" } },
      { label: "calendarDate 形状不对", route: "/v1/search", body: { query: "", calendarDate: "10/10", calendarTimezone: "Asia/Shanghai" } },
      { label: "calendarTimezone 非法", route: "/v1/search", body: { query: "", calendarDate: "2026-10-10", calendarTimezone: "Not/AZone" } },
    ];

    // 这一组是**既有宽松行为**（时间/游标解析不出来就当没给），本单**不改**它 ——
    // 单子只点名 calendarDate。但它们的真实状态码必须被记录并写进报告，
    // 而且底线是"不许 500"。
    const toleratedStatusQuo = [
      { label: "since/until 无法解析（被忽略）", route: "/v1/search", body: { query: "", since: "not-a-time", until: "also-not" } },
      { label: "cursor 无法解码（当第一页）", route: "/v1/search", body: { query: "", calendarDate: "2026-10-10", cursor: "!!!not-base64-json!!!" } },
      { label: "cursor 能解码但形状不对（当第一页）", route: "/v1/search", body: { query: "", calendarDate: "2026-10-10", cursor: Buffer.from('{"a":1}').toString("base64url") } },
      { label: "offset 为负（被夹到 0）", route: "/v1/search", body: { query: "", calendarDate: "2026-10-10", offset: -5 } },
      { label: "limit 超大（被夹到 100）", route: "/v1/search", body: { query: "", calendarDate: "2026-10-10", limit: 99999 } },
    ];

    const observed = [];
    for (const item of mustBe4xx) {
      const response = await post(item.route, item.body);
      observed.push({ group: "must-be-4xx", label: item.label, status: response.status, code: response.body?.error?.code ?? null });
      assert.notEqual(response.status, 500, `${item.label}: input validation must not surface as 500 INTERNAL`);
      assert.ok(response.status >= 400 && response.status < 500, `${item.label}: expected a 4xx client error, got ${response.status}`);
    }
    // 判别性：非法 calendarDate 必须给得出一个明确的错误码（不是空的 INTERNAL）。
    for (const entry of observed) {
      assert.ok(entry.code && entry.code !== "INTERNAL", `${entry.label}: expected an explicit input error code, got ${entry.code}`);
    }

    const relaxed = [];
    for (const item of toleratedStatusQuo) {
      const response = await post(item.route, item.body);
      relaxed.push({ group: "tolerated-status-quo", label: item.label, status: response.status, code: response.body?.error?.code ?? null });
      // 底线：即便"容忍"，也不许变成 500。
      assert.notEqual(response.status, 500, `${item.label}: must not surface as 500 INTERNAL even when tolerated`);
      assert.equal(response.status, 200, `${item.label}: recorded status quo is 200 (value ignored / clamped); if this changed, update the report`);
    }
    // 把两组的真实读数打印出来，便于直接抄进报告。
    for (const row of [...observed, ...relaxed]) {
      process.stdout.write(`  [${row.group}] ${String(row.status).padEnd(4)} ${String(row.code ?? "-").padEnd(26)} ${row.label}\n`);
    }
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
