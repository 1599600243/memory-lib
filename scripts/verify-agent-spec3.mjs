// 复核 AGENT-SPEC-3：P1–P4、R1–R3（隔离 HOME/skills/manifest，不碰真目录）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "D:\\MemoryLib";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spec3-"));
const mfDir = path.join(tmp, "agents");
const skillsDir = path.join(tmp, "skills");
fs.mkdirSync(mfDir, { recursive: true });
fs.mkdirSync(skillsDir, { recursive: true });
const env = { ...process.env, DSH_SKILLS_DIR: skillsDir };
const run = (file, args, extraEnv = {}) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, "scripts", file), ...args], { cwd: REPO, encoding: "utf8", env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
};

const mk = (id, readOver = {}, writeOver = {}) => {
  const m = {
    specVersion: 1, id, displayName: id,
    read: { mode: "mcp", server: "memory", configPath: path.join(tmp, `${id}.cfg`), credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "reader", ...readOver },
    write: { mode: "transcript", source: id, sources: [{ dirs: [path.join(tmp, "s")], format: "jsonl", glob: "*.jsonl" }], credentialRef: "memory-lib/deepseek-harness", agent: "pilot-01", role: "capture-ingest", ...writeOver },
    inject: "brief-on-demand", state: "discovered", notes: "",
  };
  fs.writeFileSync(path.join(mfDir, `${id}.json`), JSON.stringify(m, null, 2), "utf8");
  return m;
};

// P1: 四种 apply 形态
const cases = {
  openclaw: { kind: "cli", command: "openclaw mcp add memory --command <node> --arg <launcher>", verifyCommand: "openclaw mcp list" },
  codex: { kind: "config", format: "toml", configPath: "~/.codex/config.toml" },
  claude: { kind: "config", format: "json", configPath: "~/.claude.json" },
  manual: { kind: "manual" },
};
for (const [id, apply] of Object.entries(cases)) {
  mk(id, { apply, configPath: apply.configPath ?? path.join(tmp, `${id}.cfg`) });
  const r = run("agent-scaffold.mjs", ["--agent", id, "--manifest-dir", mfDir, "--write"]);
  const out = r.out;
  const skill = path.join(skillsDir, `memory-${id}`, "SKILL.md");
  const body = fs.existsSync(skill) ? fs.readFileSync(skill, "utf8") : "";
  const checks = {
    "openclaw": [/openclaw mcp add/, /openclaw mcp list/],
    "codex": [/\[mcp_servers\.memory\]/],
    "claude": [/"mcpServers"/],
    "manual": [/手工/, /v1\/health/],
  }[id];
  const neg = id === "openclaw" ? !/mcpServers/.test(body) : true;
  const ok = checks.every((re) => re.test(body)) && neg && !/AppData[\\/]+Local[\\/]+Temp/.test(body);
  console.log(`P1 ${id.padEnd(9)} exit=${r.code}  ${ok ? "✅" : "❌"}  ${checks.map((re) => re.test(body) ? "y" : "n").join("")}${neg ? "" : " (出现了 mcpServers ❌)"}`);
  if (!ok) console.log("   技能片段: " + body.slice(0, 300).replace(/\s+/g, " "));
}

// P4: 没有临时路径
const leaked = Object.keys(cases).filter((id) => {
  const p = path.join(skillsDir, `memory-${id}`, "SKILL.md");
  return fs.existsSync(p) && /AppData[\\/]+Local[\\/]+Temp/.test(fs.readFileSync(p, "utf8"));
});
console.log(`P4 生成物含临时路径: ${leaked.length ? "❌ " + leaked.join(",") : "✅ 0 份"}`);

// P2: manual 不写 read 配置文件
const manualCfg = path.join(tmp, "manual.cfg");
console.log(`P2 manual 是否创建配置文件: ${fs.existsSync(manualCfg) ? "❌ 创建了" : "✅ 没创建"}`);

// P3: 老 manifest（无 apply）仍渲染 mcpServers
mk("legacy", {});
delete JSON.parse(fs.readFileSync(path.join(mfDir, "legacy.json"), "utf8")).read.apply;
const legacyM = JSON.parse(fs.readFileSync(path.join(mfDir, "legacy.json"), "utf8"));
delete legacyM.read.apply;
fs.writeFileSync(path.join(mfDir, "legacy.json"), JSON.stringify(legacyM, null, 2), "utf8");
run("agent-scaffold.mjs", ["--agent", "legacy", "--manifest-dir", mfDir, "--write"]);
const legacySkill = path.join(skillsDir, "memory-legacy", "SKILL.md");
const legacyBody = fs.existsSync(legacySkill) ? fs.readFileSync(legacySkill, "utf8") : "";
console.log(`P3 老 manifest（无 apply）→ 仍给 mcpServers: ${/"mcpServers"/.test(legacyBody) ? "✅" : "❌"}`);

// R1: 假 cli 命令也必须合法；声明仍须包含可复现命令和验证命令
mk("fakecli", { apply: { kind: "cli", command: "totally-fake-binary --nope", verifyCommand: "totally-fake-binary --verify" } });
const r1 = run("agent-discover.mjs", ["--validate", "--manifest-dir", mfDir]);
const r1Stored = JSON.parse(fs.readFileSync(path.join(mfDir, "fakecli.json"), "utf8"));
const r1Preserved = r1Stored.read.apply.command === "totally-fake-binary --nope";
console.log(`R1 假 cli 命令在校验中: exit=${r1.code} ${r1.code === 0 && r1Preserved ? "✅ 合法且声明未改写" : "❌ 被误拒或改写"}`);

// R2: manual + 不存在的 configPath 合法
mk("manual2", { apply: { kind: "manual" }, configPath: path.join(tmp, "nope-does-not-exist.json") });
const r2 = run("agent-discover.mjs", ["--validate", "--manifest-dir", mfDir]);
console.log(`R2 manual + 不存在路径: exit=${r2.code} ${r2.code === 0 ? "✅ 合法" : "❌ 被误拒"}`);

// R3: 我们猜的 manifest 必须标 inferred，scaffold 必须醒目标"猜测，请确认"
fs.rmSync(path.join(mfDir, "openclaw.json"), { force: true });
const discovered = run("agent-discover.mjs", ["--agent", "openclaw", "--manifest-dir", mfDir, "--write"]);
const guessed = JSON.parse(fs.readFileSync(path.join(mfDir, "openclaw.json"), "utf8"));
const renderedGuess = run("agent-scaffold.mjs", ["--agent", "openclaw", "--manifest-dir", mfDir]);
const marked = guessed.read.apply?.inferred === true && guessed.read.apply?.inferredFrom === "AGENT-SPEC §9.2 hint table" && /猜测，请确认/.test(renderedGuess.out);
console.log(`R3 发现值与技能是否标注"猜测/请确认": ${discovered.code === 0 && renderedGuess.code === 0 && marked ? "✅" : "❌"}`);

fs.rmSync(tmp, { recursive: true, force: true });
