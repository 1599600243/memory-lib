// INDEX 系里程碑的验收语料（176 问）的**生成器** —— 这是"可复现的验收基准"的源头，不要手改 jsonl。
//
//   node scripts/index-acceptance-corpus-176.mjs [--out reports/INDEX-1-acceptance-corpus-176.jsonl]
//
// 背景（为什么要这份文件）：
//   2026-10-21 我做 INDEX-1 验收时，176 个攻点问句只存在于临时目录 index1-v2/，用完即删，
//   没有进版本库。结果 INDEX-2 开发岗无法拿到原始问句，只能按报告里的描述重建一套，
//   其报告只能标 STATUS: WIP。从本文件起，这批问句成为**入库的固定基准**：
//   谁都可以用同一条命令重新生成完全一样的 176 行。
//
// 结构（构造口径见 reports/INDEX-1-acceptance-report.md §1 与 INDEX-2 验收报告 §1；
//   注意：原始 176 条文本已经丢失，这里是**重建版**，与原始那一批次数字不同，见 §1 说明）：
//   A 批 72 = 12 个两字关键词 × 6 种填充。填充由**≤2 字的连续段**组成，因此
//            trigramPieces() 切不出任何 ≥3 字片段 ⇒ INDEX-1 只能回退全量。
//            这一批检验的是"索引帮不上忙时有没有把结果搞坏"（安全网）。
//   B 批 84 = 14 个关键词 × 6 个"会命中一堆无关记忆"的句式（选法见下面的注释）。
//   20 问  = index1-work/questions.json 原文照搬（INDEX-1 当时的 I1 对比集，一字不改）。
//
// 每条记录的字段：{ id, query, batch, keyword }。I1 批的 batch 记作 "i1-<原分类>"。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  return process.argv[i + 1] ?? dflt;
};

const OUT = String(arg("out", path.join(REPO, "reports", "INDEX-1-acceptance-corpus-176.jsonl")));
// 生成器**只读**被测代码当前实现的切词逻辑用来标自检位；语料内容本身不依赖它。
const CAND_SRC = String(arg("src", path.join(REPO, "app", "memory-lib", "src")));
const { trigramPieces, twoCharacterTokens } = await import(pathToFileURL(path.join(CAND_SRC, "recall-candidates.mjs")).href);

// ---- A 批：12 个两字关键词 ------------------------------------------------
const A_KEYS = ["8层", "验收", "提炼", "注入", "隔离", "排序", "证据", "日期", "记忆", "结论", "口径", "回滚"];
// 6 种填充：全部由 ≤2 字的 CJK 段 / ≤2 字符的拉丁段组成（空格分隔，保证不出现 3 字滑窗）
const A_FILLERS = [
  "{k} 是 什么",
  "{k} 在 哪",
  "{k} 怎 样",
  "{k} 呢",
  "{k} 是 啥",
  "{k} 有 用 吗",
];

// ---- B 批：14 个关键词 ----------------------------------------------------
const B_KEYS = ["验收", "提炼", "注入", "隔离", "排序", "证据", "结论", "回滚", "口径", "日期", "8层", "记录", "状态", "基线"];
// 6 个句式。**选法不是凑数字，而是按"这批问句要能打出什么"来定的**：
// 我 2026-10-22 用 12 个候选句式 × 14 关键词实测了每个句式在 INDEX-1 下的行为
// （探针 index2-v2/probe-tpl.mjs，读数见 INDEX-2 验收报告 §1），据此留三类各 2 个：
//   (a) 走索引路且只动尾部：候选池 7~10 ≥ 注入位数 ⇒ 不看回退；
//   (b) 走索引路且整条首条被漏：full 首条是一条"用户判据"样板记忆，它不含任何 ≥3 字片段；
//   (c) 走全量回退（安全网）：句式里的片段在库里几乎不存在 ⇒ 候选池空。
const B_TEMPLATES = [
  "我们上次讨论{k}的结论是什么", // (a) 索引路 14/14，仅尾部不同 14/14
  "{k}这条现在的结论和状态是什么", // (a) 索引路 14/14，仅尾部 13、首条被改 1
  "上次讨论{k}的时候得出了什么", // (b) 索引路 14/14，首条被整条漏掉 13/14
  "最近三天有哪些{k}结论", // (b)+(c) 「最近三天」家族；验收那条是 INDEX-1 漏 236c3048 的原型
  "之前是不是已经定过{k}的口径了", // (c) 多数回退全量，个别走索引动尾部
  "上次定的{k}口径还算数吗", // (c) 少数走索引（池 6），尾部被动过
];

const rows = [];
let seq = 0;
for (const keyword of A_KEYS) {
  for (const filler of A_FILLERS) {
    seq += 1;
    rows.push({ id: `a-${String(seq).padStart(2, "0")}`, query: filler.replace("{k}", keyword), batch: "A-两字薄池", keyword });
  }
}
seq = 0;
for (const keyword of B_KEYS) {
  for (const template of B_TEMPLATES) {
    seq += 1;
    rows.push({ id: `b-${String(seq).padStart(2, "0")}`, query: template.replace("{k}", keyword), batch: "B-噪声句式", keyword });
  }
}
const i1 = JSON.parse(fs.readFileSync(path.join(REPO, "index1-work", "questions.json"), "utf8"));
for (const item of i1) rows.push({ id: item.id, query: item.q, batch: `i1-${item.cat}`, keyword: null });

// ---- 自检：口径不成立就直接失败，绝不悄悄生成一份"看起来一样"的语料 ----
const problems = [];
for (const row of rows) {
  const pieces = trigramPieces(row.query);
  const twoChars = twoCharacterTokens(row.query);
  if (row.batch === "A-两字薄池") {
    // 唯一硬口径：**切不出 ≥3 字片段** ⇒ INDEX-1 的 trigram 粗筛必然回退全量。
    // 两字 token 本来就该在（关键词就是两字词），INDEX-2 的 LIKE 补候选正是针对它。
    if (pieces.length !== 0) problems.push(`A 批 ${row.id} 切出了 ≥3 字片段 ${JSON.stringify(pieces)}：${row.query}`);
    if (twoChars.length === 0 && row.keyword !== "8层") problems.push(`A 批 ${row.id} 连两字 token 都没有：${row.query}`);
  }
  if (row.batch === "B-噪声句式" && pieces.length < 4) problems.push(`B 批 ${row.id} 片段太少(${pieces.length})：${row.query}`);
}
const count = (batch) => rows.filter((r) => r.batch === batch).length;
const summary = {
  total: rows.length,
  A: count("A-两字薄池"),
  B: count("B-噪声句式"),
  I1: rows.length - count("A-两字薄池") - count("B-噪声句式"),
};
console.log(`总数 ${summary.total} = A ${summary.A} + B ${summary.B} + I1 ${summary.I1}`);
if (summary.total !== 176) problems.push(`总数不是 176：${summary.total}`);
if (summary.A !== 72) problems.push(`A 批不是 72：${summary.A}`);
if (summary.B !== 84) problems.push(`B 批不是 84：${summary.B}`);
if (problems.length) {
  console.error(`口径自检失败 ${problems.length} 条：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

fs.writeFileSync(OUT, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
console.log(`已写 ${OUT}（${rows.length} 行）`);
console.log(`A 批关键词 ${A_KEYS.length} 个：${A_KEYS.join(" ")}`);
console.log(`B 批关键词 ${B_KEYS.length} 个：${B_KEYS.join(" ")}`);
