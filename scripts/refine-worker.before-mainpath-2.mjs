#!/usr/bin/env node
// REFINE-LOOP-1：原文证据 → 正式记忆 的提炼 worker（生产版，替换产品岗原型）
//
// 设计要点（对单号 REFINE-LOOP-1 的三件事）：
//   1. 常驻靠"外部定时拉起"，不常驻内存：**每次新进程、无状态**，进度全在 state 文件里。
//   2. 去重两层：内容哈希（同文直接跳过）+ 近义重复（字符二元组 Jaccard ≥ 阈值 + 模型 duplicate_of）。
//   3. 失败可见：每条证据都有 pending/done/failed(+原因)/dead/skipped，`--status` 一条命令能答
//      "多少待提炼 / 多少失败 / 最近一次成功是什么时候"。首条失败**绝不 break 整队**。
//
// 用法：
//   node refine-worker.mjs                     # 跑一轮（默认最多 20 条新证据）
//   node refine-worker.mjs --limit 5 --dry     # 只抽不写
//   node refine-worker.mjs --status            # 只读：待提炼/失败/死信/最近成功/累计 token
//   node refine-worker.mjs --status --json     # 同一份结论的机器可读版
//
// 关键开关（全部可注入，默认指生产）：
//   --evidence <dir>   证据目录        默认 .\data\memory\evidence\conversations
//   --data-root <dir>  记忆库根         默认 .\data\memory
//   --state <file>     状态文件         默认 .\state\refine-state.json
//   --api <url>        记忆服务          默认 http://127.0.0.1:8787
//   --since <date>     只处理该日期及以后
//   --max-attempts <n> 重试上限        默认 3（超限进死信 dead）
//   --visibility <v>   写出的可见性     默认 platform（见下方 VISIBILITY 说明）
//   --patch <file>     凭据来源 A：DSH MCP patch（X-MCP-Credential-Ref / X-MCP-Secret）
//   --secret-file <f>  凭据来源 B：直接给一段 secret（只用于副本/测试，绝不入仓库）
//   --model-key-file <f> 模型 key 来源  默认 ~\.dsh\.credentials.yaml
//
// VISIBILITY 为什么默认 platform：
//   提炼出来的记忆是给别的 agent 查的。本机 registry 里 admin 账号没有 group_id，
//   visibility=shared 会被 /v1/write 的位置检查拒掉（WRITE_SCOPE_DENIED，见
//   localhost-server.mjs:1167）；而 pilot-01 的 memory/shared 作用域可以请求 platform
//   （memory-lib.mjs:210），container-policy.mjs:60 也认 platform 对所有人可见。
//   ⇒ 落 curated/shared + platform 是这台机器上"别人真能查到"的唯一可行组合。
//   多组部署可以改 --visibility shared，但那时必须给账号绑 group_id。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 近义重复阈值（字符二元组 Jaccard）。实测读数（scripts/refine-loop-1-work/calibrate-threshold.mjs
// 与 refine-worker.test.mjs 的 diagnostic 行）：
//   逐字重复 1.000 ｜ 只改标点/个别字的平凡改写 0.974 ｜ 换句说法的中度改写 0.228 ｜ 不相关 0.000
//   **一字之差的不同事实（"重试上限三次" vs "五次"）0.974** —— 和"平凡改写"几乎同分。
//   ⇒ 光靠相似度必然出事：阈值 ≤0.974 会把两个不同的决定并成一条。所以判重要过两关：
//     ① Jaccard ≥ 0.92（只可能差标点/个别字）
//     ② decisiveTokens() 一致（数字、否定词完全相同）
//   任一条不满足就**不判重**（宁可多写一条，也不删掉一个不同的决定）。
//   真正的语义级近义（换个说法）交给模型 duplicate_of，因为字符相似度对它只有 0.2~0.4。
export const NEAR_DUP_THRESHOLD = 0.92;

// 太短的证据直接跳过（多半是告警/空转/单字回执）
export const MIN_CHARS = 120;

// 这些前缀的证据是运维噪声，不该变成长期记忆
export const SKIP_PREFIXES = ["【触发器告警】", "【触发器提醒】", "收到，无新增", "现在 "];

export const STATE_VERSION = 1;
export const LOCK_STALE_MS = 15 * 60_000;

// 日期口径（AGENTS.md §5 红线）：本地日按 Asia/Shanghai 解释。
// 证据文件多数只有 capturedAt（UTC 瞬时），没有 calendarDate；
// 20:02Z 这种时刻在上海已是**次日**，直接切字符串会差一天。
export const DEFAULT_CALENDAR_TIMEZONE = "Asia/Shanghai";

