// 直连 brief 接口，看"这个问题"到底取回了什么 —— 完全复刻插件的调用方式
// 用法: node brief-probe.mjs "<query>" [maxChars]
import fs from "node:fs";

const q = process.argv[2];
const maxChars = Number(process.argv[3] || 600);
const yml = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const r = await fetch("http://127.0.0.1:8787/v1/recall/brief", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    credential_ref: ref,
    secret,
    principal: { agent_id: "pilot-01", role_id: "reader" },
    format: "prompt",
    query: q,
    memory_only: true,
    memory_limit_chars: maxChars,
  }),
});
console.log("HTTP", r.status);
const t = await r.text();
let j = null;
try { j = JSON.parse(t); } catch {}
if (!j) { console.log(t.slice(0, 900)); process.exit(0); }
const ms = j.included ?? j.memories ?? [];
console.log(`命中条目: ${ms.length}`);
for (const m of ms) {
  console.log(`  · ${m.id}  ${m.calendarDate ?? ""}`);
}
const block = j.block ?? j.text ?? j.brief ?? "";
console.log(`\n──── 实际注入文本（${String(block).length} 字）────`);
console.log(String(block));
