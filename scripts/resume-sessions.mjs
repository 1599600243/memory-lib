// 重启 DSH 后自动把在册会话唤醒（因为重启会让所有会话 detach，session.cancel/prompt 会报 not attached）
// 用法：
//   node resume-sessions.mjs --snapshot <快照json>     # 重启后调用，逐条 ping
//   node resume-sessions.mjs --snapshot <快照json> --dry
import fs from "node:fs";
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:3080";
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const SNAP = arg("snapshot");
const DRY = argv.includes("--dry");
if (!SNAP || !fs.existsSync(SNAP)) { console.error("缺少 --snapshot 或文件不存在"); process.exit(2); }

const snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
const sessions = snap.sessions ?? [];

const rpc = async (method, payload) => {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
  });
  const t = await r.text();
  try { return { status: r.status, value: JSON.parse(t).result?.value ?? null, raw: t.slice(0, 200) }; }
  catch { return { status: r.status, value: null, raw: t.slice(0, 200) }; }
};

const PING = "【系统通知】DSH 刚重启过，你的会话需要重新挂载。**这一轮只回一句话：在线。** 不要做任何工作、不要读文件、不要执行命令、不要继续之前的任务。之后等下单人给你指令。";

let ok = 0, fail = 0;
for (const s of sessions) {
  const label = `${s.title ?? "(无标题)"} ${s.sessionId}`;
  if (DRY) { console.log("[dry]", label); continue; }
  const res = await rpc("session.prompt", { sessionId: s.sessionId, mode: "queue", content: [{ type: "text", text: PING }] });
  const accepted = res.value?.accepted === true;
  if (accepted) { ok++; console.log("✓ 唤醒", label); }
  else { fail++; console.log("✗ 失败", label, "→", res.status, res.raw); }
}

console.log(`\n唤醒结果：成功 ${ok} / 失败 ${fail}（共 ${sessions.length}）`);
if (fail > 0) process.exitCode = 1;
