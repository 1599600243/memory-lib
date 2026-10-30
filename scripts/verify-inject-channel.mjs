// 重启后验证 F2：注入声明 channel=inject，非注入仍是 localhost（正对照）
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)[1].trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)[1].trim();
const principal = { agent_id: "pilot-01", role_id: "reader" };
const q = { credential_ref: ref, secret, principal, query: "通道验证用的唯一标记 zz-inject-channel-check", memory_only: true };

async function brief(extraHeaders) {
  const r = await fetch("http://127.0.0.1:8787/v1/recall/brief", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(q),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const inject = await brief({ "X-Memory-Channel": "inject" });
console.log(`注入声明调用: HTTP ${inject.status}  chars=${inject.body?.sections?.["近期记忆"]?.length ?? "?"}`);

const plain = await brief({});
console.log(`普通调用(无声明): HTTP ${plain.status}`);

// 等审计落盘
await new Promise((r) => setTimeout(r, 1200));

const audit = await fetch("http://127.0.0.1:8787/v1/admin/audit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential_ref: ref, secret, principal: { agent_id: "admin-01", role_id: "librarian-admin" }, limit: 50 }),
}).then((r) => r.json());

const rows = (audit.events ?? []).filter((e) => e.action === "recall_brief").slice(0, 8);
console.log("\n最近 recall_brief 审计（前 8 条）：");
for (const e of rows) console.log(`  ${e.channel?.padEnd(10) ?? "?"} resourceId=${String(e.resourceId).slice(0, 24)}`);

const injectRow = rows.find((e) => e.channel === "inject");
const localhostRow = rows.find((e) => e.channel === "localhost");
console.log(`\nF2-a 出现 channel=inject: ${injectRow ? "✅ " + JSON.stringify({ action: injectRow.action, channel: injectRow.channel, resourceId: injectRow.resourceId }) : "❌ 没有"}`);
console.log(`F2-b 非注入仍是 localhost: ${localhostRow ? "✅ 正对照成立" : "⚠️ 没看到 localhost 行（可能被 inject 挤掉，稍后复验）"}`);