export function localizedDate(iso, timeZone = DEFAULT_CALENDAR_TIMEZONE) {
  const date = new Date(String(iso ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// 纯函数：归一化 / 哈希 / 相似度
// ---------------------------------------------------------------------------

// 去掉所有空白与标点（含全角），只留字母、数字、汉字。用于哈希与相似度比较，
// 这样"甲，乙。丙"和"甲 乙 丙"视为同一句，避免标点差异造成假重复。
export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

export function contentHash(text) {
  return crypto.createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 24);
}

function bigrams(text) {
  const s = normalizeText(text);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

// 字符二元组 Jaccard。选它的理由：零依赖、纯确定性、可解释；中文不需要分词，
// 二元组对"同一件事换个说法"的召回明显好于整句相等，又不像 embedding 需要额外服务
// （本机没有可用的 embedding 端点，DeepSeek 也不提供 embeddings 接口）。
export function bigramJaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// 决定性 token：数字与否定词。句子越长，改一个数字对整体相似度的影响越小
// （实测：140 字的句子里"三次"→"五次"仍有 0.974），可这一字之差往往就是
// **两个不同的决定**。所以相似度够高之后还要过这一关：两侧的决定性 token 必须一致。
const NEGATIONS = ["不", "没", "无", "别", "勿", "禁止", "取消", "停止", "拒绝"];
export function decisiveTokens(text) {
  const s = normalizeText(text);
  const tokens = new Set();
  for (const digits of s.match(/\d+/g) ?? []) tokens.add(`#${digits}`);
  for (const numeral of s.match(/[一二三四五六七八九十百千万零两]/g) ?? []) tokens.add(`数:${numeral}`);
  for (const negation of NEGATIONS) if (s.includes(negation)) tokens.add(`否:${negation}`);
  return tokens;
}

export function isNearDuplicate(a, b, threshold = NEAR_DUP_THRESHOLD) {
  const score = bigramJaccard(a, b);
  if (score < threshold) return { duplicate: false, score, reason: "below-threshold" };
  const ta = decisiveTokens(a);
  const tb = decisiveTokens(b);
  const differing = [...ta].filter((token) => !tb.has(token)).length + [...tb].filter((token) => !ta.has(token)).length;
  if (differing > 0) return { duplicate: false, score, reason: "decisive-token-differs" };
  return { duplicate: true, score, reason: "near-identical" };
}

// 逐字原话校验：先去掉空白再判断包含；模型偶尔会用省略号拼两段，逐段校验。
export function quoteIsVerbatim(quote, conversationText) {
  const q = String(quote ?? "").trim();
  if (!q) return false;
  const haystack = normalizeText(conversationText);
  const segments = q
    .split(/…|\.\.\.|\u2026/)
    .map((segment) => normalizeText(segment))
    .filter((segment) => segment.length >= 4);
  if (segments.length === 0) return false;
  return segments.every((segment) => haystack.includes(segment));
}

// ---------------------------------------------------------------------------
// 证据文件解析
// ---------------------------------------------------------------------------

export function splitEvidenceFile(raw, { timeZone = DEFAULT_CALENDAR_TIMEZONE } = {}) {
  const text = String(raw ?? "");
  const frontmatter = {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (kv) frontmatter[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const body = match ? text.slice(match[0].length) : text;
  const messages = [];
  for (const part of body.split(/^##\s+/m).slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const content = (nl < 0 ? "" : part.slice(nl + 1)).trim();
    if (!content) continue;
    messages.push({ role: /用户|user/i.test(heading) ? "user" : "assistant", content });
  }
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const capturedAt = frontmatter.capturedAt || frontmatter.captured_at || "";
  const calendarDate = frontmatter.calendarDate || localizedDate(capturedAt, timeZone);
  return {
    frontmatter,
    id: frontmatter.eventId || frontmatter.id || "",
    calendarDate,
    capturedAt,
    // 事件时刻（事件轴）：优先 capturedAt；没有就用"事件日当天零点（按时区）"。
    // 绝不用 Date.now()——那是提炼时刻，会把记忆挂到提炼那天（REFINE-LOOP-2 的缺陷）。
    eventInstant: eventInstantOf(calendarDate, capturedAt, timeZone),
    messages,
    userText,
    conversationText: messages.map((m) => m.content).join("\n"),
  };
}

// 某天在指定时区的零点，返回 ISO 瞬时（用一次性偏移校正，避免引入时区库）。
export function zonedDayStartIso(day, timeZone = DEFAULT_CALENDAR_TIMEZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return null;
  const base = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(base));
    const g = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
    const asUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour === 24 ? 0 : g.hour, g.minute, g.second);
    return new Date(base - (asUtc - base)).toISOString();
  } catch {
    return new Date(base).toISOString();
  }
}

// 事件时刻：capturedAt 优先；否则用事件日零点。两者都没有 ⇒ null（调用方不许自己编）。
export function eventInstantOf(calendarDate, capturedAt, timeZone = DEFAULT_CALENDAR_TIMEZONE) {
  const ms = Date.parse(String(capturedAt ?? ""));
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return zonedDayStartIso(calendarDate, timeZone);
}

// 证据该不该跳过（返回原因或 null）。跳过不算失败，但要落状态、可查。
export function skipReason(userText) {
  const text = String(userText ?? "").trim();
  if (text.length < MIN_CHARS) return `skip-short(<${MIN_CHARS}字)`;
  const hit = SKIP_PREFIXES.find((prefix) => text.startsWith(prefix));
  if (hit) return `skip-noise(${hit.trim()})`;
  return null;
}

// 从一条已落盘的记忆 markdown 里取"事实正文"（去掉 frontmatter 与引用行），用于去重比较。
export function memoryFactText(markdown) {
  const text = String(markdown ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

export function emptyState() {
  return { version: STATE_VERSION, updated_at: null, last_run_at: null, last_success_at: null, last_run: null, evidence: {}, memories: {}, usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 } };
}

export async function loadState(stateFile) {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile, "utf8"));
    return { ...emptyState(), ...parsed, evidence: parsed.evidence ?? {}, memories: parsed.memories ?? {}, usage: { ...emptyState().usage, ...(parsed.usage ?? {}) } };
  } catch {
    return emptyState();
  }
}

export async function saveState(stateFile, state) {
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, stateFile);
}

