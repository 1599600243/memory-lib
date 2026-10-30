// 读取 Chrome/Edge 的 Cookies SQLite：先列名字；给了 CHROME_KEY(hex) 就解密 v10/v11
import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = process.argv[2];
if (!dir) { console.error("用法: node chrome-cookie.mjs <Cookies 所在目录> [hostFilter]"); process.exit(1); }
const hostFilter = process.argv[3] ?? "";
const keyHex = process.env.CHROME_KEY ?? "";

const db = new DatabaseSync(path.join(dir, "Cookies"), { readOnly: true });
const cols = db.prepare("PRAGMA table_info(cookies)").all().map((c) => c.name);
const hasValue = cols.includes("value");

const rows = db.prepare(
  `SELECT host_key, name, path, CAST(expires_utc AS TEXT) AS expires_utc, is_httponly, is_secure${hasValue ? ", value" : ""}, hex(encrypted_value) AS ev
   FROM cookies
   ${hostFilter ? "WHERE host_key LIKE '%' || ? || '%'" : ""}
   ORDER BY host_key, name`
).all(...(hostFilter ? [hostFilter] : []));

console.log(`列: ${cols.join(",")}`);
console.log(`匹配 ${rows.length} 条${hostFilter ? `（host 含 "${hostFilter}"）` : ""}`);

function decrypt(evHex, hostKey) {
  if (!keyHex) return null;
  const buf = Buffer.from(evHex, "hex");
  if (buf.length < 3 + 12 + 16) return null;
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return `[未知前缀 ${prefix}]`;
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(15, buf.length - 16);
  const key = Buffer.from(keyHex, "hex");
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  let out = Buffer.concat([d.update(ct), d.final()]);
  // 新版 Chrome 在明文前塞了 32 字节 SHA256(host_key)
  const h = crypto.createHash("sha256").update(hostKey).digest();
  if (out.length > 32 && out.subarray(0, 32).equals(h)) out = out.subarray(32);
  return out.toString("utf8");
}

for (const r of rows) {
  const plain = hasValue && r.value ? `value=${r.value}` : "";
  let dec = "";
  if (!plain && keyHex) {
    try { dec = `decoded=${decrypt(r.ev, r.host_key)}`; }
    catch (e) { dec = `decode-failed=${e.message}`; }
  }
  if (process.argv.includes("--pair")) {
    if (!dec.startsWith("decoded=")) continue;
    console.log(`${r.name}=${dec.slice("decoded=".length)}`);
    continue;
  }
  console.log(`  ${String(r.host_key).padEnd(22)} ${String(r.name).padEnd(30)} len=${r.ev ? r.ev.length / 2 : 0} httponly=${r.is_httponly} secure=${r.is_secure} ${plain} ${dec}`);
}
