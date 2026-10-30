#!/usr/bin/env node
// SCENARIO-1 —— 「随口问」场景门演示（**一条命令**，零模型，只读）。
//
// 默认跑四个场景：
//   ① 10/10 我们聊了什么   —— 场景门正题（默认输入）
//   ② 昨天聊了什么         —— 相对日
//   ③ 最近三天聊了什么     —— 区间（3 天）
//   ④ 随便聊聊             —— **明确拒绝**（没有时间范围，不许瞎猜）
//
// 它做的事就是产品第一判据那一段：把用户原话接上平台，并把那天**全部**取回来。
//
// 硬要求（都体现在输出里）：
//   · **零模型**：本脚本不 import 任何模型客户端；输出里的每一行摘要都来自库里的 excerpt。
//   · **取全断言**：打印「取回条数 == total_count」，对不上就明确标 INCOMPLETE。
//   · **只读**：只调 /v1/date/resolve 与 /v1/search（空 query 的按时间枚举），不发任何写请求。
//
// 用法：
//   node scripts/scenario-recall.mjs --base-url http://127.0.0.1:8787 --credential-ref <ref> --secret-file <path>
//   node scripts/scenario-recall.mjs --text "10/10 我们聊了什么" --now 2026-10-15T08:00:00.000Z
//
// 生产只读示例（**不写生产**）：
//   node scripts/scenario-recall.mjs --base-url http://127.0.0.1:8787 \
//        --credential-ref memory-lib/<你的> --secret-file D:\MemoryLib\data\runtime\secrets\<file>
import fs from "node:fs/promises";
import { recallScenario } from "../src/scenario-recall.mjs";

