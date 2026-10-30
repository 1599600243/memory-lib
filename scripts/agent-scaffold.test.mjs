import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const scripts = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1)));
const scaffold = path.join(scripts, "agent-scaffold.mjs");
const discover = path.join(scripts, "agent-discover.mjs");

async function run(script, args, env = {}) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: scripts, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function manifest(id = "never-seen-agent") {
  return {
    specVersion: 1, id, displayName: "Never Seen Agent",
    read: { mode: "mcp", server: "memory", configPath: "~/.never-seen/mcp.json", configPathVerified: false, credentialRef: `memory-lib/${id}`, agent: `${id}-01`, role: "reader" },
    write: { mode: "transcript", source: id, sources: [{ dirs: ["~/.never-seen/sessions"], format: "jsonl" }], credentialRef: `memory-lib/${id}`, agent: `${id}-01`, role: "capture-ingest" },
    inject: "brief-on-demand", state: "discovered", notes: "",
  };
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-scaffold-home-"));
  const manifests = path.join(home, "manifests");
  await fs.mkdir(manifests, { recursive: true });
  await fs.writeFile(path.join(manifests, "never-seen-agent.json"), JSON.stringify(manifest(), null, 2));
  return { home, manifests, manifestFile: path.join(manifests, "never-seen-agent.json"), config: path.join(home, ".never-seen", "mcp.json"), env: { HOME: home, USERPROFILE: home, DSH_SKILLS_DIR: path.join(home, "skills") } };
}
function generated(f) { return [path.join(f.manifests, "never-seen-agent.write-validation.md"), path.join(f.home, "skills", "memory-never-seen-agent", "SKILL.md"), path.join(f.manifests, "never-seen-agent.checklist.md")]; }

