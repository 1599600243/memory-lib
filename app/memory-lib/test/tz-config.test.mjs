// TZ-CONFIG-1 —— 「部署默认时区」必须可配置，且**未配置时语义不变**。
//
// 背景（DEPLOY-13 发后发现）：不带时区的裸 `since/until`，服务端默认时区 = UTC。
// 而 MCP 工具 `memory_search` 的描述里写着"`calendarTimezone` 省略则用**部署默认时区**"
// ⇒ 契约承诺了、实现却没有。用户裁决：**恢复旧行为**（生产设 Asia/Shanghai）。
//
// 本文件钉住三件事：
//   ① 配置了 Asia/Shanghai ⇒ 省略时区的裸 since/until == 显式 calendarDate+Asia/Shanghai（集合与顺序都一致）
//   ② **没配置 ⇒ 仍然是 UTC**（不许偷偷改成机器本地时区，那又是一次静默行为变化）
//   ③ 配置值真的传到三处生效点：/v1/search 默认、/v1/date/resolve 默认、捕获物化 calendarDate
//
// 红先行：本文件在加 `calendarTimezone` 选项之前必须红（配置被忽略 ⇒ 仍按 UTC）。
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
const TZ = "Asia/Shanghai";
// ⚠️ 刻意选一个**能区分 UTC 日与上海日**的日期：
//   上海本地 2026-10-07 = [2026-10-06T16:00Z, 2026-10-07T16:00Z)
//   UTC   2026-10-07    = [2026-10-07T00:00Z, 2026-10-08T00:00Z)
//   两者只差 16:00Z–24:00Z 这一段，所以区间 [16:30Z, 17:30Z) 的条目**只属于上海 10-07**。
const DAY = "2026-10-07";

function conversation(id, capturedAt, groupId = "home-circle", userId = "user-owner") {
  return [
    "---",
    `id: ${id}`,
    "type: conversation",
    `capturedAt: ${capturedAt}`,
    `groupId: ${groupId}`,
    `userId: ${userId}`,
    "---",
    "",
    `TZ-CONFIG-1 fixture: ${id}`,
  ].join("\n");
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-tzcfg-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const conversations = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(conversations, { recursive: true });
  // 只属于「上海 10-07」的两条（UTC 是 10-06）
  await fs.writeFile(path.join(conversations, "sh-only-a.md"), conversation("sh-only-a", "2026-10-06T16:30:00.000Z"), "utf8");
  await fs.writeFile(path.join(conversations, "sh-only-b.md"), conversation("sh-only-b", "2026-10-06T17:30:00.000Z"), "utf8");
  // 两个口径都算 10-07 的一条（UTC 也是 10-07）
  await fs.writeFile(path.join(conversations, "both.md"), conversation("both", "2026-10-07T09:00:00.000Z"), "utf8");

  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const researcher = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "home-circle";
  researcher.user_id = "user-owner";
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return { tmp, dataRoot, workspaceRoot, auth };
}

// **与生产同一个工厂**（server.mjs 用的也是 src/server-wiring.mjs 这一个）。
// 不再自己拼 `({ scopes, principal }) => createMemoryLib(...)` —— 那种写法一旦漏参
// （例如 agentId），测试替身就与生产不同，量出来的结论不算数（CALLSHAPE-1）。
function factory({ dataRoot, workspaceRoot }) {
  return createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
}

