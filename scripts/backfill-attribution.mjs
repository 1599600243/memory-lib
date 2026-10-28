#!/usr/bin/env node
/**
 * backfill-attribution.mjs —— 给"无归属"的历史对话原文回填 groupId/userId
 *
 * 背景：生产 1027 条对话原文里 **819 条无归属** ⇒ 对任何主体不可见 ⇒
 *       用户问「10-06 聊了什么」什么都答不出来。用户已批准**只回填真实会话那拨**。
 *
 * 判据（机器可核，不靠感觉）：
 *   规则 A（**回填**）：
 *     A1 该条目的 `conversationId` 是**本机 `~/.dsh/sessions` 下真实存在的会话**；**或**
 *     A2 `conversationId` 为空（老格式没写会话号）**但正文不是探针**（32 条空会话号里 31 条是用户的真实对话，
 *        只有 1 条正文是「幂等探针：这条应只出现一次」）。
 *   规则 B（**不回填**）：其余一律不回填 —— `conversationId` 形如 `probe-*`、`*-test-*`、`verify-*`、
 *     `deploy-*`、`workspace-smoke-*`、`handoff-validation-*`、`agent:main:*`、
 *     本机不存在的未知 id、**或正文是探针**。
 *     （理由：它们多为测试/探针/他平台产物，回填会污染"那天聊了什么"。）
 *
 * 用法：
 *   node backfill-attribution.mjs            # 干跑（默认，不写任何东西）
 *   node backfill-attribution.mjs --apply    # 真正写入（先自动备份到 backups\backfill-attr-<stamp>\）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";
const BACKUP_ROOT = "D:\\MemoryLib\\backups";
const SESSIONS_ROOT = path.join(process.env.USERPROFILE ?? "C:\\Users\\admin", ".dsh", "sessions");
const GROUP = "home-circle";
const USER = "user-owner";
const APPLY = process.argv.includes("--apply");

// 本机真实会话 id 集合
const realSessions = new Set();
for (const folder of fs.readdirSync(SESSIONS_ROOT)) {
  const base = path.join(SESSIONS_ROOT, folder);
  if (!fs.statSync(base).isDirectory()) continue;
  for (const entry of fs.readdirSync(base)) {
    if (fs.statSync(path.join(base, entry)).isDirectory()) realSessions.add(entry);
  }
}

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".md"));
const unattributed = [];
for (const name of files) {
  const full = path.join(ROOT, name);
  const text = fs.readFileSync(full, "utf8");
  if (!/type:\s*conversation/u.test(text)) continue;
  const g = /^groupId:\s*"?([^"\r\n]*)"?/mu.exec(text)?.[1] ?? null;
  const u = /^userId:\s*"?([^"\r\n]*)"?/mu.exec(text)?.[1] ?? null;
  // 需要处置的三种：① 没有 groupId 行 ② 归属是 unknown ③ 归属为空
  const needs = g === null || u === null || g === "" || u === "" || g === "unknown" || u === "unknown";
  if (!needs) continue;
  const cid = /conversationId:\s*"([^"]*)"/u.exec(text)?.[1] ?? "";
  unattributed.push({ name, full, text, cid, wasUnknown: g === "unknown" || u === "unknown" });
}

const PROBE_BODY = /幂等探针|测试探针|探针：|probe|PROBE/u;
const bodyText = (text) => text.split("---").slice(2).join("---").replace(/\s+/gu, " ").trim();

const isRuleA = (x) => realSessions.has(x.cid) || (x.cid === "" && !PROBE_BODY.test(bodyText(x.text)));
const ruleA = unattributed.filter(isRuleA);
const ruleB = unattributed.filter((x) => !isRuleA(x));
const byCid = (arr, n = 8) => {
  const m = new Map();
  for (const x of arr) m.set(x.cid || "(空)", (m.get(x.cid || "(空)") ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v}× ${k}`).join("  ·  ");
};

console.log(`本机真实会话数 = ${realSessions.size}`);
console.log(`无归属对话原文 = ${unattributed.length} 条`);
console.log(`\n规则 A（**回填**，会话在本机真实存在）= ${ruleA.length} 条`);
console.log(`   ${byCid(ruleA)}`);
console.log(`\n规则 B（**不回填**）= ${ruleB.length} 条`);
console.log(`   ${byCid(ruleB, 12)}`);

console.log(`\n=== 规则 A 抽样 12 条（看一眼正文，确认是"人说的话"）===`);
for (const x of ruleA.slice(0, 12)) {
  const body = x.text.split("---").slice(2).join("---").replace(/\s+/gu, " ").trim();
  const at = /capturedAt:\s*(\S+)/u.exec(x.text)?.[1] ?? "?";
  console.log(`  ${at.slice(0, 16)}  ${x.cid.slice(0, 24)}  ${body.slice(20, 96)}`);
}
console.log(`\n=== 规则 B 抽样 12 条（确认是测试/探针/他平台，而不是用户的正常对话）===`);
for (const x of ruleB.slice(0, 12)) {
  const body = x.text.split("---").slice(2).join("---").replace(/\s+/gu, " ").trim();
  const at = /capturedAt:\s*(\S+)/u.exec(x.text)?.[1] ?? "?";
  console.log(`  ${at.slice(0, 16)}  cid="${x.cid.slice(0, 30)}"  ${body.slice(20, 92)}`);
}

if (!APPLY) {
  console.log("\n（干跑结束，未写入任何东西。加 --apply 才真正写入。）");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/gu, "").slice(0, 15);
const backupDir = path.join(BACKUP_ROOT, `backfill-attr-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

/**
 * 插到 frontmatter 的**收尾 `---` 之前**（不依赖 `roleId` 行 ——
 * 早期格式没有 roleId/frameworkId，拿它当锚点会让 386 条直接失败，已踩过）。
 * 并按文件自身的换行风格拼接（避免把 CRLF 文件插成混合换行）。
 */
function insertAttribution(text) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  if (lines[0].trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) if (lines[i].trim() === "---") { end = i; break; }
  if (end < 0) return null;
  // 已经有 groupId/userId 行（值是 unknown/空）⇒ **覆盖值**，别插出重复键
  let sawG = false, sawU = false;
  for (let i = 1; i < end; i += 1) {
    if (/^groupId:/u.test(lines[i])) { lines[i] = `groupId: "${GROUP}"`; sawG = true; }
    else if (/^userId:/u.test(lines[i])) { lines[i] = `userId: "${USER}"`; sawU = true; }
  }
  if (!sawG && !sawU) lines.splice(end, 0, `groupId: "${GROUP}"`, `userId: "${USER}"`);
  else if (!sawG) lines.splice(end, 0, `groupId: "${GROUP}"`);
  else if (!sawU) lines.splice(end, 0, `userId: "${USER}"`);
  return lines.join(nl);
}

let changed = 0;
const failed = [];
for (const x of ruleA) {
  fs.copyFileSync(x.full, path.join(backupDir, x.name));
  const out = insertAttribution(x.text);
  if (out === null) { failed.push(x.name); continue; }
  fs.writeFileSync(x.full, out, "utf8");
  changed += 1;
}
console.log(`\n✅ 已回填 ${changed} 条（备份在 ${backupDir}）`);
console.log(`   未回填 ${ruleB.length} 条（规则 B）`);
if (failed.length) console.log(`   ⚠️ 插不进去 ${failed.length} 条：${failed.slice(0, 5).join(", ")}`);
