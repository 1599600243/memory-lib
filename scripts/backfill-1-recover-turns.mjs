#!/usr/bin/env node
/**
 * BACKFILL-1：把漏捕的 turn 从会话日志里补回记忆库。
 *
 * 为什么需要它：2026-10-19 06:04–20:11，`memory-capture` 插件被停用、而该会话又不走代理，
 * 两条捕获路径都不沾 ⇒ `session-dccc44aa` 的 turn-967~1010 共 44 轮没进库。
 * 会话日志还在（每个 append 一个 zstd 帧），内容可恢复。
 *
 * ── 三条硬要求（范围单 §二）────────────────────────────────────────
 *   ① **按事件时间**写 capturedAt / calendarDate，绝不用 now()。
 *      服务端的 capture 入口把 capturedAt 硬编码成 `new Date()`（conversation-memory.mjs:68），
 *      而且接口有字段白名单、不收 capturedAt；又不能重启 8787。所以做法是：
 *      **先走正规 capture 接口**（服务端负责指纹/索引/审计/幂等），
 *      **再就地把这一轮新写出的证据文件的三个时间字段改成事件时间**。
 *      只改"本次新产生"的文件，不碰任何既有证据。
 *   ② **幂等**：库里已有该 eventId 就跳过；接口本身也会按 (source, conversation_id, event_id) 去重。
 *      跑两遍条数不变。
 *   ③ **范围受限**：默认只补 `--session` 的 `--from`~`--to`，不碰其它会话、不碰更早历史。
 *
 * 用法（默认 dry-run，只说不做）：
 *   node scripts/backfill-1-recover-turns.mjs
 *   node scripts/backfill-1-recover-turns.mjs --apply          # 真补
 *   node scripts/backfill-1-recover-turns.mjs --from 967 --to 1010 --session session-xxx
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// ---------------------------------------------------------------- 参数
function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}
const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const SESSION_ID = arg("session", "session-dccc44aa-5b2e-4e00-af85-d23dfe1d7860");
const FROM = Number(arg("from", 967));
const TO = Number(arg("to", 1010));
const API_BASE = arg("api", process.env.MEMORY_BASE || "http://127.0.0.1:8787");
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const EVIDENCE_DIR = arg("evidence-dir", "D:\\MemoryLib\\data\\memory\\evidence\\conversations");
const PATCH_FILE = path.join(DSH_HOME, "profiles", "web", "cordis.patch.yml");
const SOURCE = "dsh-session";
const TZ = "Asia/Shanghai";
const POST_TIMEOUT_MS = 20000;
const SESSION_FILE = arg("session-file", null);
const MAX_TEXT = 8000;

// ---------------------------------------------------------------- zstd 多帧扫描
const ZSTD_MAGIC = 0xfd2fb528;

/** 算一帧的结束位置（RFC 8878 帧结构）。边界算错时解压会抛错，故这是自校验的。 */
export function frameEnd(buf, start) {
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) throw new Error(`不是 zstd 帧 @${start}`);
  let p = start + 4;
  const fhd = buf[p];
  p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSegment) p += 1;
  p += dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : dictFlag === 3 ? 4 : 0;
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 3) throw new Error(`非法块类型 @${p - 3}`);
    p += type === 1 ? 1 : size;
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

/** 逐帧解压，按行回调 JSON 记录。 */
export async function readSessionRecords(file, onRecord) {
  const buf = await fs.readFile(file);
  let p = 0;
  let frames = 0;
  while (p < buf.length) {
    const end = frameEnd(buf, p);
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(p, end)).toString("utf8");
    } catch (e) {
      throw new Error(`帧解压失败 @${p}（第 ${frames + 1} 帧）：${e.message}`);
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      onRecord(rec);
    }
    p = end;
    frames += 1;
  }
  return { frames, bytes: buf.length };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** 从会话记录重建 turn → { turn, startTime, endTime, users[], assistants[] }。 */
