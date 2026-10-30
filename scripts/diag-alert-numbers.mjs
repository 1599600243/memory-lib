// diag-alert-numbers.mjs —— 对账：触发器日志里的丢单告警 vs 我会话里实际收到的
// 目的：判断"验收岗疑似丢单"到底是实时生成（说明 hold 失效）还是排队旧件/转发重算。
import fs from "node:fs";
import zlib from "node:zlib";

const LOG = "D:\\MemoryLib\\reports\\handoff.log";
const SESSION = process.argv[2];

// 1) 日志里的 DROPPED 序列
const logLines = fs.readFileSync(LOG, "utf8").split(/\r?\n/u).filter((l) => l.includes("ACCEPTANCE-DROPPED "));
const logSeries = [];
for (const l of logLines) {
  const t = l.slice(0, 24);
  const m = /已交接 (\d+) 分钟/u.exec(l);
  if (m) logSeries.push({ at: t, mins: Number(m[1]) });
}
console.log(`=== 日志里的丢单告警：共 ${logSeries.length} 条`);
for (const x of logSeries.slice(-6)) console.log(`   ${x.at}  ${x.mins} 分钟`);
if (logSeries.length) console.log(`   最后一条：${logSeries[logSeries.length - 1].at}（${logSeries[logSeries.length - 1].mins} 分钟）`);

// 2) 我会话里实际收到的（从 transcript 解 zstd）
function readZstdTail(file, tailBytes = 8 * 1024 * 1024) {
  const st = fs.statSync(file);
  const n = Math.min(st.size, tailBytes);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, buf, 0, n, st.size - n);
  fs.closeSync(fd);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
  let all = "";
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { all += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8"); } catch {}
  }
  return all;
}

if (!SESSION) { console.log("\n（未给会话文件路径，跳过第 2 步）"); process.exit(0); }
const raw = readZstdTail(SESSION);
const recs = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const got = [];
for (const r of recs) {
  const s = JSON.stringify(r);
  if (!s.includes("验收岗疑似丢单")) continue;
  const m = /最早 (\d+) 分钟前交接/u.exec(s);
  const idle = /静默：?(\d+) 分钟/u.exec(s);
  if (m) got.push({ time: r.time ? new Date(r.time).toISOString() : "?", mins: Number(m[1]), idle: idle ? Number(idle[1]) : null });
}
console.log(`\n=== 我会话里收到的丢单告警：共 ${got.length} 条`);
for (const x of got.slice(-8)) console.log(`   ${x.time}  交接 ${x.mins} 分钟 / 静默 ${x.idle ?? "?"} 分钟`);

console.log("\n=== 对账 ===");
const logMins = new Set(logSeries.map((x) => x.mins));
const phantom = got.filter((x) => !logMins.has(x.mins));
console.log(`   日志里有：${[...logMins].slice(-8).join(", ")}`);
console.log(`   会话里收到：${got.map((x) => x.mins).slice(-8).join(", ")}`);
console.log(phantom.length ? `   ⚠️ 会话里有 ${phantom.length} 条在日志中**不存在**（${phantom.map((x) => x.mins).join(", ")}）⇒ 不是触发器实时生成` : "   ✅ 会话里收到的每条都能在日志里找到 ⇒ 都是触发器实时生成的");
