// 复核 AGENT-SPEC-1b 的 6 条（v1.1 新规）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "D:\\MemoryLib";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec1b-"));
const run = (file, args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", file), ...args], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
};
const validate = (obj, name) => {
  const f = path.join(tmp, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(obj, null, 1), "utf8");
  return run("agent-discover.mjs", ["--validate", "--manifest-dir", tmp]);
};
const base = (over = {}) => ({
  specVersion: 1, id: "demo-agent", displayName: "Demo",
  read: { mode: "mcp", server: "memory", configPath: "~/.demo/config.json", credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "reader" },
  write: { mode: "transcript", source: "demo", sources: [{ dirs: ["~/.demo/sessions"], format: "jsonl", glob: "*.jsonl" }], credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "capture-ingest" },
  inject: "brief-on-demand", state: "discovered", notes: "",
  ...over,
});

// 1) id kebab-case
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
let r = validate(base({ id: "bad agent!" }), "a");
console.log(`1) id="bad agent!" → exit=${r.code} ${r.code !== 0 && /id|kebab/i.test(r.out) ? "✅ 拒绝" : "❌ 通过/未点名"}`);

// 2) hook 形态（sources 缺省）
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
r = validate(base({ write: { mode: "hook", source: "demo", credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "capture-ingest" } }), "h");
console.log(`2) write.mode=hook 无 sources → exit=${r.code} ${r.code === 0 ? "✅ 通过" : "❌ 被误拒: " + r.out.replace(/\s+/g, " ").slice(0, 100)}`);

// 3) read.mode=none
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
r = validate(base({ read: { mode: "none" } }), "n");
console.log(`3) read.mode=none 无五字段 → exit=${r.code} ${r.code === 0 ? "✅ 通过" : "❌ 被误拒: " + r.out.replace(/\s+/g, " ").slice(0, 100)}`);

// 4) 明文密钥
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
r = validate({ ...base(), secret: "sk-abcdef0123456789" }, "s");
console.log(`4) 顶层 secret 明文 → exit=${r.code} ${r.code !== 0 && /secret/i.test(r.out) ? "✅ 拒绝并点名" : "❌ 通过/未点名"}`);

// 5) capture-tail --help 不进守护
const st = path.join(tmp, "state.json");
const h = (() => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", "capture-tail.mjs"), "--help"], { cwd: REPO, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { code: e.status ?? "timeout", out: String(e.stdout ?? "") + String(e.stderr ?? "") }; } })();
console.log(`5) capture-tail --help → exit=${h.code} ${/用法|usage|Usage/.test(h.out) && h.code === 0 ? "✅ 打用法" : "❌ 无用法/超时"}`);
console.log(`   输出首行: ${h.out.trim().split("\n")[0].slice(0, 80)}`);

// 6) 抽不出消息：偏移不许前进 + WARN
const dir = path.join(tmp, "bad-src"); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "junk.jsonl"), '{"hello":"world"}\n{"nope":1}\n', "utf8");
const mf = path.join(tmp, "mf"); fs.mkdirSync(mf, { recursive: true });
fs.writeFileSync(path.join(mf, "demo.json"), JSON.stringify(base({ write: { mode: "transcript", source: "demo", sources: [{ dirs: [dir], format: "jsonl", glob: "*.jsonl" }], credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "capture-ingest" } })), null, 1);
const args = ["--agent", "demo", "--manifest-dir", mf, "--once", "--backfill", "--state", st];
const a1 = run("capture-tail.mjs", args);
const off1 = (() => { try { const s = JSON.parse(fs.readFileSync(st, "utf8")); return Object.values(s)[0]?.offset ?? null; } catch { return null; } })();
const a2 = run("capture-tail.mjs", [...args, "--state", st]);
const off2 = (() => { try { const s = JSON.parse(fs.readFileSync(st, "utf8")); return Object.values(s)[0]?.offset ?? null; } catch { return null; } })();
const warned = /WARN.*unparsable/i.test(a1.out + a2.out);
console.log(`6) 抽不出消息: exit=${a1.code}, offset ${off1} → ${off2}, WARN=${warned ? "有" : "无"}`);
console.log(`   ${off1 === 0 || off1 === null ? "✅ 偏移没前进" : "❌ 偏移前进了（会永久跳过）"} | ${warned ? "✅ 有 WARN" : "❌ 无 WARN"}`);
console.log(`   末行: ${a1.out.trim().split("\n").slice(-1)[0].slice(0, 120)}`);

fs.rmSync(tmp, { recursive: true, force: true });

