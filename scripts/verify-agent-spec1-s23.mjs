// 产品岗独立复核 AGENT-SPEC-1：S2/S3（真接入一次 OpenClaw）+ S6（写盘后耦合检查）
// 全程用临时数据根 + 临时 manifest 目录 + 临时副本，不碰生产
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const REPO = "D:\\MemoryLib";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec-s2-"));
const dataRoot = path.join(tmp, "data");
const manifestDir = path.join(tmp, "agents");
const srcDir = path.join(tmp, "openclaw-sessions");
for (const d of [dataRoot, manifestDir, srcDir]) fs.mkdirSync(d, { recursive: true });

// 1) 拷一个真实 openclaw zstd 会话到临时目录（不 tail 生产目录）
const ocRoot = path.join(os.homedir(), ".openclaw", "agents");
const sample = execFileSync("powershell", ["-NoProfile", "-Command",
  `Get-ChildItem '${ocRoot}' -Recurse -File -Filter '*.zst' | Where-Object { $_.Length -gt 3KB } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }`,
], { encoding: "utf8" }).trim();
if (!sample) { console.error("找不到 openclaw .zst 样本"); process.exit(2); }
fs.copyFileSync(sample, path.join(srcDir, path.basename(sample)));
console.log(`样本: ${path.basename(sample)}  ${(fs.statSync(path.join(srcDir, path.basename(sample))).size / 1024).toFixed(1)}KB`);

// 2) 写一份 openclaw manifest 到临时目录（指向副本）
const manifest = {
  specVersion: 1, id: "openclaw", displayName: "OpenClaw",
  read: { mode: "mcp", server: "memory", configPath: "~/.openclaw/config.json", credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "reader" },
  write: { mode: "transcript", source: "openclaw", sources: [{ dirs: [srcDir], format: "jsonl-zst", glob: "*.zst" }], credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "capture-ingest" },
  inject: "brief-on-demand", state: "discovered", notes: "产品岗复核用临时 manifest",
};
fs.writeFileSync(path.join(manifestDir, "openclaw.json"), JSON.stringify(manifest, null, 2), "utf8");

// 3) 起临时数据根的服务（8797）
const srv = spawn(process.execPath, ["server.mjs", "--host", "127.0.0.1", "--port", "8797",
  "--data-root", dataRoot, "--workspace-root", tmp,
  "--registry", "D:\\MemoryLib\\data\\runtime\\identity.json",
  "--secrets-dir", "D:\\MemoryLib\\data\\runtime\\secrets",
  "--audit", path.join(tmp, "audit.jsonl"), "--secret-store", "wincred",
  "--calendar-timezone", "Asia/Shanghai", "--summary-index", "none",
  "--capture-agent-id", "pilot-01", "--capture-role-id", "capture-ingest",
], { cwd: path.join(REPO, "app", "memory-lib"), stdio: ["ignore", "pipe", "pipe"] });
let srvLog = "";
srv.stdout.on("data", (d) => { srvLog += d; });
srv.stderr.on("data", (d) => { srvLog += d; });
await new Promise((r) => setTimeout(r, 7000));
const up = await fetch("http://127.0.0.1:8797/v1/health").then((r) => r.status).catch(() => 0);
console.log(`临时服务 8797: HTTP ${up}`);

// 4) 第一次：--once --backfill --verify
const ct = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", "capture-tail.mjs"), ...args], { cwd: REPO, encoding: "utf8", env: { ...process.env, MEMORY_LIB_URL: "http://127.0.0.1:8797" }, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
};
const a = ct(["--agent", "openclaw", "--manifest-dir", manifestDir, "--once", "--backfill", "--verify", "--state", path.join(tmp, "state1.json")]);
console.log(`\nS2 第一次: exit=${a.code}`);
console.log(a.out.trim().split("\n").slice(-6).map((l) => "   " + l).join("\n"));
const ev = execFileSync("powershell", ["-NoProfile", "-Command",
  `Get-ChildItem '${dataRoot}' -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue | Select-String -Pattern 'source:\\s*"?openclaw' -List | ForEach-Object { $_.Path }`,
], { encoding: "utf8" }).trim();
console.log(`   evidence(source=openclaw): ${ev ? "✅ " + path.basename(ev.split("\n")[0]) : "❌ 没找到"}`);

// 5) 第二次：应 0 条
const b = ct(["--agent", "openclaw", "--manifest-dir", manifestDir, "--once", "--state", path.join(tmp, "state1.json")]);
const tail = b.out.trim().split("\n").slice(-3).join(" ");
console.log(`\nS3 第二次: exit=${b.code}  ${/提交 0|抽出 0/.test(tail) ? "✅ 幂等（0 条）" : "⚠️ " + tail.slice(0, 160)}`);

// 6) S6：写盘后 manifest 耦合检查
const discoverWrite = (() => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", "agent-discover.mjs"), "--agent", "openclaw", "--manifest-dir", manifestDir, "--write"], { cwd: REPO, encoding: "utf8" }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } })();
console.log(`\nS6 agent-discover --write: exit=${discoverWrite.code}`);
let coupled = 0;
for (const f of fs.readdirSync(manifestDir).filter((x) => x.endsWith(".json"))) {
  const src = fs.readFileSync(path.join(manifestDir, f), "utf8");
  if (/data[\\/]+memory/i.test(src)) { coupled++; console.log(`   ❌ ${f} 含记忆库路径`); }
}
console.log(`   manifest 含记忆库路径: ${coupled} 份 ${coupled === 0 ? "✅" : "❌"}`);

// 7) 有真实 evidence 时，manifest 应能从 discovered 升级
const st = JSON.parse(fs.readFileSync(path.join(manifestDir, "openclaw.json"), "utf8"));
console.log(`   manifest 现在的 state: ${st.state}（期望 verified 或 discovered，取决于实现是否在 --verify 时回写）`);

srv.kill();
fs.rmSync(tmp, { recursive: true, force: true });