async function withServer({ calendarTimezone = undefined }, fn) {
  const { tmp, dataRoot, workspaceRoot, auth } = await fixture();
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
    libFactory: factory({ dataRoot, workspaceRoot }),
    ...(calendarTimezone === undefined ? {} : { calendarTimezone }),
  });
  try {
    const address = await server.listen();
    const authBody = { credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" } };
    const post = async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...authBody, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };
    // 逐页取全（用 nextCursor），返回 id 列表与总页数
    const enumerate = async (extra) => {
      const ids = [];
      let cursor = null;
      let resolvedRange = null;
      let total = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await post("/v1/search", { query: "", limit: 2, ...extra, ...(cursor ? { cursor } : {}) });
        assert.equal(page.status, 200, JSON.stringify(page.body));
        total = page.body.total_count;
        resolvedRange ??= page.body.resolvedRange;
        ids.push(...(page.body.results ?? []).map((item) => item.id));
        if (!page.body.nextCursor) break;
        cursor = page.body.nextCursor;
      }
      return { ids, total, resolvedRange };
    };
    return await fn({ post, enumerate, dataRoot, tmp });
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test("① configured deployment timezone: bare since/until equals explicit calendarDate+timezone", async () => {
  await withServer({ calendarTimezone: TZ }, async ({ enumerate }) => {
    // 裸 since/until —— **不传 calendarTimezone**；默认应来自部署配置
    const bare = await enumerate({ since: DAY, until: DAY });
    // 显式等价写法
    const explicit = await enumerate({ calendarDate: DAY, calendarTimezone: TZ });

    assert.deepEqual(bare.ids, explicit.ids, "集合与顺序都必须一致");
    assert.equal(bare.total, explicit.total);
    assert.equal(bare.resolvedRange.calendarTimezone, TZ, "裸查询必须按部署默认时区解析");
    assert.equal(bare.resolvedRange.since, "2026-10-06T16:00:00.000Z");
    assert.equal(bare.resolvedRange.untilExclusive, "2026-10-07T16:00:00.000Z");
    // 判别性：那两条只属于上海 10-07 的条目必须在内（UTC 口径下会掉出去）
    assert.equal(bare.ids.includes("sh-only-a"), true, "上海 10-07 00:30 必须属于这一天");
    assert.equal(bare.ids.includes("sh-only-b"), true, "上海 10-07 01:30 必须属于这一天");
    assert.equal(bare.total, 3);
  });
});

test("② unconfigured deployment timezone: behaviour is still UTC (no silent change)", async () => {
  await withServer({}, async ({ enumerate }) => {
    const bare = await enumerate({ since: DAY, until: DAY });
    assert.equal(bare.resolvedRange.calendarTimezone, "UTC", "未配置时必须是 UTC，不许跟机器本地时区走");
    assert.equal(bare.total, 1, "UTC 口径下只有 both 这一条落入 10-07");
    assert.equal(bare.ids.includes("both"), true);
    assert.equal(bare.ids.includes("sh-only-a"), false, "UTC 口径下 10-06T16:30Z 不属于 10-07");
    assert.equal(bare.ids.includes("sh-only-b"), false);
    // 显式传时区仍然能覆盖默认
    const explicit = await enumerate({ since: DAY, until: DAY, calendarTimezone: TZ });
    assert.equal(explicit.total, 3, "显式 calendarTimezone 必须仍然优先于部署默认");
  });
});

