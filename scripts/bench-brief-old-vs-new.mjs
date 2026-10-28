// 同数据、同问题，in-process 对比：改前(621b08f 全量扫描) vs 改后(0acc142 候选粗筛)
// 目的：把"全量扫描到底多慢"这件事量准（我此前 HTTP 测到 300-415ms，开发 in-process 测到 57ms）
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const APP = "D:\\MemoryLib\\app\\memory-lib";
const DATA = "D:\\MemoryLib\\data";
const MEM = path.join(DATA, "memory");
const TMP = "D:\\MemoryLib\\index1-work\\bench-old";

// 1) 准备"改前"版本的模块目录：只把 recall.mjs 换成 621b08f 的版本
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const f of fs.readdirSync(path.join(APP, "src"))) {
  if (f.endsWith(".mjs")) fs.copyFileSync(path.join(APP, "src", f), path.join(TMP, f));
}
const oldRecall = execSync("git -C D:\\MemoryLib\\app show 621b08f:memory-lib/src/recall.mjs", { maxBuffer: 32 * 1024 * 1024 }).toString("utf8");
fs.writeFileSync(path.join(TMP, "recall.mjs"), oldRecall, "utf8");
console.log(`改前 recall.mjs 已导出 (${oldRecall.length} 字符)`);

const QS = [
  "记忆库是几层", "昨天做了什么", "RANK-1 验收结论", "排序与预算怎么改的", "完全无关的问题测试",
  "记忆库有几条", "谁负责验收", "提炼怎么触发的", "我们产品的定位是什么", "捕获链路现在用哪个通道",
  "最近三天有哪些验收结论", "10/10 那天聊了什么", "RANK-1 的排序规则是什么", "现在记忆库是几层来着",
  "接入了哪些记忆通道", "注入是怎么实现的", "为什么会有串味问题", "记忆库的层怎么划分",
  "备份是怎么做的", "验收不许放水是什么意思",
];

async function bench(label, modPath) {
  const mod = await import("file:///" + modPath.replace(/\\/g, "/") + "?v=" + Date.now());
  const lib = mod.createRecall({ dataRoot: MEM, workspaceRoot: DATA });
  const times = [];
  let first = null, srcs = new Set();
  for (let round = 0; round < 3; round++) {
    for (const q of QS) {
      const t0 = performance.now();
      const r = await lib.recallBrief({ query: q, format: "prompt", memoryOnly: true, memoryLimitChars: 600 });
      times.push(performance.now() - t0);
      if (!first) first = r;
      if (r?.candidate_source) srcs.add(r.candidate_source);
    }
  }
  times.sort((a, b) => a - b);
  const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(1);
  const mean = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);
  console.log(`${label.padEnd(22)} n=${times.length}  p50=${p(0.5)}ms  p90=${p(0.9)}ms  p95=${p(0.95)}ms  mean=${mean}ms  ${srcs.size ? "source=" + [...srcs].join("/") : ""}`);
  return { first, times };
}

const before = await bench("改前 全量扫描", path.join(TMP, "recall.mjs"));
const after = await bench("改后 候选粗筛", path.join(APP, "src", "recall.mjs"));

// 顺带对比"记忆库是几层"的答案首条
const pick = (r) => (r?.included ?? []).map((m) => m.id.replace("curated-shared-", "")).slice(0, 3).join(" ");
console.log("\n「记忆库是几层」首条：");
console.log("  改前:", pick(before.first));
console.log("  改后:", pick(after.first));