// 死信人工恢复：把 dead（或指定 id 的 dead/failed）条目退回"待处理"，
// 下轮就会重新提炼。删除条目 = 重试计数归零，所以修好根因（比如换了 key）之后能真的救回来。
export function requeueEntries(state, { all = false, id = null } = {}) {
  const requeued = [];
  for (const [eventId, entry] of Object.entries(state.evidence ?? {})) {
    const status = entry?.status;
    if (all) { if (status === "dead") requeued.push(eventId); continue; }
    if (id && eventId === id && (status === "dead" || status === "failed")) requeued.push(eventId);
  }
  for (const eventId of requeued) delete state.evidence[eventId];
  return { requeued, remaining_dead: Object.values(state.evidence ?? {}).filter((e) => e?.status === "dead").length };
}

// 失败原因归一化：请求 id / 长十六进制每次都不同，不归一化的话直方图会被打散成一行一个
export function normalizeReason(reason) {
  return String(reason ?? "unknown")
    .replace(/request[_ ]?id["']?\s*[:=]\s*["']?[0-9a-fA-F-]+/gi, "request_id:<id>")
    .replace(/\b[0-9a-f]{16,}\b/g, "<hex>")
    .slice(0, 160);
}

// 一条命令能答的问题：多少待提炼、多少失败、最近一次成功
export function summarizeState(state, { evidenceTotal = null } = {}) {
  const counts = { done: 0, failed: 0, dead: 0, skipped: 0, pending: 0 };
  const failureReasons = {};
  for (const entry of Object.values(state.evidence ?? {})) {
    const status = entry?.status;
    if (status === "done") counts.done += 1;
    else if (status === "failed") { counts.failed += 1; const key = normalizeReason(entry.reason); failureReasons[key] = (failureReasons[key] ?? 0) + 1; }
    else if (status === "dead") { counts.dead += 1; const key = normalizeReason(entry.reason); failureReasons[key] = (failureReasons[key] ?? 0) + 1; }
    else if (status === "skipped") counts.skipped += 1;
    else counts.pending += 1;
  }
  if (evidenceTotal !== null) counts.pending = Math.max(0, evidenceTotal - counts.done - counts.failed - counts.dead - counts.skipped);
  return {
    evidence_total: evidenceTotal,
    done: counts.done,
    failed: counts.failed,
    dead: counts.dead,
    skipped: counts.skipped,
    pending: counts.pending,
    memories: Object.keys(state.memories ?? {}).length,
    last_success_at: state.last_success_at ?? null,
    last_run_at: state.last_run_at ?? null,
    last_run: state.last_run ?? null,
    usage: state.usage ?? emptyState().usage,
    failure_reasons: failureReasons,
  };
}

// ---------------------------------------------------------------------------
// 去重基线：库内已有的 curated/shared 记忆也参与比对（不只比 state 里的）
// ---------------------------------------------------------------------------

export async function loadExistingMemoryTexts(dataRoot) {
  const dir = path.join(dataRoot, "curated", "shared");
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      const markdown = await fsp.readFile(path.join(dir, name), "utf8");
      const fact = memoryFactText(markdown);
      if (fact) out.push({ id: path.basename(name, ".md"), text: fact, file: path.join(dir, name) });
    } catch { /* 单个文件读失败不影响整轮 */ }
  }
  return out;
}

