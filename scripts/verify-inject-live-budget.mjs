// F1 生产数据实测：用真实服务 + 真实数据，跑插件同一个函数，量整段字符数
import fs from "node:fs";
const mod = await import("file:///D:/MemoryLib/scripts/inject-context.mjs?" + Date.now());

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)[1].trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)[1].trim();
const principal = { agent_id: "pilot-01", role_id: "reader" };

const queries = [
  "我们上次讨论的注入预算是什么",
  "记忆库有几层",
  "DEPLOY-1 验收了哪些",
  "10月20日我们聊了什么",
  "B站 大肥鱼 记忆",
];
let min = Infinity, max = 0;
for (const q of queries) {
  const brief = await mod.fetchBrief({ url: "http://127.0.0.1:8787/v1/recall/brief", credentialRef: ref, secret, principal, query: q, timeoutMs: 3000 });
  const block = mod.buildInjectionBlock(brief.text, 600); if (brief.empty) console.log("    （服务返回空记忆）");
  const text = typeof block === "string" ? block : block?.text ?? "";
  const len = text.length;
  min = Math.min(min, len); max = Math.max(max, len);
  const items = brief.included?.length ?? null;
  console.log(`  ${String(len).padStart(4)} 字符  items=${items ?? "?"}  endsWithEllipsis=${text.trimEnd().endsWith("…")}  ${q}`);
}
console.log(`\nF1: min=${min} max=${max}  ${max <= 600 ? "✅ 全部 ≤600" : "❌ 有超预算"}`);


