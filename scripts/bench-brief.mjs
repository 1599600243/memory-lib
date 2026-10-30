// 量 brief 服务端耗时（同进程多次，排除 node 启动开销），并给出扩容外推
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const QS = [
  "记忆库是几层", "昨天做了什么", "RANK-1 验收结论", "排序与预算怎么改的",
  "完全无关的问题测试", "记忆库有几条", "谁负责验收", "提炼怎么触发的",
  "我们产品的定位是什么", "捕获链路现在用哪个通道",
];

const times = [];
for (let round = 1; round <= 2; round++) {
  for (const q of QS) {
    const t0 = performance.now();
    const r = await fetch("http://127.0.0.1:8787/v1/recall/brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential_ref: ref, secret,
        principal: { agent_id: "pilot-01", role_id: "reader" },
        format: "prompt", query: q, memory_only: true, memory_limit_chars: 600,
      }),
    });
    const j = await r.json();
    const ms = performance.now() - t0;
    times.push(ms);
    if (round === 1) console.log(`${q.padEnd(18)} ${ms.toFixed(0).padStart(4)}ms  命中${j.included?.length ?? 0}  used=${j.memory_used_chars ?? "-"}`);
  }
}
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(0);
const avg = times.reduce((a, b) => a + b, 0) / times.length;
console.log(`\n样本 ${times.length} 次：min ${times[0].toFixed(0)}ms | p50 ${p(0.5)}ms | p90 ${p(0.9)}ms | max ${times[times.length - 1].toFixed(0)}ms | 均值 ${avg.toFixed(0)}ms`);

const files = Number(process.argv[2] || 1441);
const perFile = avg / files;
console.log(`\n当前库量 ${files} 条 → 每次 brief 约 ${avg.toFixed(0)}ms（摊到每条 ${perFile.toFixed(3)}ms）`);
console.log("线性外推（插件侧 brief 超时是 3000ms，超了就整轮不注入）：");
for (const n of [2000, 5000, 8000, 10000, 20000, 50000]) {
  console.log(`  ${String(n).padStart(6)} 条 → 约 ${(perFile * n).toFixed(0)} ms  ${perFile * n > 3000 ? "⚠️ 超过 3000ms 预算" : ""}`);
}