// 证据级水位线：库里已有的提炼记忆，frontmatter 的 evidence_refs 指向它来自哪条证据。
// 把这些 eventId 收起来 ⇒ 即使 state 丢了/换了另一个 state，也不会把同一份原文再提炼一遍。
// 这是"重复跑不重复写"的真正兜底：内容哈希只能挡住"同一句文本"，
// 挡不住"同一份原文被模型抽出措辞不同的新句子"（实测会多写 6 条，见 FOLLOW 报告）。
export async function loadRefinedEventIds(dataRoot) {
  const dir = path.join(dataRoot, "curated", "shared");
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return new Set(); }
  const ids = new Set();
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      const markdown = await fsp.readFile(path.join(dir, name), "utf8");
      const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const line = frontmatter.match(/^evidence_refs:\s*\[(.*)\]$/m)?.[1] ?? "";
      for (const match of line.matchAll(/"([^"]+)"/g)) ids.add(match[1]);
    } catch { /* 单文件失败不影响整轮 */ }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 跑一轮提炼。所有外部依赖（模型抽取 / 写库 / 时间 / 日志）都是注入的，
 * 所以测试可以完全不联网、不碰生产数据。
 */
export async function runRefine({
  evidenceDir,
  stateFile,
  dataRoot,
  limit = 20,
  since = null,
  dry = false,
  maxAttempts = 3,
  calendarTimezone = DEFAULT_CALENDAR_TIMEZONE,
  evidenceWatermark = true,
  now = () => new Date().toISOString(),
  extract,
  write,
  loadBaseline = loadExistingMemoryTexts,
  loadWatermark = loadRefinedEventIds,
  log = () => {},
} = {}) {
  if (!evidenceDir) throw new Error("runRefine 需要 evidenceDir");
  if (typeof extract !== "function") throw new Error("runRefine 需要 extract");
  if (typeof write !== "function") throw new Error("runRefine 需要 write");

  const state = await loadState(stateFile);

  // 去重基线 = 库内已落盘的 curated/shared + 历史 state 记录
  const baseline = dataRoot ? await loadBaseline(dataRoot) : [];
  const refinedEventIds = evidenceWatermark && dataRoot ? await loadWatermark(dataRoot) : new Set();
  const knownHashes = new Set(baseline.map((item) => contentHash(item.text)));
  const knownTexts = baseline.map((item) => ({ id: item.id, text: item.text }));
  for (const [hash, meta] of Object.entries(state.memories)) {
    knownHashes.add(hash);
    if (meta?.text && !knownTexts.some((item) => item.id === meta.id)) knownTexts.push({ id: meta.id, text: meta.text });
  }

  // 证据清单：全部解析后再排序（日期升序 + id 升序），保证每次运行顺序确定、可复现
  let names = [];
  try { names = await fsp.readdir(evidenceDir); } catch (error) { throw new Error(`证据目录读不了：${evidenceDir}（${error.message}）`); }
  const parsed = [];
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const file = path.join(evidenceDir, name);
    let raw;
    try { raw = await fsp.readFile(file, "utf8"); } catch (error) { log(`  ! 读不了 ${name}: ${error.message}`); continue; }
    const item = splitEvidenceFile(raw, { timeZone: calendarTimezone });
    item.file = file;
    item.name = name;
    item.id = item.id || path.basename(name, ".md");
    parsed.push(item);
  }
  parsed.sort((a, b) => (a.calendarDate || "").localeCompare(b.calendarDate || "") || a.id.localeCompare(b.id));

  const result = { processed: 0, written: 0, dedupedHash: 0, dedupedNear: 0, dedupedModel: 0, skipped: 0, failed: 0, dead: 0, dropped: 0, reprocessed: 0, watermarked: 0, evidenceTotal: parsed.length };

  for (const item of parsed) {
    if (result.processed >= limit) break;
    // 逐条落盘：进程被杀/超时也只会丢"当前这一条"，已处理过的下次不会被重复抽取
    if (!dry) await saveState(stateFile, state);
    // 证据内容指纹：MAINPATH-1 的捕获可能先落 partial 再补全（同一个 eventId），
    // 内容一变就必须重新提炼，否则"补全的那一半"永远进不了记忆。
    // 老状态里没有 evidence_hash 的条目按"内容未变"处理，避免升级后把历史 done 全重跑一遍。
    const evidenceHash = contentHash(`${item.userText}\u0000${item.conversationText}`);
    const previous = state.evidence[item.id];
    const contentChanged = previous?.evidence_hash !== undefined && previous.evidence_hash !== evidenceHash;
    if (contentChanged) {
      log(`  ↻ ${item.id} 证据内容变了（partial→complete 或修订），重新提炼`);
      delete state.evidence[item.id];
      result.reprocessed += 1;
    }

    if (!previous && refinedEventIds.has(item.id)) {
      state.evidence[item.id] = { status: "skipped", attempts: 0, reason: "already-refined(库里已有该证据的记忆)", at: now(), calendarDate: item.calendarDate, evidence_hash: evidenceHash };
      result.skipped += 1;
      result.watermarked += 1;
      continue;
    }
    if (!contentChanged && previous?.status === "done") { result.skipped += 1; continue; }
    if (!contentChanged && previous?.status === "skipped") { result.skipped += 1; continue; }
    if (!contentChanged && previous?.status === "dead") { result.skipped += 1; continue; }
    if (since && (item.calendarDate || "") < since) continue;

    const skippedReason = skipReason(item.userText);
    if (skippedReason) {
      state.evidence[item.id] = { status: "skipped", attempts: 0, reason: skippedReason, at: now(), calendarDate: item.calendarDate, evidence_hash: evidenceHash };
      result.skipped += 1;
      continue;
    }

    result.processed += 1;
    // 内容变了算一次全新处理，重试计数归零（否则补全的证据会一上来就撞死信上限）
    const attempts = contentChanged ? 0 : Number(previous?.attempts ?? 0);
    const entry = { status: "failed", attempts: attempts + 1, calendarDate: item.calendarDate, at: now(), evidence_hash: evidenceHash };

    let extraction;
    try {
      extraction = await extract({
        id: item.id,
        calendarDate: item.calendarDate,
        messages: item.messages,
        userText: item.userText,
        conversationText: item.conversationText,
        existing: knownTexts,
        attempt: attempts + 1,
      });
    } catch (error) {
      // 首败不整队：记原因、累加次数、继续下一条
      const reason = `extract: ${error.message}`.slice(0, 400);
      entry.reason = reason;
      if (entry.attempts >= maxAttempts) entry.status = "dead";
      state.evidence[item.id] = entry;
      if (entry.status === "dead") result.dead += 1; else result.failed += 1;
      log(`  ✗ ${item.id} 抽取失败（第 ${entry.attempts}/${maxAttempts} 次）: ${reason}`);
      continue;
    }

    if (extraction?.usage) accumulateUsage(state, extraction.usage);
    const memories = Array.isArray(extraction?.memories) ? extraction.memories : [];
    const accepted = [];
    const skipNotes = [];
    let writeError = null;

    for (const memory of memories) {
      const text = String(memory?.text ?? "").trim();
      if (!text) continue;
      const quote = String(memory?.evidence_quote ?? "").trim();

      // 逐字原话是交付要求：校验不过就不写（不静默、记原因）
      if (!quoteIsVerbatim(quote, item.conversationText)) {
        skipNotes.push(`quote_unverified:${text.slice(0, 60)}`);
        result.dropped += 1;
        continue;
      }

      const hash = contentHash(text);
      if (knownHashes.has(hash)) { result.dedupedHash += 1; continue; }

      let best = { score: 0, id: null, reason: "none" };
      for (const known of knownTexts) {
        const verdict = isNearDuplicate(text, known.text);
        if (verdict.duplicate && verdict.score > best.score) best = { score: verdict.score, id: known.id, reason: verdict.reason };
      }
      if (best.id) {
        result.dedupedNear += 1;
        log(`   ≈ 近义重复(${best.score.toFixed(3)}) 跳过：${text.slice(0, 40)} → ${best.id}`);
        continue;
      }
      if (memory?.duplicate_of && knownTexts.some((known) => known.id === memory.duplicate_of)) {
        result.dedupedModel += 1;
        log(`   ≈ 模型判重 跳过：${text.slice(0, 40)} → ${memory.duplicate_of}`);
        continue;
      }

      if (dry) {
        log(`   · [dry][${memory?.kind ?? "fact"}] ${text}`);
        accepted.push({ id: null, text, dry: true });
        knownHashes.add(hash);
        knownTexts.push({ id: `dry-${result.written + accepted.length}`, text });
        continue;
      }

      try {
        // REFINE-LOOP-2：把**事件轴**（日期 + 事件时刻）一并交给写入口，
        // 否则记忆会落到"提炼时刻"那天，问某一天就把别的日子的事端上来。
        const written = await write({
          memory: { ...memory, text, evidence_quote: quote },
          evidenceId: item.id,
          calendarDate: item.calendarDate,
          eventInstant: item.eventInstant,
        });
        const id = written?.id ?? null;
        state.memories[hash] = { id, text, at: now(), evidence_id: item.id };
        knownHashes.add(hash);
        knownTexts.push({ id: id ?? hash, text });
        accepted.push({ id, text });
        result.written += 1;
        log(`   ✓ [${memory?.kind ?? "fact"}] ${text}`);
      } catch (error) {
        writeError = `write: ${error.message}`.slice(0, 400);
        break;
      }
    }

    if (writeError) {
      entry.reason = writeError;
      entry.written = accepted.map((item) => item.id).filter(Boolean);
      if (entry.attempts >= maxAttempts) entry.status = "dead";
      state.evidence[item.id] = entry;
      if (entry.status === "dead") result.dead += 1; else result.failed += 1;
      log(`  ✗ ${item.id} 写入失败（第 ${entry.attempts}/${maxAttempts} 次）: ${writeError}`);
      continue;
    }

    const doneEntry = { status: "done", attempts: entry.attempts, calendarDate: item.calendarDate, at: now(), memories: memories.length, written: accepted.map((item) => item.id).filter(Boolean), evidence_hash: evidenceHash };
    if (skipNotes.length) doneEntry.notes = skipNotes;
    state.evidence[item.id] = doneEntry;
    log(`[${item.calendarDate}] ${item.name} → 抽出 ${memories.length} 条，写入 ${accepted.length} 条`);
  }

  if (!dry) {
    state.last_run_at = now();
    state.last_run = { at: state.last_run_at, processed: result.processed, written: result.written, failed: result.failed, dead: result.dead, skipped: result.skipped, deduped: result.dedupedHash + result.dedupedNear + result.dedupedModel, dropped: result.dropped };
    state.updated_at = state.last_run_at;
    // last_success_at 的口径 = "这一轮真的处理了东西，且没有失败/死信"。
    // 不能只在"写出新记忆"时才更新：一整轮全是去重命中（正常的稳态）也是成功，
    // 否则运维看 --status 会以为这条线卡住了。
    const progressed = result.processed > 0 || result.written > 0;
    if (progressed && result.failed === 0 && result.dead === 0) state.last_success_at = state.last_run_at;
    await saveState(stateFile, state);
  }
  return result;
}

