import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const scripts = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1)));
const scaffold = path.join(scripts, "agent-scaffold.mjs");
const discover = path.join(scripts, "agent-discover.mjs");

async function run(script, args, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: scripts, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function baseManifest(id, configPath, apply) {
  return {
    specVersion: 1,
    id,
    displayName: id,
    read: { mode: "mcp", server: "memory", configPath, configPathVerified: false, ...(apply ? { apply } : {}), credentialRef: `memory-lib/${id}`, agent: `${id}-01`, role: "reader" },
    write: { mode: "none" },
    inject: "brief-on-demand",
    state: "discovered",
    notes: "",
  };
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec3-"));
  const manifests = path.join(home, "manifests");
  const skills = path.join(home, "skills");
  await fs.mkdir(manifests, { recursive: true });
  return { home, manifests, skills, env: { HOME: home, USERPROFILE: home, DSH_SKILLS_DIR: skills } };
}

async function render(f, manifest) {
  await fs.writeFile(path.join(f.manifests, `${manifest.id}.json`), JSON.stringify(manifest, null, 2));
  return await run(scaffold, ["--agent", manifest.id, "--manifest-dir", f.manifests], f.env);
}

test("P1/P4 scaffold renders four apply shapes without AppData temp paths", async () => {
  const f = await fixture();
  try {
    const launcher = path.join(path.resolve(scripts, ".."), "scripts", "memory-mcp-launch.mjs");
    const cases = [
      {
        manifest: baseManifest("openclaw", path.join(f.home, ".openclaw", "openclaw.json"), { kind: "cli", command: "openclaw mcp add memory --command \"<node>\" --arg \"<launcher>\" --env MCP_MEMORY_URL=http://127.0.0.1:8787 --env MCP_MEMORY_CRED_REF=<ref> --env MCP_MEMORY_AGENT=<agent> --env MCP_MEMORY_ROLE=<role>", verifyCommand: "openclaw mcp list" }),
        matches: [/openclaw mcp add memory/, new RegExp(process.execPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")), new RegExp(launcher.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")), /openclaw mcp list/],
        excludes: [/```json[\s\S]*mcpServers/],
      },
      { manifest: baseManifest("codex", path.join(f.home, ".codex", "config.toml"), { kind: "config" }), matches: [/```toml[\s\S]*\[mcp_servers\.memory\]/], excludes: [/"mcpServers"/] },
      { manifest: baseManifest("claude-code", path.join(f.home, ".claude.json"), { kind: "config" }), matches: [/```json[\s\S]*"mcpServers"/], excludes: [/mcp\.servers/] },
      { manifest: baseManifest("dsh", path.join(f.home, ".dsh", "profiles", "web", "cordis.patch.yml"), { kind: "config" }), matches: [/```ya?ml[\s\S]*mcp:\s*\n\s+memory:/], excludes: [/"mcpServers"/] },
    ];
    for (const item of cases) {
      const result = await render(f, item.manifest);
      assert.equal(result.status, 0, `${item.manifest.id}: ${result.stderr}`);
      for (const pattern of item.matches) assert.match(result.stdout, pattern, item.manifest.id);
      for (const pattern of item.excludes) assert.doesNotMatch(result.stdout, pattern, item.manifest.id);
      assert.doesNotMatch(result.stdout, /猜测，请确认/, item.manifest.id);
      assert.doesNotMatch(result.stdout, /AppData[\\/]Local[\\/]Temp/iu, item.manifest.id);
    }
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("P1 discover emits exact built-in paths and apply kinds from CLI or known config key", async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.home, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, process.platform === "win32" ? "openclaw.cmd" : "openclaw"), process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await fs.chmod(path.join(bin, "openclaw"), 0o755);
    await fs.mkdir(path.join(f.home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(f.home, ".codex", "config.toml"), "[mcp_servers.memory]\ncommand = \"node\"\n");
    await fs.writeFile(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { memory: {} } }));
    await fs.mkdir(path.join(f.home, ".dsh", "profiles", "web"), { recursive: true });
    await fs.writeFile(path.join(f.home, ".dsh", "profiles", "web", "cordis.patch.yml"), "mcp:\n  memory: {}\n");
    const env = { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    for (const id of ["openclaw", "codex", "claude-code", "dsh"]) {
      const result = await run(discover, ["--agent", id, "--manifest-dir", f.manifests, "--write"], env);
      assert.equal(result.status, 0, `${id}: ${result.stderr}`);
    }
    const expected = {
      openclaw: ["~/.openclaw/openclaw.json", "cli", false],
      codex: ["~/.codex/config.toml", "config", true],
      "claude-code": ["~/.claude.json", "config", true],
      dsh: ["~/.dsh/profiles/web/cordis.patch.yml", "config", true],
    };
    for (const [id, [configPath, kind, verified]] of Object.entries(expected)) {
      const value = JSON.parse(await fs.readFile(path.join(f.manifests, `${id}.json`), "utf8"));
      assert.equal(value.read.configPath, configPath);
      assert.equal(value.read.apply.kind, kind);
      assert.equal(value.read.apply.inferred, true);
      assert.equal(value.read.apply.inferredFrom, "AGENT-SPEC §9.2 hint table");
      if (id === "codex") assert.equal(value.read.apply.keyPath, "mcp_servers");
      if (id === "claude-code") assert.equal(value.read.apply.keyPath, "mcpServers");
      if (id === "dsh") assert.equal(value.read.apply.keyPath, "mcp");
      assert.equal(value.read.configPathVerified, verified);
    }
    const openclaw = JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8"));
    assert.equal(openclaw.read.apply.verifyCommand, "openclaw mcp list");
    assert.match(openclaw.read.apply.command, /^openclaw mcp add memory /);
    for (const [id, expected] of [["codex", /\[mcp_servers\.memory\]/], ["dsh", /mcp:\s*\n\s+memory:/]]) {
      const roundTrip = await run(scaffold, ["--agent", id, "--manifest-dir", f.manifests], f.env);
      assert.equal(roundTrip.status, 0, roundTrip.stderr);
      assert.match(roundTrip.stdout, expected);
      assert.doesNotMatch(roundTrip.stdout, /memory\.memory|mcp\.memory:/);
    }
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("P2 manual prints bounded guidance and never writes read config", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, "unknown", "config.json");
    const manifest = baseManifest("unknown-agent", target, { kind: "manual" });
    const result = await render(f, manifest);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /需要手工配，我们不知道它读哪里/);
    assert.match(result.stdout, /GET http:\/\/127\.0\.0\.1:8787\/v1\/health/);
    assert.equal(await fs.stat(target).catch(() => null), null);
    assert.doesNotMatch(result.stdout, /```(?:json|toml|ya?ml)/);
    const rejected = await run(scaffold, ["--agent", manifest.id, "--manifest-dir", f.manifests, "--write", "--write-config"], f.env);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /--write-config 仅适用于 read\.apply\.kind=config/);
    assert.equal(await fs.stat(target).catch(() => null), null);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("P1 cli apply is printed by --write but never executed", async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.home, "must-not-exist");
    const manifest = baseManifest("cli-probe", path.join(f.home, "third-party.json"), { kind: "cli", command: `openclaw mcp add memory --command \"<node>\" --arg \"<launcher>\" --env MCP_MEMORY_URL=http://127.0.0.1:8787 --env MCP_MEMORY_CRED_REF=<ref> --env MCP_MEMORY_AGENT=<agent> --env MCP_MEMORY_ROLE=<role>`, verifyCommand: "openclaw mcp list" });
    await fs.writeFile(path.join(f.manifests, `${manifest.id}.json`), JSON.stringify(manifest, null, 2));
    const result = await run(scaffold, ["--agent", manifest.id, "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /openclaw mcp add memory/);
    assert.match(result.stdout, /configWritten=0/);
    assert.equal(await fs.stat(manifest.read.configPath).catch(() => null), null);
    assert.equal(await fs.stat(marker).catch(() => null), null);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("discover falls back to manual when neither CLI nor known key exists", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.home, ".openclaw"), { recursive: true });
    await fs.writeFile(path.join(f.home, ".openclaw", "openclaw.json"), JSON.stringify({ unrelated: true }));
    const env = { ...f.env, PATH: path.join(f.home, "empty-bin") };
    const result = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], env);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8"));
    assert.equal(value.read.apply.kind, "manual");
    assert.equal(value.read.configPathVerified, false);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("config apply uses OpenClaw mcp.servers rather than legacy mcpServers", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("openclaw", path.join(f.home, ".openclaw", "openclaw.json"), { kind: "config", keyPath: "mcp.servers" });
    const result = await render(f, value);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /```json[\s\S]*"mcp"\s*:\s*\{[\s\S]*"servers"/);
    assert.doesNotMatch(result.stdout, /"mcpServers"/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("manifest validation rejects unknown apply kinds and incomplete cli declarations", async () => {
  const f = await fixture();
  try {
    const unknown = baseManifest("bad-kind", "~/.bad/config.json", { kind: "magic" });
    const incomplete = baseManifest("bad-cli", "~/.bad/config.json", { kind: "cli", command: "openclaw mcp add memory" });
    await fs.writeFile(path.join(f.manifests, "bad-kind.json"), JSON.stringify(unknown, null, 2));
    await fs.writeFile(path.join(f.manifests, "bad-cli.json"), JSON.stringify(incomplete, null, 2));
    const result = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /read\.apply\.kind 必须是 config\|cli\|manual/);
    assert.match(result.stderr, /read\.apply\.verifyCommand 必须是非空字符串/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("V1 validate is read-only across repeated runs", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.manifests, "legacy-v1.json");
    const value = baseManifest("legacy-v1", "~/.legacy-v1/missing.json");
    delete value.read.configPathVerified;
    const original = JSON.stringify(value, null, 4) + "\n";
    await fs.writeFile(file, original);
    const before = await fs.stat(file);
    const beforeHash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    const first = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /WARN legacy-v1\.json: read\.configPath 不存在/);
    const afterFirst = await fs.stat(file);
    const afterFirstHash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    assert.equal(afterFirstHash, beforeHash);
    assert.equal(afterFirst.mtimeMs, before.mtimeMs);
    const second = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /WARN legacy-v1\.json: read\.configPath 不存在/);
    const after = await fs.stat(file);
    const afterHash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    assert.equal(afterHash, beforeHash);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("P3 validate preserves legacy missing apply as implicit config", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("codex", "~/.codex/config.toml");
    await fs.writeFile(path.join(f.manifests, "codex.json"), JSON.stringify(value, null, 2));
    const validated = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(validated.status, 0, validated.stderr);
    const stored = JSON.parse(await fs.readFile(path.join(f.manifests, "codex.json"), "utf8"));
    assert.equal(stored.read.apply, undefined);
    assert.equal(stored.read.configPathVerified, false);
    const rendered = await run(scaffold, ["--agent", "codex", "--manifest-dir", f.manifests], f.env);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /\[mcp_servers\.memory\]/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("scaffold plain write does not infer verification from unrelated existing config", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "[unrelated]\nvalue = true\n");
    const value = baseManifest("codex", "~/.codex/config.toml", { kind: "config" });
    await fs.writeFile(path.join(f.manifests, "codex.json"), JSON.stringify(value, null, 2));
    const result = await run(scaffold, ["--agent", "codex", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /configWritten=0/);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.manifests, "codex.json"), "utf8")).read.configPathVerified, false);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("DSH key detection does not cross into sibling YAML mappings", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, ".dsh", "profiles", "web", "cordis.patch.yml");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "mcp:\n  other: {}\nfoo:\n  memory: {}\n");
    const result = await run(discover, ["--agent", "dsh", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(await fs.readFile(path.join(f.manifests, "dsh.json"), "utf8"));
    assert.equal(value.read.apply.kind, "manual");
    assert.equal(value.read.configPathVerified, false);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("forced TOML and YAML writes replace complete owned key without duplicate tables", async () => {
  const f = await fixture();
  try {
    const toml = path.join(f.home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(toml), { recursive: true });
    await fs.writeFile(toml, "[mcp_servers.memory]\ncommand = \"old\"\n\n[mcp_servers.memory.env]\nOLD = \"yes\"\n\n[other]\nkeep = true\n");
    const codex = baseManifest("codex", "~/.codex/config.toml", { kind: "config" });
    await fs.writeFile(path.join(f.manifests, "codex.json"), JSON.stringify(codex, null, 2));
    const tr = await run(scaffold, ["--agent", "codex", "--manifest-dir", f.manifests, "--write", "--write-config", "--force"], f.env);
    assert.equal(tr.status, 0, tr.stderr);
    const writtenToml = await fs.readFile(toml, "utf8");
    assert.equal((writtenToml.match(/^\[mcp_servers\.memory\.env\]$/gmu) ?? []).length, 1);
    assert.match(writtenToml, /\[other\][\s\S]*keep = true/);

    const yaml = path.join(f.home, ".dsh", "profiles", "web", "cordis.patch.yml");
    await fs.mkdir(path.dirname(yaml), { recursive: true });
    await fs.writeFile(yaml, "mcp:\n  other:\n    command: \"keep\"\nfoo: true\n");
    const dsh = baseManifest("dsh", "~/.dsh/profiles/web/cordis.patch.yml", { kind: "config" });
    await fs.writeFile(path.join(f.manifests, "dsh.json"), JSON.stringify(dsh, null, 2));
    const yr = await run(scaffold, ["--agent", "dsh", "--manifest-dir", f.manifests, "--write", "--write-config", "--force"], f.env);
    assert.equal(yr.status, 0, yr.stderr);
    const writtenYaml = await fs.readFile(yaml, "utf8");
    assert.equal((writtenYaml.match(/^mcp:$/gmu) ?? []).length, 1);
    assert.match(writtenYaml, /^  other:/mu);
    assert.match(writtenYaml, /^  memory:/mu);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("R1 declared fake CLI remains authoritative through validate and rediscovery", async () => {
  const f = await fixture();
  try {
    const apply = { kind: "cli", command: "totally-fake-binary --declared", verifyCommand: "totally-fake-binary --verify" };
    const value = baseManifest("openclaw", "~/.private-agent/config.any", apply);
    await fs.writeFile(path.join(f.manifests, "openclaw.json"), JSON.stringify(value, null, 2));
    const validated = await run(discover, ["--validate", "--manifest-dir", f.manifests], { ...f.env, PATH: path.join(f.home, "empty-bin") });
    assert.equal(validated.status, 0, validated.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.apply, apply);
    const rediscovered = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], { ...f.env, PATH: path.join(f.home, "empty-bin") });
    assert.equal(rediscovered.status, 0, rediscovered.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.apply, apply);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("rediscovery preserves the config path that belongs to a declared config apply", async () => {
  const f = await fixture();
  try {
    const customPath = "~/.private-agent/actual-config.json";
    const value = baseManifest("openclaw", customPath, { kind: "config" });
    await fs.writeFile(path.join(f.manifests, "openclaw.json"), JSON.stringify(value, null, 2));
    const result = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8"));
    assert.equal(stored.read.configPath, customPath);
    assert.deepEqual(stored.read.apply, { kind: "config" });
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("rediscovery preserves but still schema-validates a declared apply", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("openclaw", "~/.private/config.any", { kind: "cli", command: "fake --declared" });
    await fs.writeFile(path.join(f.manifests, "openclaw.json"), JSON.stringify(value, null, 2));
    const result = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /read\.apply\.verifyCommand 必须是非空字符串/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("only rediscovery write refreshes inferred apply when the detected environment changes", async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.home, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, process.platform === "win32" ? "openclaw.cmd" : "openclaw"), process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await fs.chmod(path.join(bin, "openclaw"), 0o755);
    const first = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], { ...f.env, PATH: bin });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.apply.kind, "cli");
    const emptyPath = path.join(f.home, "empty-bin");
    const validated = await run(discover, ["--validate", "--manifest-dir", f.manifests], { ...f.env, PATH: emptyPath });
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.apply.kind, "cli");
    const second = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], { ...f.env, PATH: emptyPath });
    assert.equal(second.status, 0, second.stderr);
    const refreshed = JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.apply;
    assert.equal(refreshed.kind, "manual");
    assert.equal(refreshed.inferred, true);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("declared config keyPath drives JSON rendering without built-in agent hints", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("private-agent", path.join(f.home, "private.json"), { kind: "config", keyPath: "mcp.servers" });
    const result = await render(f, value);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"mcp"\s*:\s*\{[\s\S]*"servers"/);
    assert.doesNotMatch(result.stdout, /"mcpServers"/);
    assert.doesNotMatch(result.stdout, /猜测，请确认/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("declared config keyPath drives TOML and YAML rendering", async () => {
  const f = await fixture();
  try {
    const toml = await render(f, baseManifest("private-toml", path.join(f.home, "private.toml"), { kind: "config", keyPath: "custom_servers" }));
    assert.equal(toml.status, 0, toml.stderr);
    assert.match(toml.stdout, /\[custom_servers\.memory\]/);
    assert.doesNotMatch(toml.stdout, /\[mcp_servers\.memory\]/);
    const yaml = await render(f, baseManifest("private-yaml", path.join(f.home, "private.yml"), { kind: "config", keyPath: "custom_mcp" }));
    assert.equal(yaml.status, 0, yaml.stderr);
    assert.match(yaml.stdout, /custom_mcp:\s*\n\s+memory:/);
    assert.doesNotMatch(yaml.stdout, /\bmcp:\s*\n\s+memory:/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("YAML merge does not replace a same-named server in a sibling mapping", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, "custom.yml");
    await fs.writeFile(target, "mcp:\n  other: {}\nfoo:\n  memory:\n    command: \"keep\"\n");
    const value = baseManifest("private-yaml-merge", target, { kind: "config", keyPath: "mcp" });
    await fs.writeFile(path.join(f.manifests, `${value.id}.json`), JSON.stringify(value));
    const result = await run(scaffold, ["--agent", value.id, "--manifest-dir", f.manifests, "--write", "--write-config", "--force"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const written = await fs.readFile(target, "utf8");
    assert.match(written, /mcp:\s*\n\s+other: \{\}\s*\n\s+memory:/);
    assert.match(written, /foo:\s*\n\s+memory:\s*\n\s+command: "keep"/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("YAML replacement preserves the following top-level boundary", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, "replace.yml");
    await fs.writeFile(target, "mcp:\n  memory:\n    command: \"old\"\nbar:\n  memory:\n    command: \"keep-after\"\n");
    const value = baseManifest("private-yaml-replace", target, { kind: "config", keyPath: "mcp" });
    await fs.writeFile(path.join(f.manifests, `${value.id}.json`), JSON.stringify(value));
    const result = await run(scaffold, ["--agent", value.id, "--manifest-dir", f.manifests, "--write", "--write-config", "--force"], f.env);
    assert.equal(result.status, 0, result.stderr);
    const written = await fs.readFile(target, "utf8");
    assert.match(written, /MCP_MEMORY_ROLE: "reader"\r?\nbar:\r?\n  memory:\r?\n    command: "keep-after"/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("V2 rediscovery write persists configPathVerified", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("openclaw", "~/.openclaw/missing-custom.json", { kind: "config", keyPath: "mcp.servers" });
    delete value.read.configPathVerified;
    await fs.writeFile(path.join(f.manifests, "openclaw.json"), JSON.stringify(value));
    const result = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.configPathVerified, false);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("rediscovery recomputes configPathVerified for a preserved declaration", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("openclaw", "~/.openclaw/missing-custom.json", { kind: "config", keyPath: "mcp.servers" });
    value.read.configPathVerified = true;
    await fs.writeFile(path.join(f.manifests, "openclaw.json"), JSON.stringify(value));
    const result = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8")).read.configPathVerified, false);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("validate observes a declared keyPath without persisting the derived result", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.home, "custom.json");
    await fs.writeFile(target, JSON.stringify({ custom: { memory: {} } }));
    const value = baseManifest("openclaw", target, { kind: "config", keyPath: "custom" });
    const original = JSON.stringify(value);
    await fs.writeFile(path.join(f.manifests, "openclaw.json"), original);
    const result = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /read\.configPath/);
    assert.equal(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8"), original);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("inferred provenance is rejected for agents outside the hint table", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("unknown-inferred", "~/.unknown/config.json", { kind: "manual", inferred: true, inferredFrom: "AGENT-SPEC §9.2 hint table" });
    await fs.writeFile(path.join(f.manifests, "unknown-inferred.json"), JSON.stringify(value));
    const result = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /提示表中不存在该 agent/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("inferred provenance must be canonical and internally consistent", async () => {
  const f = await fixture();
  try {
    const forged = baseManifest("forged", "~/.forged/config.json", { kind: "config", inferred: true, inferredFrom: "arbitrary" });
    const contradictory = baseManifest("contradictory", "~/.contradictory/config.json", { kind: "config", inferred: false, inferredFrom: "AGENT-SPEC §9.2 hint table" });
    await fs.writeFile(path.join(f.manifests, "forged.json"), JSON.stringify(forged));
    await fs.writeFile(path.join(f.manifests, "contradictory.json"), JSON.stringify(contradictory));
    const result = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /inferredFrom 必须等于 AGENT-SPEC §9\.2 hint table/);
    assert.match(result.stderr, /inferred 不为 true 时不得提供 inferredFrom/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("R2 declared manual with missing config path validates and renders equivalent health verification", async () => {
  const f = await fixture();
  try {
    const value = baseManifest("manual-r2", path.join(f.home, "missing", "config.json"), { kind: "manual" });
    await fs.writeFile(path.join(f.manifests, "manual-r2.json"), JSON.stringify(value, null, 2));
    const validated = await run(discover, ["--validate", "--manifest-dir", f.manifests], f.env);
    assert.equal(validated.status, 0, validated.stderr);
    const rendered = await run(scaffold, ["--agent", "manual-r2", "--manifest-dir", f.manifests], f.env);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /需要手工配，我们不知道它读哪里/);
    assert.match(rendered.stdout, /GET http:\/\/127\.0\.0\.1:8787\/v1\/health/);
    assert.doesNotMatch(rendered.stdout, /猜测，请确认/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("R3 inferred discovery and missing apply render an explicit guess warning", async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.home, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, process.platform === "win32" ? "openclaw.cmd" : "openclaw"), process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await fs.chmod(path.join(bin, "openclaw"), 0o755);
    const discovered = await run(discover, ["--agent", "openclaw", "--manifest-dir", f.manifests, "--write"], { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
    assert.equal(discovered.status, 0, discovered.stderr);
    const stored = JSON.parse(await fs.readFile(path.join(f.manifests, "openclaw.json"), "utf8"));
    assert.equal(stored.read.apply.inferred, true);
    assert.equal(stored.read.apply.inferredFrom, "AGENT-SPEC §9.2 hint table");
    const inferredSkill = await run(scaffold, ["--agent", "openclaw", "--manifest-dir", f.manifests], f.env);
    assert.equal(inferredSkill.status, 0, inferredSkill.stderr);
    assert.match(inferredSkill.stdout, /以下为自动探测的猜测，请确认后再执行（你若知道自己怎么配，以你的为准）/);

    const legacy = baseManifest("legacy-r3", "~/.legacy-r3/config.json");
    const legacySkill = await render(f, legacy);
    assert.equal(legacySkill.status, 0, legacySkill.stderr);
    assert.match(legacySkill.stdout, /猜测，请确认/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});

test("P3 legacy manifest without apply retains mcpServers JSON", async () => {
  const f = await fixture();
  try {
    const result = await render(f, baseManifest("legacy-agent", "~/.legacy/config.json"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /```json[\s\S]*"mcpServers"/);
  } finally { await fs.rm(f.home, { recursive: true, force: true }); }
});
