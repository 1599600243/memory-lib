// CALLSHAPE-1 —— 「契约表与实现不许漂移」护栏。
//
// 为什么需要它：`docs/SCENARIO-RECALL-CONTRACT.md` §5.1 的实测表曾经**没有写明身份**，
// 而那一行的数字同时取决于两件事：
//   ① **身份**（`role_id`）：`pilot-01/reader` 看不到属于 `researcher` 的角色记忆；
//   ② **装配**（`agentId`）：D4F1 self-root 靠它把 `curated/agents/<agent>` 追加进检索根。
// 实测（真实副本、生产同一套装配、HTTP 口径）：
//   researcher + agentId 在位 → 09-24 = 106 条 / 41,085 字符
//   reader      + agentId 在位 → 09-24 = 105 条 / 40,944 字符
//   researcher  + **漏传 agentId** → 09-24 = 105 条 / 40,944 字符   ← 旧表就是这么来的
//
// 所以本文件做两件事：
//   A. **读数护栏**：把文档里那张表**逐列**拿去和真实副本的实测比 —— 表改了而实现没改（或反之）就会红。
//   B. **装配护栏**：把 `agentId` 从装配里拿掉，必须红 —— 防止再出现"量数字的装配"与"生产的装配"不是同一套。
//
// 真实副本只读；副本不存在时**明说未运行**（宁可显式跳过，也不谎报通过）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { recallScenario } from "../src/scenario-recall.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.join(ROOT, "docs", "SCENARIO-RECALL-CONTRACT.md");
// 真实数据副本（照生产 autostart.cmd 布局）；**只读**。
const COPY = process.env.MEMORY_LIB_REALDATA_COPY ?? "D:\\MemoryLib\\sc2-realdata-copy";
const TZ = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const AGENT = "pilot-01";

// 文档表声明的身份 —— 表与护栏必须说同一件事。
const TABLE_PRINCIPAL = { agent_id: AGENT, role_id: "researcher" };

// ---------- 解析文档里的实测表 ----------
// 形如：| `2026-10-07` | **177** | 177 / 177 ✅ | 2 | **70,397** | **9** |
async function readDocumentedTable() {
  const text = await fs.readFile(DOC, "utf8");
  const rows = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const dayMatch = cells[1].match(/^`?(\d{4}-\d{2}-\d{2})`?$/u);
    if (!dayMatch) continue;
    const numbers = cells.map((cell) => {
      const m = cell.replaceAll("*", "").replaceAll(",", "").match(/^\d+$/u);
      return m ? Number(m[0]) : null;
    });
    // 列序：日 | 条数 | 取回/总数 | 页数 | excerpt 字符合计 | 块数
    rows.set(dayMatch[1], {
      total: numbers[2],
      pages: numbers[4],
      chars: numbers[5],
      chunks: numbers[6],
      raw: line.trim(),
    });
  }
  return rows;
}

