// DSH 实时自动记忆捕获插件（Cordis）
// 监听 ctx.on('session/event')，把每个 turn 的真人消息 + 助手正文，按统一事件契约
// 实时提交给 memory-lib（/v1/conversations/capture）。
//
// 与外部轮询捕获器（<dshHome>/memory-capture/capture.mjs）共享同一水位文件，
// 避免两者重复提交；任一侧失败都不推进水位，由另一侧或重试队列兜底。
//
// 依据：skills/automatic-memory-capture/SKILL.md（统一事件格式 + 不绕治理闸门）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const name = "memory-capture";
const inject = [];

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const WORK_DIR = path.join(HOME, "memory-capture");
const STATE_FILE = path.join(WORK_DIR, "state.json");
const LOG_FILE = path.join(WORK_DIR, "realtime.log");
const API_BASE = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const MAX_TEXT = 8000;
const RETRY_INTERVAL_MS = 60_000;

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const rotated = path.join(WORK_DIR, `realtime.${stamp}.log`);
    if (fs.statSync(LOG_FILE).size > 0 && !fs.existsSync(rotated)) fs.renameSync(LOG_FILE, rotated);
    for (const entry of fs.readdirSync(WORK_DIR)) {
      if (!entry.startsWith("realtime.") || !entry.endsWith(".log")) continue;
      const full = path.join(WORK_DIR, entry);
      if (Date.now() - fs.statSync(full).mtimeMs > 14 * 86400_000) fs.rmSync(full, { force: true });
    }
  } catch { /* best effort */ }
}
function log(msg) {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    rotateLog();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

function loadAuth() {
  let ref = process.env.MEMORY_LIB_CRED_REF;
  let secret = process.env.MEMORY_LIB_SECRET;
  let agent = process.env.MEMORY_LIB_AGENT ?? "pilot-01";
  let role = process.env.MEMORY_LIB_CAPTURE_ROLE ?? "capture-ingest";
  // 配置文件里的密钥是唯一真相来源：进程内的 env 可能是 DSH 启动时的旧值，
  // 密钥轮换后若 DSH 未重启，env 仍是旧值 → 采集持续 401（2026-09-23 实测）。
  // 因此这里**优先读配置**，只有配置读不到时才回落到 env。
  try {
    const yml = fs.readFileSync(path.join(HOME, "profiles", "web", "cordis.patch.yml"), "utf8");
    ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? ref;
    secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? secret;
    agent = yml.match(/X-MCP-Agent:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim() ?? agent;
  } catch { /* 配置读不到时保留 env 值 */ }
  return ref && secret ? { credential_ref: ref, secret, principal: { agent_id: agent, role_id: role } } : null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { sessions: {} }; }
}
function advanceWatermark(sessionId, turn) {
  try {
    const state = readState();
    const prev = state.sessions[sessionId] ?? {};
    if ((prev.maxTurn ?? 0) >= turn) return;
    state.sessions[sessionId] = { ...prev, maxTurn: turn, updatedAt: new Date().toISOString() };
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log(`WARN watermark failed: ${e.message}`); }
}
function isSubmitted(sessionId, turn) {
  const state = readState();
  return (state.sessions[sessionId]?.maxTurn ?? 0) >= turn;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n").trim();
}

function workspaceOf(session) {
  const value = session?.workspace ?? session?.cwd ?? session?.meta?.workspace ?? session?.meta?.cwd;
  return typeof value === "string" && value.trim() ? value.trim().replace(/\\/g, "/") : null;
}

async function postCapture(auth, event) {
  const res = await fetch(`${API_BASE}/v1/conversations/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...auth, ...event }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * @param ctx Cordis host context
 */
function apply(ctx) {
  const auth = loadAuth();
  if (!auth) { log("WARN 缺少 memory-lib 凭证，实时捕获未启用"); return; }

  const buffers = new Map();   // `${sessionId}` -> { turn, messages[] }
  const retry = [];            // 失败待重试事件
  let flushChain = Promise.resolve();

  const flush = (sessionId, turn, messages, workspace) => {
    flushChain = flushChain.then(async () => {
      if (!messages.length || isSubmitted(sessionId, turn)) return;
      const event = {
        source: "dsh-session",
        conversation_id: sessionId,
        event_id: `${sessionId}#turn-${turn}`,
        ...(workspace ? { workspace } : {}),
        messages,
      };
      try {
        const r = await postCapture(auth, event);
        advanceWatermark(sessionId, turn);
        log(`OK ${event.event_id} evidence=${r.evidenceId} candidates=${r.candidateCount}`);
      } catch (e) {
        retry.push(event);
        log(`FAIL ${event.event_id}: ${e.message}（进入重试队列）`);
      }
    }).catch((e) => log(`FLUSH-ERR ${e.message}`));
    return flushChain;
  };

  ctx.on("session/event", (session, event) => {
    const sessionId = session?.id ?? session?.sessionId ?? session?.meta?.id;
    if (!sessionId || !event?.type) return;
    if (event.type === "turn/start") {
      buffers.set(sessionId, { turn: event.data?.turn, workspace: workspaceOf(session), messages: [] });
      return;
    }
    if (event.type === "turn/end") {
      const buf = buffers.get(sessionId);
      buffers.delete(sessionId);
      if (buf?.turn != null) flush(sessionId, buf.turn, buf.messages, buf.workspace);
      return;
    }
    const buf = buffers.get(sessionId);
    if (!buf) return;
    if (event.type === "user/message") {
      if (event.data?.source?.kind !== "user") return;          // 跳过系统注入
      const text = textOf(event.data?.content);
      if (!text || text.startsWith("Current runtime context")) return;
      buf.messages.push({ role: "user", content: text.slice(0, MAX_TEXT) });
    } else if (event.type === "assistant/message") {
      const text = textOf(event.data?.message?.content);         // 只取正文，丢 reasoning
      if (text) buf.messages.push({ role: "assistant", content: text.slice(0, MAX_TEXT) });
    }
  });

  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (!retry.length) return;
      const batch = retry.splice(0, retry.length);
      for (const event of batch) {
        try {
          const r = await postCapture(auth, event);
          advanceWatermark(event.conversation_id, Number(String(event.event_id).split("#turn-")[1]));
          log(`RETRY-OK ${event.event_id} evidence=${r.evidenceId}`);
        } catch (e) {
          retry.push(event);
          log(`RETRY-FAIL ${event.event_id}: ${e.message}`);
        }
      }
    }, RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, "memory-capture: retry loop");

  log("INFO 实时记忆捕获已启动");
}

export { apply, inject, name };
