// 复核 CONSOLE-1 的内联模块一致性 + 线上页面可用性（免重启，逐请求读盘）
import fs from "node:fs";

const html = fs.readFileSync("D:\\MemoryLib\\app\\memory-lib\\web\\console.html", "utf8");
const at = html.indexOf("data:text/javascript;base64,");
if (at < 0) { console.log("❌ 找不到内联模块"); process.exit(1); }
const b64 = html.slice(at + "data:text/javascript;base64,".length).match(/^[A-Za-z0-9+/=]+/)[0];
const inlined = Buffer.from(b64, "base64").toString("utf8");
const file = fs.readFileSync("D:\\MemoryLib\\app\\memory-lib\\web\\console-agents.mjs", "utf8");
console.log(`内联 ${inlined.length} 字符 / 文件 ${file.length} 字符`);
console.log(`逐字节一致: ${inlined === file ? "✅" : "❌ UI 跑的不是被测试的那份"}`);
if (inlined !== file) {
  const a = inlined.split("\n"), b = file.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.log(`首个差异 第 ${i + 1} 行`); console.log("  内联: " + String(a[i]).slice(0, 120)); console.log("  文件: " + String(b[i]).slice(0, 120)); break; }
  }
}

const r = await fetch("http://127.0.0.1:8787/");
const t = await r.text();
console.log(`\n线上页面: HTTP ${r.status} len=${t.length}`);
console.log(`  tab-agents: ${t.includes("tab-agents") ? "✅" : "❌"}`);
console.log(`  data-tab="agents": ${t.includes('data-tab="agents"') ? "✅" : "❌"}`);
console.log(`  importmap: ${t.includes("importmap") ? "✅" : "❌"}`);
console.log(`  Cache-Control: ${r.headers.get("cache-control") ?? "-"}`);