function accumulateUsage(state, usage = {}) {
  state.usage.calls += 1;
  state.usage.prompt_tokens += Number(usage.prompt_tokens ?? 0) || 0;
  state.usage.completion_tokens += Number(usage.completion_tokens ?? 0) || 0;
  state.usage.cache_hit_tokens += Number(usage.cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  state.usage.cache_miss_tokens += Number(usage.cache_miss_tokens ?? 0) || 0;
}

// ---------------------------------------------------------------------------
// CLI：真实抽取器（deepseek-chat）+ 真实写入器（记忆服务 /v1/write）
// ---------------------------------------------------------------------------

function readFlag(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

export function parseArgs(argv = process.argv.slice(2)) {
  return {
    evidence: readFlag(argv, "evidence", "D:\\MemoryLib\\data\\memory\\evidence\\conversations"),
    dataRoot: readFlag(argv, "data-root", "D:\\MemoryLib\\data\\memory"),
    state: readFlag(argv, "state", "D:\\MemoryLib\\state\\refine-state.json"),
    api: readFlag(argv, "api", "http://127.0.0.1:8787"),
    visibility: readFlag(argv, "visibility", "platform"),
    limit: Number(readFlag(argv, "limit", 20)),
    maxAttempts: Number(readFlag(argv, "max-attempts", 3)),
    since: readFlag(argv, "since", null),
    calendarTimezone: readFlag(argv, "calendar-timezone", "Asia/Shanghai"),
    agent: readFlag(argv, "agent", "admin-01"),
    role: readFlag(argv, "role", "librarian-admin"),
    credentialRef: readFlag(argv, "credential-ref", "memory-lib/deepseek-harness"),
    patch: readFlag(argv, "patch", "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml"),
    secretFile: readFlag(argv, "secret-file", null),
    modelKeyFile: readFlag(argv, "model-key-file", "C:\\Users\\admin\\.dsh\\.credentials.yaml"),
    modelBase: readFlag(argv, "model-base", "https://api.deepseek.com/v1"),
    model: readFlag(argv, "model", "deepseek-chat"),
    modelTimeoutMs: Number(readFlag(argv, "model-timeout-ms", 120000)),
    writeTimeoutMs: Number(readFlag(argv, "write-timeout-ms", 60000)),
    dry: argv.includes("--dry"),
    status: argv.includes("--status"),
    requeueDead: argv.includes("--requeue-dead"),
    requeue: readFlag(argv, "requeue", null),
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet"),
    lock: !argv.includes("--no-lock"),
    evidenceWatermark: !argv.includes("--no-evidence-watermark"),
  };
}

function loadWriteCredential(options) {
  if (typeof options.secretFile === "string") {
    const secret = fs.readFileSync(options.secretFile, "utf8").trim();
    if (!secret) throw new Error(`secret 文件是空的：${options.secretFile}`);
    return { credential_ref: options.credentialRef, secret };
  }
  const yml = fs.readFileSync(options.patch, "utf8");
  const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
  const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
  if (!ref || !secret) throw new Error(`从 ${options.patch} 里拿不到 X-MCP-Credential-Ref / X-MCP-Secret`);
  return { credential_ref: ref, secret };
}

function loadModelKey(modelKeyFile) {
  const raw = fs.readFileSync(modelKeyFile, "utf8");
  const key = raw.match(/DEEPSEEK_API_KEY\s*:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
  if (!key) throw new Error(`从 ${modelKeyFile} 里拿不到 DEEPSEEK_API_KEY`);
  return key;
}

export function makeExtractor({ modelKey, modelBase, model = "deepseek-chat", timeoutMs = 120000 }) {
  const system = `你是记忆提炼器。从对话里抽出**值得长期记住的事实**，只输出 JSON。
规则：
- 只抽"用户说的、跨会话还有用"的东西：偏好、决定、约定、事实、重要结论、踩过的坑。
- 不抽：寒暄、告警通知、工具输出、助手自己说要做的事、临时状态。
- 每条一句话，中文，必须能独立读懂（带主体，必要时带时间）。
- 最多 4 条；没有值得记的就输出 []。
- evidence_quote：从对话里**逐字**摘取支撑它的原话片段（不超过 40 字，不许改写、不许加省略号）。
- 若"已有记忆"里已经存在同一件事（换个说法也算同一件），把那条的 id 填到 duplicate_of；否则 duplicate_of 为 null。
输出格式：{"memories":[{"text":"...","evidence_quote":"...","kind":"preference|decision|fact|lesson","duplicate_of":null}]}`;

  return async function extract({ calendarDate, messages, userText, existing = [] }) {
    const relevant = existing
      .map((item) => ({ ...item, score: bigramJaccard(userText, item.text) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    const existingBlock = relevant.length
      ? relevant.map((item) => `- id=${item.id}｜${item.text}`).join("\n")
      : "（空）";
    const user = `对话日期：${calendarDate}\n\n已有记忆（共 ${existing.length} 条，下面是和你这段话最相关的 ${relevant.length} 条）：\n${existingBlock}\n\n=== 对话 ===\n${messages.map((m) => `[${m.role}] ${m.content}`).join("\n").slice(0, 12000)}`;

    const response = await fetch(`${modelBase}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${modelKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`LLM 返回不是 JSON：${text.slice(0, 120)}`); }
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error(`LLM content 不是 JSON：${String(content).slice(0, 120)}`); }
    return { memories: Array.isArray(parsed.memories) ? parsed.memories : [], usage: payload.usage ?? null };
  };
}

export function makeWriter({ api, credential, principal, visibility = "platform", log = () => {}, timeoutMs = 60000 }) {
  return async function write({ memory, evidenceId, calendarDate, eventInstant = null }) {
    const text = String(memory.text ?? "").trim();
    // REFINE-LOOP-2：两条时间轴分开写。
    //   occurred_at / valid_from = **事件时刻**（证据的 capturedAt，或事件日零点）——"这事发生在什么时候"
    //   updated_at              = 写入口自己填的**提炼时刻**（记录轴，不由我们覆盖）
    // calendarDate 同步物化事件日，方便人和索引直接看。
    const occurredAt = eventInstant ?? null;
    if (!occurredAt) throw new Error(`缺事件时刻：evidenceId=${evidenceId} calendarDate=${calendarDate}（拒绝用提炼时刻顶替）`);
    const body = {
      ...credential,
      principal,
      layer: "curated-shared",
      visibility,
      type: "memory",
      kind: memory.kind ?? "fact",
      id: `curated-shared-${contentHash(text).slice(0, 16)}`,
      body: `${text}\n\n> 原话：${memory.evidence_quote}\n> 日期：${calendarDate}`,
      evidence_refs: [evidenceId],
      tags: ["refined", memory.kind ?? "fact"],
      ...(calendarDate ? { calendarDate } : {}),
      occurred_at: occurredAt,
      valid_from: occurredAt,
    };
    const response = await fetch(`${api}/v1/write`, { method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 240)}`);
    const parsed = JSON.parse(raw);
    log(`   → 落盘 ${parsed.path ?? parsed.id}`);
    return { id: parsed.id ?? body.id, path: parsed.path ?? null };
  };
}

function printStatus(summary, options) {
  if (options.json) { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); return; }
  const usage = summary.usage ?? {};
  const lines = [
    `refine-status  state=${options.state}`,
    `  evidence_total   ${summary.evidence_total ?? "(未统计)"}`,
    `  done             ${summary.done}`,
    `  pending          ${summary.pending}`,
    `  failed           ${summary.failed}   ← 未超上限，下一轮会重试`,
    `  dead             ${summary.dead}   ← 超过 ${options.maxAttempts} 次，已进死信`,
    `  skipped          ${summary.skipped}   ← 太短/告警噪声`,
    `  memories_written ${summary.memories}`,
    `  last_success_at  ${summary.last_success_at ?? "(还没有成功的提炼)"}   ← 最近一次"有处理且无失败"的轮次`,
    `  last_run_at      ${summary.last_run_at ?? "(还没跑过)"}   ← 最近一次真正跑过（哪怕全失败）`,
    `  usage            calls=${usage.calls ?? 0} prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0} cache_hit=${usage.cache_hit_tokens ?? 0}`,
  ];
  const reasons = Object.entries(summary.failure_reasons ?? {});
  if (reasons.length) {
    lines.push("  失败原因：");
    for (const [reason, count] of reasons) lines.push(`    ×${count}  ${reason}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const options = parseArgs();
  const log = options.quiet ? () => {} : (line) => process.stdout.write(`${line}\n`);

  if (options.requeueDead || options.requeue !== null) {
    if (options.requeue === true) {
      process.stderr.write("refine-worker: --requeue 需要给一个 eventId（或改用 --requeue-dead 全部恢复）\n");
      process.exitCode = 2;
      return;
    }
    const state = await loadState(options.state);
    const outcome = requeueEntries(state, { all: options.requeueDead, id: typeof options.requeue === "string" ? options.requeue : null });
    if (!outcome.requeued.length) {
      process.stdout.write("refine-worker: 没有可恢复的条目（没有 dead，或指定的 id 不在 dead/failed 里）\n");
      return;
    }
    await saveState(options.state, state);
    process.stdout.write(`refine-worker: 已退回待处理 ${outcome.requeued.length} 条 → ${outcome.requeued.join(", ")}\n`);
    process.stdout.write(`refine-worker: 剩余死信 ${outcome.remaining_dead} 条；下一轮会重新提炼\n`);
    return;
  }

  if (options.status) {
    const state = await loadState(options.state);
    let evidenceTotal = null;
    try { evidenceTotal = (await fsp.readdir(options.evidence)).filter((name) => name.endsWith(".md")).length; }
    catch { evidenceTotal = null; }
    printStatus(summarizeState(state, { evidenceTotal }), options);
    return;
  }

  // 防重入锁：5 分钟一轮，慢轮会和下一轮重叠；重叠会让同一份证据被抽两遍（虽然去重能兜住，
  // 但没必要白花额度）。锁过期 15 分钟，进程被杀留下的旧锁不会把线永久卡死。
  let releaseLock = null;
  if (options.lock && !options.dry) {
    const lockFile = `${options.state}.lock`;
    await fsp.mkdir(path.dirname(lockFile), { recursive: true });
    try {
      const stat = await fsp.stat(lockFile);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < LOCK_STALE_MS) {
        process.stdout.write(`refine-worker: 上一轮还在跑（锁 ${Math.round(ageMs / 1000)}s 前建立），本轮跳过\n`);
        return;
      }
      process.stdout.write(`refine-worker: 清掉过期锁（${Math.round(ageMs / 60000)} 分钟前）\n`);
      await fsp.rm(lockFile, { force: true });
    } catch { /* 没有锁文件就是好事 */ }
    await fsp.writeFile(lockFile, String(process.pid), { encoding: "utf8", flag: "wx" });
    releaseLock = async () => { await fsp.rm(lockFile, { force: true }).catch(() => {}); };
  }

  // dry 只跳过"写库"，抽取照做（否则 dry 什么也验证不了）
  const modelKey = loadModelKey(options.modelKeyFile);
  const credential = loadWriteCredential(options);
  const extract = makeExtractor({ modelKey, modelBase: options.modelBase, model: options.model, timeoutMs: options.modelTimeoutMs });
  const write = makeWriter({ api: options.api, credential, principal: { agent_id: options.agent, role_id: options.role }, visibility: options.visibility, log, timeoutMs: options.writeTimeoutMs });

  let result;
  try {
    result = await runRefine({
      evidenceDir: options.evidence,
      stateFile: options.state,
      dataRoot: options.dataRoot,
      limit: Number.isFinite(options.limit) ? options.limit : 20,
      since: typeof options.since === "string" ? options.since : null,
      dry: options.dry,
      maxAttempts: Number.isFinite(options.maxAttempts) ? options.maxAttempts : 3,
      calendarTimezone: options.calendarTimezone,
      evidenceWatermark: options.evidenceWatermark,
      extract,
      write,
      log,
    });
  } finally {
    // 无论成功、失败还是抛错都要放锁，否则一次异常会把后续每一轮都挡在门外
    if (releaseLock) await releaseLock();
  }

  process.stdout.write(
    `\n完成：处理 ${result.processed} 条证据，写入 ${result.written} 条记忆，` +
    `去重(哈希 ${result.dedupedHash}/近义 ${result.dedupedNear}/模型 ${result.dedupedModel})，` +
    `跳过 ${result.skipped} 条，失败 ${result.failed} 条，死信 ${result.dead} 条，` +
    `原话校验未过丢弃 ${result.dropped} 条\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`refine-worker 失败：${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