test("③ configured timezone reaches the /v1/date/resolve default", async () => {
  await withServer({ calendarTimezone: TZ }, async ({ post }) => {
    // 省略 timezone：默认应来自部署配置，而不是 UTC
    const omitted = await post("/v1/date/resolve", { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z" });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
    assert.equal(omitted.body.timezone, TZ, "省略 timezone 时必须回显部署默认时区");
    assert.equal(omitted.body.range.since, "2026-10-09T16:00:00.000Z", "必须是上海本地日，不是 UTC 日");
    assert.equal(omitted.body.range.untilExclusive, "2026-10-10T16:00:00.000Z");

    // 显式 timezone 仍然优先
    const explicit = await post("/v1/date/resolve", { text: "10/10 我们聊了什么", now: "2026-10-10T01:00:00.000Z", timezone: "UTC" });
    assert.equal(explicit.body.timezone, "UTC");
    assert.equal(explicit.body.range.since, "2026-10-10T00:00:00.000Z");
  });
});

test("④ configured timezone reaches capture materialisation (calendarDate/calendarTimezone)", async () => {
  await withServer({ calendarTimezone: TZ }, async ({ post }) => {
    const captured = await post("/v1/conversations/capture", {
      source: "tz-config-1",
      conversation_id: "tz-config-1-conv",
      event_id: "tz-config-1-event",
      messages: [{ role: "user", content: "TZ-CONFIG-1 物化时区检查" }],
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));

    // 捕获路径**不允许调用方指定 capturedAt**（allowedFields 里没有 now/capturedAt），
    // 所以这里不能钉一个固定日期；但可以做到**完全无竞态**地钉住"配置值传到了"这件事：
    //   ① 返回值里的 calendarTimezone == 部署默认时区（决定性）
    //   ② 落盘文件的 frontmatter 里 calendarTimezone == 部署默认时区（决定性）
    //   ③ calendarDate 必须与**同一个被物化的 capturedAt 在配置时区下**的推导结果一致
    //      （用 capturedAt 反推，而不是用"现在"，所以跨零点也不会 flaky）
    assert.equal(captured.body.calendarTimezone, TZ, "物化的 calendarTimezone 必须是部署默认时区");
    assert.equal(captured.body.capturedAt, captured.body.createdAt);

    const text = await fs.readFile(captured.body.evidencePath, "utf8");
    assert.match(text, /calendarTimezone: "Asia\/Shanghai"/u, "落盘 frontmatter 的 calendarTimezone 必须是部署默认时区");
    // 反向断言：不许退回 UTC —— 否则说明 localhost-server 第 143 行的
    // `options.calendarTimezone ?? "UTC"` 没吃到部署配置。
    assert.doesNotMatch(text, /calendarTimezone: "UTC"/u, "物化时区不许退回 UTC");

    const hour12 = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(captured.body.capturedAt));
    const part = (type) => hour12.find((item) => item.type === type).value;
    assert.equal(captured.body.calendarDate, `${part("year")}-${part("month")}-${part("day")}`, "calendarDate 必须按部署默认时区推导");
  });
});

// ⑤ 的补充：解析器本身（快、无子进程、无环境依赖）。
// 它钉住"没配置 ⇒ null（= 代码里的 UTC 默认）"，防止有人把默认改成机器本地时区。
test("⑥ the config parser: flag > env > unset, and every unusable value fails closed", async () => {
  const { resolveCalendarTimezoneConfig, describeCalendarTimezone, ServerConfigError } = await import("../src/server-config.mjs");
  const absent = { present: false, value: null };
  const set = (value) => ({ present: true, value });

  // 未配置 ⇒ null（**不是**"机器本地时区"）——服务端据此继续用 UTC
  assert.equal(resolveCalendarTimezoneConfig({ flag: absent, env: null }), null, "未配置必须是 null");
  assert.equal(resolveCalendarTimezoneConfig({ flag: absent, env: "" }), null, "空字符串等同未配置");
  assert.match(describeCalendarTimezone(null), /UTC/u, "未配置的日志必须明确写 UTC");

  // 显式 flag
  assert.equal(resolveCalendarTimezoneConfig({ flag: set("Asia/Shanghai"), env: null }), "Asia/Shanghai");
  assert.equal(resolveCalendarTimezoneConfig({ flag: set("  Asia/Shanghai  "), env: null }), "Asia/Shanghai", "两侧空白应被裁掉");

  // 环境变量（与 flag 等效）
  assert.equal(resolveCalendarTimezoneConfig({ flag: absent, env: "Asia/Shanghai" }), "Asia/Shanghai");
  // flag 优先于环境变量
  assert.equal(resolveCalendarTimezoneConfig({ flag: set("UTC"), env: "Asia/Shanghai" }), "UTC", "flag 必须优先");

  // 非法值一律 fail closed，绝不退回 UTC
  for (const bad of ["Not/AZone", "China Standard Time", "Mars/Olympus"]) {
    assert.throws(
      () => resolveCalendarTimezoneConfig({ flag: set(bad), env: null }),
      (error) => {
        assert.ok(error instanceof ServerConfigError, "必须以 ServerConfigError 失败");
        assert.match(error.message, new RegExp(bad.replace(/[/\\^$*+?.()|[\]{}]/gu, "\\$&"), "u"), "错误信息必须含非法值本身");
        return true;
      },
      `非法时区 ${bad} 必须抛错`,
    );
  }
  assert.throws(() => resolveCalendarTimezoneConfig({ flag: set(""), env: null }), ServerConfigError, "空值必须抛错");
  assert.throws(() => resolveCalendarTimezoneConfig({ flag: { present: true, value: null }, env: null }), ServerConfigError, "缺值必须抛错");
});

//
// 关键：这条用**完整可用的配置**跑，只把时区换成非法值。
// 这样"非 0 退出"就只可能来自时区校验本身 —— 修复前 server.mjs 把未知 flag
// 静默忽略、照常启动（实测：打印 "core listening" 后被超时杀掉），于是本用例红。
//
// ⚠️ 判据必须**严格**：被超时杀掉时 status 是 1（Windows）或 null（有 signal 的平台），
//    所以单看 `status !== 0` 会**假通过**。这里用"耗时远小于超时"+"退出码非 0"双重约束。
test("⑤ invalid --calendar-timezone fails startup even with an otherwise valid config", async () => {
  const { spawnSync } = await import("node:child_process");
  const token = await fixture();
  const { tmp, dataRoot, workspaceRoot, auth } = token;
  try {
    const base = [
      "--secret-store", "file",
      "--secrets-dir", auth.secretStore.dir,
      "--data-root", dataRoot,
      "--workspace-root", workspaceRoot,
      "--registry", auth.registryPath,
      "--audit", path.join(tmp, "audit.jsonl"),
      "--port", "0",
      "--disable-index-refresh",
    ];
    // 直接 spawn（stdio 继承），不用 `cmd /c` + 重定向 —— 那套引号规则在这个 shell 下不可靠。
    // 判据只认**退出码**：非法配置必须立刻自己退出。
    const runCli = (extra) => spawnSync(process.execPath, [path.join(ROOT, "server.mjs"), ...base, ...extra], { cwd: ROOT, stdio: "inherit", timeout: 15_000 });

    const probe = spawnSync(process.execPath, ["-e", "process.exit(3)"], { stdio: "inherit" });
    if (probe.status === null) {
      console.error("SKIPPED: cannot execute subprocess in this environment -> CLI startup check did NOT run");
      return;
    }
    assert.equal(probe.status, 3, "环境自检：必须能拿到子进程退出码");

    // 配置本身是**完整可用**的（手动实测：换合法时区即可 "core listening"），
    // 所以下面的失败只可能来自时区校验。
    // ⚠️ 判据必须严格：被超时杀掉时 status 是 1（Windows），单看 `!== 0` 会假通过。
    //    这里额外要求"**没有**被超时杀掉"（signal 为空且 status ≠ 1-from-kill 无法区分，
    //    故以"耗时远小于超时"+"退出码非 0"双重约束）。
    for (const value of ["Not/AZone", "China Standard Time"]) {
      const started = Date.now();
      const result = runCli(["--calendar-timezone", value]);
      const elapsed = Date.now() - started;
      assert.notEqual(result.status, 0, `非法时区 ${JSON.stringify(value)} 必须以非 0 退出码失败`);
      assert.ok(elapsed < 10_000, `非法时区 ${JSON.stringify(value)} 必须**立刻**失败而不是跑满超时（实际 ${elapsed}ms）`);
    }

    const missing = runCli(["--calendar-timezone"]);
    assert.notEqual(missing.status, 0, "flag 给了但没给值属于配置错误，必须失败");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
