#!/usr/bin/env node
// show-turns.mjs —— 看她"这一轮到底看到了什么"
//
// 数据来源：logs/napcat-turns/*.json（适配器每轮落一份上下文快照，不含密钥）
//
// 用法：
//   node scripts/show-turns.mjs             # 列最近 10 轮
//   node scripts/show-turns.mjs --last      # 打印最近一轮的完整上下文
//   node scripts/show-turns.mjs --last 3    # 最近 3 轮
//   node scripts/show-turns.mjs --id 2026-10-30T  # 按时间前缀筛选

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const DIR = "D:/MemoryLib/logs/napcat-turns";
const args = process.argv.slice(2);
const lastFlag = args.indexOf("--last");
const idFlag = args.indexOf("--id");
const showLast = lastFlag >= 0;
const lastN = lastFlag >= 0 ? Number(args[lastFlag + 1] ?? 1) || 1 : 0;
const idFilter = idFlag >= 0 ? String(args[idFlag + 1] ?? "") : "";

if (!existsSync(DIR)) {
  console.log(`还没有快照目录：${DIR}\n（她回复过一轮之后就会有）`);
  process.exit(0);
}

let files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
if (idFilter) files = files.filter((f) => f.includes(idFilter));

if (!files.length) {
  console.log("没有匹配的快照。");
  process.exit(0);
}

function load(f) {
  return JSON.parse(readFileSync(path.join(DIR, f), "utf8"));
}

if (!showLast) {
  console.log(`最近 ${Math.min(10, files.length)} 轮（共 ${files.length}）：\n`);
  for (const f of files.slice(-10)) {
    const t = load(f);
    const answer = String(t.answer ?? "").replace(/\s+/g, " ").slice(0, 40);
    console.log(
      `  ${t.at.slice(0, 19).replace("T", " ")}  ${String(t.kind).padEnd(9)} ${String(t.scope).padEnd(6)}`
      + `  system=${t.systemChars}字 记忆=${t.memoryChars}字  ${answer ? "答：" + answer : "（无回复）"}`,
    );
  }
  console.log("\n看某一轮全文：node scripts/show-turns.mjs --last 1");
  process.exit(0);
}

for (const f of files.slice(-lastN)) {
  const t = load(f);
  console.log("═".repeat(70));
  console.log(`时间   ${t.at}`);
  console.log(`类型   ${t.kind}    场景 ${t.scope}    标签 ${t.label ?? "-"}`);
  console.log(`耗时   ${JSON.stringify(t.timings ?? {})}`);
  console.log(`长度   system=${t.systemChars} 字，记忆段=${t.memoryChars} 字`);
  for (const m of t.messages ?? []) {
    const role = String(m.role).padEnd(9);
    const body = String(m.content ?? "");
    console.log("\n" + "─".repeat(70));
    console.log(`[${role}]`);
    console.log(body.trim().slice(0, 3000));
  }
  console.log("\n" + "─".repeat(70));
  console.log(`[她的回答]\n${String(t.answer ?? "（无）").trim()}`);
}
