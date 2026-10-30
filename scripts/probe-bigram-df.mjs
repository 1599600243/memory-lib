// 量两字词在索引里的 df（文档频率），判断能否用 df 阈值区分"主题词"与"停用词"
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("D:\\MemoryLib\\data\\memory\\indexes\\sqlite\\memory-lib-index.sqlite", { readOnly: true });
const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recall_df_bigrams'").get();
if (!has) { console.log("没有 recall_df_bigrams 表"); process.exit(1); }

const cols = db.prepare("PRAGMA table_info(recall_df_bigrams)").all().map((c) => c.name);
console.log("列: " + cols.join(", "));
const sample = db.prepare("SELECT * FROM recall_df_bigrams LIMIT 2").all();
console.log("样例: " + JSON.stringify(sample));

const topical = ["验收", "提炼", "注入", "隔离", "排序", "回滚", "日期", "记录", "状态", "基线", "记忆", "层数", "捕获", "检索", "索引"];
const stop = ["什么", "我们", "这个", "时候", "一下", "现在", "怎么", "哪些", "可以", "已经", "上次", "讨论"];

function dfOf(term) {
  // 列名自适应：找 token/term 列
  const tcol = cols.find((c) => /token|term|bigram|key/i.test(c)) ?? cols[0];
  const dcol = null;
  const row = dcol
    ? db.prepare(`SELECT ${dcol} AS d FROM recall_df_bigrams WHERE ${tcol} = ?`).get(term)
    : db.prepare(`SELECT COUNT(*) AS d FROM recall_df_bigrams WHERE ${tcol} = ?`).get(term);
  return row?.d ?? 0;
}

const total = db.prepare("SELECT COUNT(DISTINCT file_id) AS c FROM recall_df_bigrams").get()?.c ?? 1477;
console.log(`\n文档总数: ${total}\n`);
console.log("主题词 df:");
for (const t of topical) console.log(`  ${t}  df=${dfOf(t)}`);
console.log("\n停用词/高频词 df:");
for (const t of stop) console.log(`  ${t}  df=${dfOf(t)}`);

