// 构造检索评测集：问题用自然语言（不含原文整句），ground truth = 首段含该主题的文件。
// 用途：量 recall@5 / MRR，作为换模型或加 rerank 前的基线。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_ROOT = process.env.MEMORY_DATA_ROOT || "D:/MemoryLib/data/memory";
const SHARED = path.join(DATA_ROOT, "curated", "shared");
const OUT = path.join(ROOT, "eval", "retrieval-20261031.json");

const QUESTIONS = [
  ["MAINT7 的独立验收结论是什么", "MAINT7"],
  ["MAINT6 专项通过了多少项", "MAINT6"],
  ["时区配置 TZ-CONFIG-1 的根因在哪", "TZ-CONFIG-1"],
  ["NAPCAT-2 工作流 C 交付了哪些提交", "NAPCAT-2"],
  ["身份只能由服务端从凭据解析这条裁决的具体内容", "身份（role_id"],
  ["调研 Duckling 和 chrono-node 时对资料来源的要求", "Duckling"],
  ["审查 agent-scaffold 时要重点看第三方密钥是否泄漏", "agent-scaffold"],
  ["CAPTURE-ATTR-2 对无归属捕获做了什么", "CAPTURE-ATTR-2"],
  ["ATOMICWRITE-1 原子写的改动", "ATOMICWRITE-1"],
  ["INDEX-2 的 p50 和 p95 性能预算是多少", "INDEX-2"],
  ["VISIBILITY-UNKNOWN-1 为什么不通过", "VISIBILITY-UNKNOWN-1"],
  ["WRITE-DENY-1 被拒绝的那次验收", "WRITE-DENY-1-REJECT1"],
  ["RETRIEVAL-1 真实 capture 的原文检索问题", "RETRIEVAL-1"],
  ["IN-PLUGIN-4 两处部署副本的问题", "IN-PLUGIN-4"],
  ["REFINE-LOOP-1 回归门为什么没过", "REFINE-LOOP-1"],
  ["MAINPATH-1 产品门不通过的原因", "MAINPATH-1-REJECT1"],
  ["M2.0 的 health 指标和巡检报告问题", "M2.0"],
  ["MEM-WRITE-1 给 MCP 写入加了什么", "MEM-WRITE-1"],
  ["MAINT8 的 mechanical fallback 是什么", "MAINT8"],
  ["D29 直接写入迁移相关记录", "D29"],
  ["REFINE-1 capture 响应新增了什么", "REFINE-1"],
  ["MEM-WRITE-1 验收通过了吗", "MEM-WRITE-1 做独立验收"],
  ["MAINT5 的 timer 和 health 验收细节", "MAINT5"],
  ["M1.6 增量索引和全量删除检测", "M1.6"],
];

async function main() {
  const files = (await fs.readdir(SHARED)).filter((name) => name.endsWith(".md"));
  const heads = new Map();
  for (const name of files) {
    const text = await fs.readFile(path.join(SHARED, name), "utf8");
    const body = text.split(/^---$/m).slice(2).join("---");
    heads.set(name, body.slice(0, 400));
  }
  const items = [];
  const missing = [];
  for (const [query, marker] of QUESTIONS) {
    const hits = [...heads.entries()].filter(([, head]) => head.includes(marker)).map(([name]) => name);
    if (!hits.length) { missing.push(marker); continue; }
    // ground truth 是集合：同一主题常有多篇正确记录（例如 MAINT7 既有验收结论也有 hint-recovery 记录）
    items.push({ id: `q${String(items.length + 1).padStart(2, "0")}`, query, expected: hits.map((name) => path.posix.join("curated/shared", name)) });
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), dataRoot: DATA_ROOT, items }, null, 2)}\n`, "utf8");
  console.log(`写入 ${OUT}：${items.length} 条${missing.length ? `；未找到 ground truth 的关键词: ${missing.join(", ")}` : ""}`);
}
main().catch((error) => { console.error(error); process.exit(1); });
