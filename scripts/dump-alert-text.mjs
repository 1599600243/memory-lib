// 拉出最近几条"疑似丢单"告警的**全文**，看是谁生成的
import fs from "node:fs";
import zlib from "node:zlib";
const SESSION = process.argv[2];
const st = fs.statSync(SESSION);
const n = Math.min(st.size, 6 * 1024 * 1024);
const buf = Buffer.alloc(n);
const fd = fs.openSync(SESSION, "r");
fs.readSync(fd, buf, 0, n, st.size - n);
fs.closeSync(fd);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
let all = "";
for (let k = 0; k < offs.length; k++) {
  const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
  try { all += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8"); } catch {}
}
const recs = all.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const hits = [];
for (const r of recs) {
  const s = JSON.stringify(r);
  if (!s.includes("疑似丢单")) continue;
  hits.push({ time: r.time, type: r.type, text: s });
}
console.log(`命中 ${hits.length} 条，最近 3 条全文：\n`);
for (const h of hits.slice(-3)) {
  console.log(`───────── ${new Date(h.time).toISOString()}  type=${h.type}`);
  // 尽量把 text 字段抽出来打印
  const m = /"text":"((?:[^"\\]|\\.)*)"/u.exec(h.text);
  if (m) {
    const txt = JSON.parse(`"${m[1]}"`);
    console.log(txt.slice(0, 900));
  } else {
    console.log(h.text.slice(0, 900));
  }
  console.log("");
}