export async function rebuildTurns(file) {
  const turns = new Map();
  const ensure = (n) => {
    if (!turns.has(n)) turns.set(n, { turn: n, startTime: null, endTime: null, users: [], assistants: [] });
    return turns.get(n);
  };
  let cur = null;
  const stats = await readSessionRecords(file, (rec) => {
    const type = rec?.type;
    if (type === "turn/start") {
      cur = rec.data?.turn ?? null;
      if (cur != null) ensure(cur).startTime = rec.time ?? null;
      return;
    }
    if (type === "turn/end") {
      const n = rec.data?.turn ?? cur;
      if (n != null) ensure(n).endTime = rec.time ?? null;
      cur = null;
      return;
    }
    if (type === "user/message") {
      const n = cur ?? rec.data?.turn;
      if (n == null) return;
      // 与插件同一口径：只收真人消息，跳过系统注入
      if (rec.data?.source?.kind !== "user") return;
      const text = textOf(rec.data?.content);
      if (!text || text.startsWith("Current runtime context")) return;
      ensure(n).users.push({ time: rec.time ?? null, text });
      return;
    }
    if (type === "assistant/message") {
      const n = rec.data?.turn ?? cur;
      if (n == null) return;
      const text = textOf(rec.data?.message?.content); // 只取正文，丢掉 reasoning
      if (text) ensure(n).assistants.push({ time: rec.time ?? null, text });
    }
  });
  return { turns, stats };
}

// ---------------------------------------------------------------- 库内已有 eventId
async function existingEventIds(dir, sessionId) {
  const set = new Set();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return set;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let text;
    try {
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(sessionId)) continue;
    const ev = text.match(/^eventId:\s*"?([^"\r\n]+)"?$/mu)?.[1]?.trim();
    if (ev) set.add(ev);
  }
  return set;
}

// ---------------------------------------------------------------- 凭据（与插件同一来源）
async function loadAuth() {
  let ref = process.env.MEMORY_LIB_CRED_REF;
  let secret = process.env.MEMORY_LIB_SECRET;
  try {
    const yml = await fs.readFile(PATCH_FILE, "utf8");
    ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? ref;
    secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? secret;
  } catch {
    /* 读不到配置就看 env */
  }
  if (!ref || !secret) throw new Error(`拿不到凭据（${PATCH_FILE} 或 MEMORY_LIB_CRED_REF/SECRET）`);
  // 捕获身份必须自洽：注册表里 admin-01 + capture-ingest 这种组合不存在（会 403 UNKNOWN_ROLE）
  return { credential_ref: ref, secret, principal: { agent_id: process.env.MEMORY_LIB_CAPTURE_AGENT ?? "pilot-01", role_id: process.env.MEMORY_LIB_CAPTURE_ROLE ?? "capture-ingest" } };
}