test("N1 --write warns for unverified configPath and never creates it", async () => {
  const f = await fixture();
  try {
    const result = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /WARN.*configPath.*不存在/);
    assert.equal(await fs.stat(f.config).catch(() => null), null);
    assert.match(result.stdout, /read-config-snippet/);
    assert.match(result.stdout, /created=3 unchanged=0 backedUp=0 configWritten=0/);
    for (const file of generated(f)) assert.ok(await fs.stat(file));
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("N2 --write-config rejects third-party file; --force backs it up then writes", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.config), { recursive: true });
    const original = JSON.stringify({ thirdParty: true }, null, 2) + "\n";
    await fs.writeFile(f.config, original);
    const rejected = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write", "--write-config"], f.env);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /第三方配置.*--force.*\.bak/);
    assert.equal(await fs.readFile(f.config, "utf8"), original);
    const forced = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write", "--write-config", "--force"], f.env);
    assert.equal(forced.status, 0, forced.stderr);
    const names = await fs.readdir(path.dirname(f.config));
    assert.equal(names.filter((name) => name.startsWith("mcp.json.bak-")).length, 1);
    const written = JSON.parse(await fs.readFile(f.config, "utf8"));
    assert.equal(written.thirdParty, true);
    assert.equal(written.memoryLibScaffold.owner, "agent-scaffold");
    assert.match(written.mcpServers.memory.args[0], /memory-mcp-launch\.mjs$/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("--write-config creates an absent config only when explicitly requested", async () => {
  const f = await fixture();
  try {
    const result = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write", "--write-config"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(await fs.stat(f.config));
    assert.match(result.stdout, /configWritten=1/);
    const stored = JSON.parse(await fs.readFile(f.manifestFile, "utf8"));
    assert.equal(stored.read.configPathVerified, true);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("N3 generated files use placeholders and never freeze the temporary manifest directory", async () => {
  const f = await fixture();
  try {
    const withTemporaryPaths = manifest();
    withTemporaryPaths.read.configPath = path.join(f.home, "third-party", "config.json");
    withTemporaryPaths.write.sources[0].dirs = [path.join(f.home, "sessions")];
    await fs.writeFile(f.manifestFile, JSON.stringify(withTemporaryPaths, null, 2));
    const result = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    for (const file of generated(f)) {
      const text = await fs.readFile(file, "utf8");
      assert.doesNotMatch(text, /AppData[\\/]Local[\\/]Temp/iu);
      assert.doesNotMatch(text, new RegExp(f.manifests.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
    }
    const skill = await fs.readFile(generated(f)[1], "utf8");
    assert.match(skill, /data[\\/]runtime[\\/]agents[\\/]never-seen-agent\.json/);
    assert.doesNotMatch(skill, /<(?:source-dir|manifest-dir|config-path)>/);
    assert.match(skill, /memory_recall_brief/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("Q1-Q4 / N6-N8 skill is self-contained and follows health truth table", async () => {
  const f = await fixture();
  try {
    const result = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const skill = await fs.readFile(generated(f)[1], "utf8");
    assert.match(skill, /```json[\s\S]*"mcpServers"[\s\S]*"MCP_MEMORY_CRED_REF"[\s\S]*"MCP_MEMORY_ROLE"[\s\S]*```/);
    const command = skill.match(/"command":\s*"([^"]+)"/)?.[1].replaceAll("\\\\", "\\");
    assert.ok(command, "skill must contain command");
    assert.ok(await fs.stat(command));
    assert.match(skill, /memory-mcp-launch\.mjs/);
    assert.match(skill, /GET http:\/\/127\.0\.0\.1:8787\/v1\/health[\s\S]*HTTP 200[\s\S]*health: "healthy"/);
    assert.doesNotMatch(skill, /<[^>]+>/);
    assert.match(skill, /data[\\/]runtime[\\/]agents[\\/]never-seen-agent\.json/);
    assert.match(skill, /node .*agent-scaffold\.mjs"? --agent never-seen-agent --write/);
    assert.match(skill, /write\.sources\[\]\.dirs/);
    assert.match(skill, /stdio[\s\S]*"method":"initialize"[\s\S]*"method":"notifications\/initialized"[\s\S]*"method":"tools\/call"/);
    assert.match(skill, /MCP_MEMORY_URL[\s\S]*MCP_MEMORY_CRED_REF[\s\S]*MCP_MEMORY_AGENT[\s\S]*MCP_MEMORY_ROLE[\s\S]*memory-mcp-launch\.mjs/);
    assert.match(skill, /protocolVersion[\s\S]*clientInfo[\s\S]*result\.content\[0\]\.text[\s\S]*解析为 JSON/);
    assert.match(skill, /既有第三方配置[^\n]*拒绝[^\n]*人工确认[\s\S]*--write-config --force[\s\S]*保留他人[^\n]*env[\s\S]*不整段覆盖[\s\S]*同名 server[^\n]*冲突/);
    assert.match(skill, /\| 普通接入方（reader） \|[\s\S]*memory_health[\s\S]*GET http:\/\/127\.0\.0\.1:8787\/v1\/health[\s\S]*health === "healthy"/);
    assert.match(skill, /\| 管理员 \|[\s\S]*POST \/v1\/admin\/health[\s\S]*checks\[10\][\s\S]*全为 `ok`/);
    assert.doesNotMatch(skill, /memory_health[^\n]*(?:返回|响应)[^\n]*checks/);
    assert.doesNotMatch(skill, /memory_health[^\n]*checks (?:均|全)为 `?ok/);
    assert.match(skill, /\/health.*401.*正常[\s\S]*\/v1\/health/);
    assert.doesNotMatch(skill, /\/v1\/health[^\n]*需凭据/);
    assert.doesNotMatch(skill, /AppData[\\/]Local[\\/]Temp/iu);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("--write remains idempotent for the three persisted scaffold artifacts", async () => {
  const f = await fixture();
  try {
    const args = ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write"];
    assert.equal((await run(scaffold, args, f.env)).status, 0);
    const before = new Map(); for (const file of generated(f)) before.set(file, (await fs.stat(file)).mtimeMs);
    const second = await run(scaffold, args, f.env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /created=0 unchanged=3 backedUp=0 configWritten=0/);
    for (const file of generated(f)) assert.equal((await fs.stat(file)).mtimeMs, before.get(file));
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("agent-discover validation warns without recording configPathVerified", async () => {
  const f = await fixture();
  try {
    const raw = manifest(); delete raw.read.configPathVerified;
    const original = JSON.stringify(raw, null, 2);
    await fs.writeFile(f.manifestFile, original);
    const result = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /WARN.*configPath.*不存在/);
    assert.equal(await fs.readFile(f.manifestFile, "utf8"), original);
    await fs.mkdir(path.dirname(f.config), { recursive: true }); await fs.writeFile(f.config, "{}\n");
    const again = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(await fs.readFile(f.manifestFile, "utf8"), original);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("read-config preview excludes unrelated third-party values and unsafe manifests are rejected", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.dirname(f.config), { recursive: true });
    await fs.writeFile(f.config, JSON.stringify({ headers: { Authorization: "probe-private-value" }, mcpServers: { other: { command: "other" } } }, null, 2));
    const preview = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests], f.env);
    assert.equal(preview.status, 0, preview.stderr);
    assert.doesNotMatch(preview.stdout, /probe-private-value|"other"/);
    assert.match(preview.stdout, /MCP_MEMORY_CRED_REF/);
    const unsafe = manifest(); unsafe.displayName = "bad\nname";
    await fs.writeFile(f.manifestFile, JSON.stringify(unsafe, null, 2));
    const rejected = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests], f.env);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /控制字符/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("Q2 rejects undefined CLI placeholders before generating a skill", async () => {
  const f = await fixture();
  try {
    const raw = manifest();
    raw.read.apply = { kind: "cli", command: "probe <workspace> <node>", verifyCommand: "probe list" };
    await fs.writeFile(f.manifestFile, JSON.stringify(raw, null, 2));
    const result = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests], f.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未定义占位符 <workspace>/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("Q4 YAML merge honors a non-memory server key and preserves peers", async () => {
  const f = await fixture();
  try {
    const raw = manifest();
    raw.read.server = "recall";
    raw.read.configPath = "~/.never-seen/mcp.yml";
    raw.read.apply = { kind: "config" };
    await fs.writeFile(f.manifestFile, JSON.stringify(raw, null, 2));
    const target = path.join(f.home, ".never-seen", "mcp.yml");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "mcp:\n  other:\n    command: keep\n  recall:\n    command: old\n");
    const result = await run(scaffold, ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--write", "--write-config", "--force"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const written = await fs.readFile(target, "utf8");
    assert.equal((written.match(/^  recall:$/gmu) ?? []).length, 1);
    assert.match(written, /^  other:[\s\S]*command: keep/mu);
    assert.match(written, /^  recall:[\s\S]*memory-mcp-launch\.mjs/mu);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("memory launcher keeps slash-to-underscore credential target normalization", async () => {
  const source = await fs.readFile(path.join(scripts, "memory-mcp-launch.mjs"), "utf8");
  assert.match(source, /credRef\.replaceAll\("\/", "_"\)/);
});

test("glob omission still validates and capture defaults it to star", async () => {
  const f = await fixture();
  try {
    const validation = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(validation.status, 0, validation.stderr);
    const sessions = path.join(f.home, ".never-seen", "sessions"); await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "no-extension"), JSON.stringify({ role: "user", content: "probe" }) + "\n");
    const preview = await run(path.join(scripts, "capture-tail.mjs"), ["--agent", "never-seen-agent", "--manifest-dir", f.manifests, "--state", path.join(f.home, "state.json"), "--once", "--backfill", "--dry-run"], f.env);
    assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /1 条消息/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});