// 同时接受 `--name=value` 与 `--name value` 两种写法。
// 只认前一种是**实测踩到的坑**：写成 `--base-url http://…` 会被**静默忽略**，
// 于是脚本默默打到了默认的 8787，而输出看起来"跑过了"。参数解析出错必须能被发现。
function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const withEquals = argv.find((item) => item.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return fallback;
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const BASE_URL = arg("base-url", process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787");
const NOW = arg("now", new Date().toISOString());
const TIMEZONE = arg("timezone", "Asia/Shanghai");
const CREDENTIAL_REF = arg("credential-ref", process.env.MEMORY_LIB_CRED_REF ?? null);
const SECRET_FILE = arg("secret-file", null);
const PRINCIPAL_AGENT = arg("agent", "pilot-01");
const PRINCIPAL_ROLE = arg("role", "reader"); // 只读角色：只想读，不要写
const PAGE_SIZE = Number(arg("page-size", "100")); // 服务端上限 100：见报告 §"为什么默认 100"

const secret = SECRET_FILE ? (await fs.readFile(SECRET_FILE, "utf8")).replace(/\r?\n$/u, "") : arg("secret", process.env.MEMORY_LIB_SECRET ?? null);
const credentials = CREDENTIAL_REF && secret ? { credential_ref: CREDENTIAL_REF, secret } : {};
const principal = CREDENTIAL_REF ? { agent_id: PRINCIPAL_AGENT, role_id: PRINCIPAL_ROLE } : null;

const SCENARIOS = flag("only-text") || arg("text") ? [{ label: "指定输入", text: arg("text") }] : [
  { label: "① 场景门正题", text: "10/10 我们聊了什么" },
  { label: "② 相对日", text: "昨天聊了什么" },
  { label: "③ 区间（3 天）", text: "最近三天聊了什么" },
  { label: "④ 反例：没有时间范围", text: "随便聊聊" },
];

const results = [];
for (const scenario of SCENARIOS) {
  const result = await recallScenario({
    text: scenario.text,
    now: NOW,
    timezone: TIMEZONE,
    baseUrl: BASE_URL,
    credentials,
    principal,
    pageSize: PAGE_SIZE,
    // --verbose：把每次请求的**原始**状态码与响应体打出来，便于排查（排查期间不要猜）
    ...(flag("verbose") ? { onRequest: (info) => console.error(`[verbose] ${info.route} -> HTTP ${info.status} ${JSON.stringify(info.payload).slice(0, 300)}`) } : {}),
  });
  results.push({ label: scenario.label, result });
}

// ── 人类可读输出（素材，不是生成的话） ──
const lines = [];
lines.push(`场景门演示 · base=${BASE_URL} · now=${NOW} · tz=${TIMEZONE} · 每页=${PAGE_SIZE}`);
lines.push(`零模型：本脚本不调用任何模型；下面每一行摘要都来自库里的 excerpt。`);
lines.push("");
for (const { label, result } of results) {
  lines.push(`── ${label}：「${result.text}」`);
  if (result.kind === "answer") {
    const day = result.calendarDate ?? `${result.range.since} .. ${result.range.untilExclusive}`;
    lines.push(`   解析：${day}${result.yearInferred ? "（年份由 now 补出）" : ""}`);
    lines.push(`   范围：[${result.range.since}, ${result.range.untilExclusive})  半开`);
    lines.push(`   取全：取回 ${result.count} 条 / total_count ${result.totalCount} / 翻了 ${result.pages} 页 ⇒ ${result.complete ? "✅ 取全" : "⚠️ INCOMPLETE"}`);
    if (result.notice) lines.push(`   ⚠️ ${result.notice}`);
    for (const [index, entry] of result.items.slice(0, 5).entries()) {
      // 只做展示用的前导整理（去掉正文开头那行 `# 原始对话记录`），**摘要文本本身是库里的，原样**。
      const text = String(entry.excerpt).replace(/^\s*#\s*原始对话记录\s*/u, "").replace(/\s+/gu, " ").trim();
      lines.push(`     ${index + 1}. ${entry.capturedAt}  ${text.slice(0, 90)}`);
    }
    if (result.items.length > 5) lines.push(`     …（其余 ${result.items.length - 5} 条同理，见 --json 输出）`);
  } else if (result.kind === "ambiguous") {
    lines.push(`   ⛔ 歧义：${result.message}`);
    for (const candidate of result.candidates) lines.push(`     候选：${candidate.calendarDate}  （${candidate.rationale ?? ""}）`);
    lines.push(`   ${result.notice}`);
  } else if (result.kind === "no-time-range") {
    lines.push(`   ⛔ 拒绝：这句话里没有时间范围 —— **没有检索任何内容**（也没有瞎猜一个日期）`);
  } else {
    lines.push(`   ⛔ 失败（${result.reason}）：${result.message}`);
  }
  lines.push("");
}

// ── 取全断言（场景门的硬判据） ──
const asserts = [];
for (const { label, result } of results) {
  if (result.kind !== "answer") {
    // 不回答的场景也必须有**预期**的分类：只有 no-time-range / ambiguous 是"按设计拒绝"。
    // `error`（含鉴权失败、服务端故障）**不算通过** —— 否则"什么都跑不通"会被打印成
    // "全部场景符合预期"（这正是实测踩到的第二个坑）。
    const expectedRefusal = result.kind === "no-time-range" || result.kind === "ambiguous";
    asserts.push({ label, kind: result.kind, assertion: expectedRefusal ? "PASS（按设计拒绝）" : "FAIL" });
    continue;
  }
  asserts.push({
    label,
    kind: "answer",
    returned: result.count,
    total_count: result.totalCount,
    pages: result.pages,
    complete: result.complete,
    assertion: result.count === result.totalCount && result.complete ? "PASS（取回条数 == total_count）" : "FAIL",
  });
}
lines.push("── 取全断言");
for (const row of asserts) {
  lines.push(`   ${row.assertion.padEnd(30)} ${row.label}${row.kind === "answer" ? `  取回 ${row.returned} / total ${row.total_count}` : ""}`);
}

const failed = asserts.filter((row) => row.assertion === "FAIL");
lines.push("");
lines.push(failed.length === 0 ? "结论：全部场景符合预期。" : `结论：${failed.length} 个场景未通过（见上）。`);

console.log(lines.join("\n"));
if (flag("json")) console.log(`\n--- JSON ---\n${JSON.stringify(results, null, 2)}`);
process.exitCode = failed.length === 0 ? 0 : 1;
