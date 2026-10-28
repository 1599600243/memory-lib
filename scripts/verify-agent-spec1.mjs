// 产品岗独立复核 AGENT-SPEC-1：S1/S4/S5/S6（不写生产）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "D:\\MemoryLib";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec1-"));
const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, "scripts", "agent-discover.mjs"), ...args], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") };
  }
};

// ── S1: schema 校验（坏 manifest 要报具体字段）──
const bad = path.join(tmp, "bad.json");
fs.writeFileSync(bad, JSON.stringify({ specVersion: 1, id: "bad agent!", displayName: "", read: { mode: "telepathy" }, write: { mode: "transcript" }, inject: "whatever", state: "nowhere" }), "utf8");
const s1 = run(["--validate", "--manifest-dir", tmp]);
const errText = (s1.out + s1.err).replace(/\s+/g, " ");
console.log(`S1 坏 manifest: exit=${s1.code}  ${s1.code !== 0 ? "✅ 拒绝" : "❌ 竟然通过"}`);
const fields = ["id", "read", "mode", "write", "inject", "state", "displayName"].filter((f) => errText.includes(f));
console.log(`   报出的字段名: ${fields.length ? fields.join(", ") : "（一个都没报 ❌）"}`);
console.log(`   原文片段: ${errText.slice(0, 220)}`);

// ── S4: 目录不存在不崩 ──
const s4 = run(["--agent", "codex", "--manifest-dir", tmp]);
const s4j = (() => { try { return JSON.parse(s4.out); } catch { return null; } })();
console.log(`\nS4 codex（~/.codex/sessions 不存在）: exit=${s4.code}  ${s4.code === 0 ? "✅ 未崩" : "❌ 崩了"}`);
console.log(`   state=${s4j?.state ?? "?"}  notes=${String(s4j?.notes ?? "").slice(0, 40)}`);

// ── S5: read 身份不能写捕获 ──
const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const r5 = await fetch("http://127.0.0.1:8787/v1/conversations/capture", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "pilot-01", role_id: "reader" }, source: "spectest", conversation_id: "c1", event_id: "e1", messages: [{ role: "user", content: "should be denied" }] }),
});
console.log(`\nS5 reader 写捕获: HTTP ${r5.status}  ${r5.status === 403 ? "✅ 拒绝" : "⚠️ 预期 403"}`);

// ── S6: manifest 不许出现记忆库路径 ──
const written = fs.readdirSync(tmp).filter((f) => f.endsWith(".json") && f !== "bad.json");
let coupled = 0;
for (const f of written) {
  const src = fs.readFileSync(path.join(tmp, f), "utf8");
  if (/data\\\\memory|data\\memory|D:\\\\MemoryLib\\\\data\\\\memory/i.test(src)) { coupled++; console.log(`   ❌ ${f} 出现记忆库路径`); }
}
console.log(`\nS6 检查 ${written.length} 份 manifest: 出现记忆库路径 ${coupled} 份 ${coupled === 0 ? "✅" : "❌"}`);
console.log(`   已写 manifest: ${written.join(", ") || "（无）"}`);
fs.rmSync(tmp, { recursive: true, force: true });