// ---------------------------------------------------------------- 时间字段就地校正
/** 把新写出的证据文件的 capturedAt/calendarDate/calendarTimezone 改成事件时间。 */
export async function fixEvidenceTime(evidencePath, eventInstant) {
  const original = await fs.readFile(evidencePath, "utf8");
  const calendar = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(eventInstant));
  let text = original
    .replace(/^capturedAt:.*$/mu, `capturedAt: ${eventInstant}`)
    .replace(/^calendarDate:.*$/mu, `calendarDate: ${calendar}`)
    .replace(/^calendarTimezone:.*$/mu, `calendarTimezone: ${JSON.stringify(TZ)}`);
  if (text === original) return { changed: false, calendarDate: calendar };
  const tmp = `${evidencePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, evidencePath);
  return { changed: true, calendarDate: calendar };
}

// ---------------------------------------------------------------- 主流程
async function locateSessionFile(sessionId) {
  if (SESSION_FILE) return SESSION_FILE;
  const root = path.join(DSH_HOME, "sessions");
  let dirs = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    throw new Error(`读不了会话根目录：${root}`);
  }
  for (const d of dirs) {
    const candidate = path.join(root, d, sessionId, "session.jsonl.zstd");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  throw new Error(`找不到会话日志：${root}\\*\\${sessionId}\\session.jsonl.zstd`);
}

async function main() {
  // ---- 回滚：只删"这个会话、这个 turn 区间"的证据文件，别的文件一概不碰 ----
  if (ROLLBACK) {
    console.log(`══════ BACKFILL-1 ${APPLY ? "（--rollback --apply 真删）" : "（--rollback dry-run，只列出）"} ══════`);
    console.log(`session : ${SESSION_ID}`);
    console.log(`范围    : turn-${FROM} ~ turn-${TO}`);
    const targets = [];
    for (const name of await fs.readdir(EVIDENCE_DIR).catch(() => [])) {
      if (!name.endsWith(".md")) continue;
      const full = path.join(EVIDENCE_DIR, name);
      const text = await fs.readFile(full, "utf8").catch(() => "");
      const ev = text.match(/^eventId:\s*"?([^"\r\n]+)"?$/mu)?.[1]?.trim();
      if (!ev || !ev.startsWith(`${SESSION_ID}#turn-`)) continue;
      const n = Number(ev.split("#turn-")[1]);
      if (!Number.isFinite(n) || n < FROM || n > TO) continue;
      targets.push({ name, full, ev, turn: n });
    }
    targets.sort((a, b) => a.turn - b.turn);
    console.log(`\n命中 ${targets.length} 个证据文件（应等于要回滚的条数）`);
    for (const t of targets) console.log(`  ${t.ev}  ${t.name}`);
    if (!APPLY) {
      console.log("\n（dry-run：没删任何东西。确认无误后加 --apply 才真删。）");
      return;
    }
    let removed = 0;
    for (const t of targets) {
      try {
        await fs.rm(t.full, { force: true });
        removed += 1;
      } catch (e) {
        console.log(`  ✗ 删除失败 ${t.name}：${e?.message ?? e}`);
      }
    }
    console.log(`\n已删除 ${removed} 个证据文件。`);
    console.log("注意：这批事件的指纹仍留在服务的 .conversation-index 里，所以再跑一次 --apply 会被判重（不会重复写）。");
    return;
  }

  console.log(`══════ BACKFILL-1 ${APPLY ? "（--apply 真补）" : "（dry-run，只说不做）"} ══════`);
  console.log(`session : ${SESSION_ID}`);
  console.log(`范围    : turn-${FROM} ~ turn-${TO}`);
  console.log(`记忆服务: ${API_BASE}`);
  console.log("");

  const file = await locateSessionFile(SESSION_ID);
  console.log(`会话日志: ${file}`);
  const t0 = Date.now();
  const { turns, stats } = await rebuildTurns(file);
  console.log(`解压扫描: ${stats.frames} 帧 / ${(stats.bytes / 1048576).toFixed(1)} MB，用时 ${Date.now() - t0}ms`);
  console.log(`重建 turn: ${turns.size} 个（${Math.min(...turns.keys())} ~ ${Math.max(...turns.keys())}）`);

  const have = await existingEventIds(EVIDENCE_DIR, SESSION_ID);
  console.log(`库里已有该会话的 eventId: ${have.size} 个`);

  const planned = [];
  const problems = [];
  for (let n = FROM; n <= TO; n += 1) {
    const t = turns.get(n);
    if (!t) {
      problems.push({ turn: n, reason: "会话日志里没有这个 turn" });
      continue;
    }
    if (!t.users.length) {
      problems.push({ turn: n, reason: "没有真人消息" });
      continue;
    }
    if (!t.assistants.length) {
      problems.push({ turn: n, reason: "没有助手正文" });
      continue;
    }
    const eventId = `${SESSION_ID}#turn-${n}`;
    if (have.has(eventId)) continue; // 幂等：已有就跳过
    // 事件时间用 turn/end（与库里其它证据的口径一致：capturedAt ≈ 该轮结束时刻）
    const eventMs = t.endTime ?? t.startTime;
    planned.push({
      turn: n,
      eventId,
      eventInstant: new Date(eventMs).toISOString(),
      calendarDate: new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(eventMs)),
      messages: [
        ...t.users.map((u) => ({ role: "user", content: u.text.slice(0, MAX_TEXT) })),
        ...t.assistants.map((a) => ({ role: "assistant", content: a.text.slice(0, MAX_TEXT) })),
      ],
    });
  }

  console.log(`\n待补 ${planned.length} 条；跳过（库里已有）${TO - FROM + 1 - planned.length - problems.length} 条；问题 ${problems.length} 条`);
  for (const p of problems) console.log(`  ✗ turn-${p.turn}: ${p.reason}`);
  if (planned.length) {
    console.log("\n计划（前 5 条 + 后 2 条）：");
    for (const p of [...planned.slice(0, 5), ...(planned.length > 7 ? planned.slice(-2) : [])]) {
      console.log(`  turn-${String(p.turn).padEnd(5)} ${p.eventInstant}  ${p.calendarDate}  user=${p.messages.filter((m) => m.role === "user").length} asst=${p.messages.filter((m) => m.role === "assistant").length}  ${p.eventId}`);
    }
  }

  const result = { applied: APPLY, planned: planned.length, captured: 0, deduped: 0, failed: 0, corrected: 0, failures: [] };
  if (!APPLY) {
    console.log("\n（dry-run 结束。加 --apply 真正写入。）");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const auth = await loadAuth();
  console.log("\n开始逐条捕获……");
  for (const p of planned) {
    const t1 = Date.now();
    let res;
    try {
      res = await fetch(`${API_BASE}/v1/conversations/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...auth, source: SOURCE, conversation_id: SESSION_ID, event_id: p.eventId, messages: p.messages }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (e) {
      result.failed += 1;
      result.failures.push({ turn: p.turn, error: `${e?.name ?? "Error"}: ${e?.message ?? e}` });
      console.log(`  ✗ turn-${p.turn} 请求失败：${e?.message ?? e}`);
      continue;
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      result.failed += 1;
      const why = body?.error?.message ?? text.slice(0, 200);
      result.failures.push({ turn: p.turn, error: `HTTP ${res.status}: ${why}` });
      console.log(`  ✗ turn-${p.turn} HTTP ${res.status}：${why}`);
      continue;
    }
    if (body?.deduped) {
      result.deduped += 1;
      console.log(`  = turn-${p.turn} 服务端判重（已有），未覆盖`);
      continue;
    }
    result.captured += 1;
    // 关键一步：把这个**本次新写出**的文件时间改成事件时间
    let fix = { changed: false };
    if (body?.evidencePath) {
      try {
        fix = await fixEvidenceTime(body.evidencePath, p.eventInstant);
        if (fix.changed) result.corrected += 1;
      } catch (e) {
        result.failures.push({ turn: p.turn, error: `时间校正失败：${e?.message ?? e}` });
        console.log(`  ! turn-${p.turn} 时间校正失败：${e?.message ?? e}`);
      }
    }
    console.log(`  ✓ turn-${p.turn} evidence=${body?.evidenceId} ${Date.now() - t1}ms capturedAt→${p.eventInstant}${fix.changed ? "（已校正）" : ""}`);
  }

  console.log("\n══════ 结果 ══════");
  console.log(`补入 ${result.captured} 条（其中时间已校正 ${result.corrected} 条），判重 ${result.deduped} 条，失败 ${result.failed} 条`);
  if (result.failures.length) for (const f of result.failures) console.log(`  ✗ turn-${f.turn}: ${f.error}`);
  console.log(JSON.stringify(result, null, 2));
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((e) => {
    console.error(`BACKFILL-1 失败：${e?.stack ?? e}`);
    process.exit(1);
  });
}
