// 重启前抓「在册会话快照」：非 blank + 最近 6 小时有活动
// 用法：node snapshot-sessions.mjs <输出json路径>
import fs from "node:fs";
import crypto from "node:crypto";

const out = process.argv[2];
if (!out) { console.error("用法: node snapshot-sessions.mjs <输出json>"); process.exit(2); }

const r = await fetch("http://127.0.0.1:3080/api/session.list", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: "session.list", payload: {} }),
});
const j = await r.json();
const items = j?.result?.value?.items ?? [];
const cutoff = Date.now() - 6 * 3600 * 1000;
const keep = items
  .filter((s) => !s.blank && (s.updatedAt ?? 0) > cutoff)
  .map((s) => ({ sessionId: s.sessionId, title: s.title ?? null, updatedAt: s.updatedAt ?? null }));

fs.mkdirSync(out.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), total: items.length, sessions: keep }, null, 2), "utf8");
console.log(`snapshot: ${keep.length}/${items.length} sessions kept → ${out}`);
