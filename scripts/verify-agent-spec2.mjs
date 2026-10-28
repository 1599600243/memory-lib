// 复核 AGENT-SPEC-2（B1/B2/B3/B5/B6）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "D:\\MemoryLib";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec2-"));
const mfDir = path.join(tmp, "agents");
fs.mkdirSync(mfDir, { recursive: true });
const ID = "demo-agent";
const srcDir = path.join(tmp, "sessions");
fs.mkdirSync(srcDir, { recursive: true });

const manifest = {
  specVersion: 1, id: ID, displayName: "Demo Agent",
  read: { mode: "mcp", server: "memory", configPath: "~/.demo-agent/config.toml", credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "reader" },
  write: { mode: "transcript", source: "demo-agent", sources: [{ dirs: [srcDir], format: "jsonl", glob: "*.jsonl" }], credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "capture-ingest" },
  inject: "brief-on-demand", state: "discovered", notes: "",
};
fs.writeFileSync(path.join(mfDir, `${ID}.json`), JSON.stringify(manifest, null, 2), "utf8");

const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", "agent-scaffold.mjs"), ...args], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
};
const skillPath = path.join(os.homedir(), ".dsh", "skills", `memory-${ID}`, "SKILL.md");

// B1 dry-run
const dry = run(["--agent", ID, "--manifest-dir", mfDir]);
console.log(`B1 dry-run: exit=${dry.code}  输出 ${dry.out.length} 字`);
const mentioned = ["SKILL.md", "config", "verify", "manifest"].filter((k) => dry.out.toLowerCase().includes(k.toLowerCase()));
console.log(`   打印里提到的产物关键词: ${mentioned.join(", ")}`);
console.log(`   dry-run 后是否误落盘: ${fs.existsSync(skillPath) ? "❌ 已创建" : "✅ 没创建"}`);

// B2 内容检查（用 dry-run 输出）
const secretLeak = /\b(secret|password|token|apiKey|api_key|bearer)\b\s*[:=]\s*\S+/i.test(dry.out);
const dataPathLeak = /data[\\/]+memory/i.test(dry.out);
const hasBrief = /memory_recall_brief/.test(dry.out);
console.log(`B2 明文密钥形态: ${secretLeak ? "❌ 疑似" : "✅ 无"} | 记忆库数据路径: ${dataPathLeak ? "❌ 出现" : "✅ 无"} | 含 memory_recall_brief: ${hasBrief ? "✅" : "❌"}`);

// B1 --write
const w1 = run(["--agent", ID, "--manifest-dir", mfDir, "--write"]);
console.log(`\nB1 --write: exit=${w1.code}`);
const exists = fs.existsSync(skillPath);
console.log(`   SKILL.md 落盘: ${exists ? "✅ " + skillPath : "❌ 没生成"}`);
if (exists) {
  const s = fs.readFileSync(skillPath, "utf8");
  console.log(`   长度 ${s.length} 字；含 memory_recall_brief: ${/memory_recall_brief/.test(s) ? "✅" : "❌"}；含明文 secret: ${/\b(secret|apiKey)\b\s*[:=]\s*\S+/i.test(s) ? "❌" : "✅ 无"}；含 data\\memory: ${/data[\\/]+memory/i.test(s) ? "❌" : "✅ 无"}`);
  console.log(`   首 6 行:`);
  s.split("\n").slice(0, 6).forEach((l) => console.log("     " + l.slice(0, 100)));
}

// B3 幂等
const before = exists ? fs.readFileSync(skillPath, "utf8") : "";
const mtimeBefore = exists ? fs.statSync(skillPath).mtimeMs : 0;
const w2 = run(["--agent", ID, "--manifest-dir", mfDir, "--write"]);
const after = exists ? fs.readFileSync(skillPath, "utf8") : "";
const mtimeAfter = exists ? fs.statSync(skillPath).mtimeMs : 0;
console.log(`\nB3 幂等: exit=${w2.code} 内容相同=${before === after ? "✅" : "❌"} mtime未变=${mtimeBefore === mtimeAfter ? "✅" : "⚠️ 变了"}`);

// B5 从零重建
if (exists) fs.rmSync(path.dirname(skillPath), { recursive: true, force: true });
const w3 = run(["--agent", ID, "--manifest-dir", mfDir, "--write"]);
console.log(`B5 删掉重建: exit=${w3.code} 重新生成=${fs.existsSync(skillPath) ? "✅" : "❌"}`);

// B6 glob 缺省
fs.rmSync(mfDir, { recursive: true, force: true }); fs.mkdirSync(mfDir, { recursive: true });
const noGlob = JSON.parse(JSON.stringify(manifest));
delete noGlob.write.sources[0].glob;
fs.writeFileSync(path.join(mfDir, `${ID}.json`), JSON.stringify(noGlob, null, 2), "utf8");
let v = { code: -1, out: "" };
try { v = { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", "agent-discover.mjs"), "--validate", "--manifest-dir", mfDir], { cwd: REPO, encoding: "utf8" }) }; }
catch (e) { v = { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
console.log(`\nB6 缺 glob: exit=${v.code} ${v.code === 0 ? "✅ 默认 * 生效" : "❌ 仍报错: " + v.out.replace(/\s+/g, " ").slice(0, 100)}`);

// 清理（别把 demo 技能留在真 skills 目录）
if (fs.existsSync(path.dirname(skillPath))) fs.rmSync(path.dirname(skillPath), { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n清理: demo 技能已移除=${!fs.existsSync(path.dirname(skillPath))}`);
