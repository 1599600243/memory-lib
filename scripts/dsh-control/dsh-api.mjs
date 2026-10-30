// DSH 0.2.1-rc.2 Web API 客户端（Cookie 认证 + /api/<domain>/<action> 路径）
// Cookie 由 get-dsh-cookie.ps1 提取并落在 C:\Users\admin\.dsh\memory-capture\.dsh-web-cookie
// 用法：import { call, listSessions, prompt } from "./dsh-api.mjs"
import fs from "node:fs";
import crypto from "node:crypto";

const COOKIE_FILE = "C:\\Users\\admin\\.dsh\\memory-capture\\.dsh-web-cookie";
const BASE = "http://127.0.0.1:3080";

function cookie() {
  try { return fs.readFileSync(COOKIE_FILE, "utf8").trim(); }
  catch { throw new Error(`没有 Cookie 文件: ${COOKIE_FILE}（先跑 get-dsh-cookie.ps1）`); }
}

const toPath = (method) => "/api/" + String(method).replaceAll(".", "/");

export async function call(method, payload = {}, { timeoutMs = 60000, argName = "_request" } = {}) {
  const rpcId = crypto.randomUUID();
  const wire = String(method).replaceAll(".", "/"); // 0.2.1: body 里的 method 也必须用斜杠形式
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + toPath(method), {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie() },
      body: JSON.stringify({ type: "client-request", rpcId, method: wire, payload: { args: { [argName]: payload } } }),
      signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} → HTTP ${r.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    if (!j.result?.ok) throw new Error(`${method} → 业务失败 ${JSON.stringify(j.result).slice(0, 300)}`);
    return j.result.value;
  } finally { clearTimeout(timer); }
}

export async function listSessions() {
  const v = await call("session.list", {});
  return v?.items ?? v?.sessions ?? [];
}

export async function history(sessionId, { limit = 6 } = {}) {
  const v = await call("session.history", { sessionId, limit });
  return v;
}

// 0.2.1 的真实形状（host-apiproxy sessions.schema.js: sessionPromptRequestSchema）
//   { sessionId, mode: 'queue'|'steer', content: [{type:'text', text}], clientTimeZone? }
export async function prompt(sessionId, text, { mode = "queue", argName = "request" } = {}) {
  const payload = { requestId: crypto.randomUUID(), sessionId, mode, content: [{ type: "text", text }], clientTimeZone: "Asia/Shanghai" };
  return call("session.prompt", payload, { timeoutMs: 30000, argName });
}

export async function cancel(sessionId) {
  return call("session.cancel", { sessionId });
}

// 直接跑：列出会话
const entry = process.argv[1] ? `file:///${process.argv[1].replace(/\\/g, "/")}` : "";
if (entry && import.meta.url === entry) {
  const items = await listSessions();
  console.log(`会话 ${items.length} 个`);
  const k = Object.keys(items[0] ?? {});
  console.log("字段: " + k.join(", "));
  for (const s of items.slice(0, 5)) console.log("  " + JSON.stringify(s).slice(0, 220));
}