// ---------- 用**生产同一套装配**在真实副本上量一天 ----------
async function measureWith(libFactory, day) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "callshape-guard-"));
  const dataRoot = path.join(COPY, "memory");
  const auth = await createTestAuth(ROOT, scratch);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  for (const role of registry.frameworks[0].agents.flatMap((agent) => agent.roles)) {
    role.group_id ??= "home-circle";
    role.user_id ??= "user-owner";
  }
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot: COPY,
    auditPath: path.join(scratch, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory,
    calendarTimezone: TZ,
  });
  try {
    const address = await server.listen();
    const result = await recallScenario({
      text: day, now: NOW, timezone: TZ,
      baseUrl: `http://127.0.0.1:${address.port}`,
      credentials: { credential_ref: auth.credentialRef, secret: auth.authValue },
      principal: { ...TABLE_PRINCIPAL },
      pageSize: 100, chunkChars: 8000,
    });
    return { total: result.totalCount, returned: result.count, chars: result.totalChars, chunks: result.chunks?.length ?? null, complete: result.complete };
  } finally {
    await server.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// 生产装配：src/server-wiring.mjs 的工厂（server.mjs 用的就是它）。
const measure = (day) => measureWith(
  createServerLibFactory({ dataRoot: path.join(COPY, "memory"), workspaceRoot: COPY, calendarTimezone: TZ, vectorLane: { probe: false } }),
  day,
);

// 反例装配：与生产唯一的差别就是把 agentId 从 libFactory 里拿掉。
// （server-wiring 之外的那些"装配差异"就是这样长出来的。）
const measureWithoutAgentId = (day) => measureWith(
  ({ scopes, roleId, principal, audit, calendarTimezone }) => createServerLibFactory({ dataRoot: path.join(COPY, "memory"), workspaceRoot: COPY, calendarTimezone, vectorLane: { probe: false } })({ scopes, roleId, principal, audit }),
  day,
);

async function copyAvailable() {
  try {
    await fs.access(path.join(COPY, "memory"));
    return true;
  } catch {
    return false;
  }
}

// C. 静态棘轮：文档数字的**生产装配**必须真的从 server-wiring 出来，而不是就地手写一份。
//    这条不跑数据，只读源码 —— 它挡的是"下一个人又在 server-wiring 之外拼一套装配"。
test("C. the server factory keeps forwarding the identity arguments production relies on", async () => {
  const source = await fs.readFile(path.join(ROOT, "src", "server-wiring.mjs"), "utf8");
  const factory = source.slice(source.indexOf("export function createServerLibFactory"));
  // 这三个参数各自承担一条已证的语义，少任何一个都会让"量数字"与"跑生产"分叉：
  //   agentId  → D4F1 self-root（本单 09-24 那个 105/106 就是它）
  //   scopes   → 受限身份的根集合
  //   principal→ 组/用户/角色准入
  for (const arg of ["agentId", "scopes", "principal"]) {
    assert.match(
      factory,
      new RegExp(`[{,\\s]${arg}[,\\s}]`, "u"),
      `server-wiring 的 libFactory 必须保留 ${arg} 参数 —— 少了它，量数字的装配就与生产不同`,
    );
  }
  // 而且它必须真的被交给 createMemoryLib（不能只是解构出来扔掉）。
  assert.match(factory, /createMemoryLib\(\{[\s\S]*?\b(agentId|scopes|principal)\b/u, "解构出来的身份参数必须传给 createMemoryLib");
  // 生产入口必须用这个工厂，而不是自己拼一个。
  const serverSource = await fs.readFile(path.join(ROOT, "server.mjs"), "utf8");
  assert.match(serverSource, /createServerLibFactory\(/u, "server.mjs 必须用 server-wiring 的工厂");
});

test("A. the documented real-data table matches a real measurement, column by column", async (t) => {
  if (!(await copyAvailable())) {
    t.skip(`真实数据副本不存在（${COPY}）——本护栏未运行，不许当成通过`);
    return;
  }
  const documented = await readDocumentedTable();
  assert.ok(documented.size >= 3, `没有从文档里解析出实测表行数（拿到 ${documented.size}），表格格式可能变了`);

  for (const day of ["2026-10-07", "2026-10-05", "2026-09-24"]) {
    const row = documented.get(day);
    assert.ok(row, `文档表里缺少 ${day} 这一行`);
    const measured = await measure(day);
    assert.equal(measured.complete, true, `${day}: 必须取全`);
    assert.equal(row.total, measured.total, `${day}: 文档写 ${row.total} 条，实测 ${measured.total} 条`);
    assert.equal(row.chars, measured.chars, `${day}: 文档写 ${row.chars} 字符，实测 ${measured.chars} 字符`);
    assert.equal(row.chunks, measured.chunks, `${day}: 文档写 ${row.chunks} 块，实测 ${measured.chunks} 块`);
  }
});

test("B. dropping agentId from the measurement wiring must turn the table guard red", async (t) => {
  if (!(await copyAvailable())) {
    t.skip(`真实数据副本不存在（${COPY}）——本护栏未运行，不许当成通过`);
    return;
  }
  // 这一条证明 A 不只是"把表抄一遍"：装配一弱，09-24 的读数就掉。
  const production = await measure("2026-09-24");
  const weakened = await measureWithoutAgentId("2026-09-24");
  assert.equal(production.total, 106, "生产装配下 09-24 = 106");
  assert.equal(production.chars, 41085, "生产装配下 09-24 = 41,085 字符");
  assert.equal(weakened.total, 105, "**漏传 agentId** 时必须掉到 105 —— 这正是旧表那个数");
  assert.notEqual(production.total, weakened.total, "生产装配与漏参装配必须给出不同读数（否则本护栏没有判别力）");
});
