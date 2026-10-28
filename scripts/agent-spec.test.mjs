import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import http from "node:http";

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1)));
const discover = path.join(root, "agent-discover.mjs");
const capture = path.join(root, "capture-tail.mjs");
const exec = promisify(spawn);

async function run(script, args, env = {}) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const valid = (id = "sample") => ({
  specVersion: 1,
  id,
  displayName: "Sample",
  read: { mode: "mcp", server: "memory", configPath: "~/.sample/config.json", credentialRef: "memory-lib/sample", agent: "pilot-01", role: "reader" },
  write: { mode: "transcript", source: id, sources: [{ dirs: ["~/.sample/sessions"], format: "jsonl", glob: "*.jsonl" }], credentialRef: "memory-lib/sample", agent: "pilot-01", role: "capture-ingest" },
  inject: "brief-on-demand",
  state: "discovered",
  notes: "",
});

test("agent-discover help and no-arg usage do not probe", async () => {
  for (const args of [["--help"], ["-h"], []]) {
    const result = await run(discover, args, { HOME: path.join(os.tmpdir(), "agent-spec-help-do-not-probe"), USERPROFILE: path.join(os.tmpdir(), "agent-spec-help-do-not-probe") });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:|用法/);
    assert.match(result.stdout, /--agent|--manifest-dir|--validate|--write|--enable|--disable|--help/);
    assert.match(result.stdout, /AGENT-SPEC\.md/);
    assert.match(result.stdout, /memory-onboard/);
    assert.doesNotMatch(result.stdout, /"agent"\s*:/, "help must not execute discovery");
  }
});

test("agent-discover --write never downgrades a verified manifest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-preserve-state-"));
  const manifest = valid("codex");
  manifest.state = "verified";
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, "codex.json"), JSON.stringify(manifest));
  const result = await run(discover, ["--agent", "codex", "--write", "--manifest-dir", tmp], { HOME: path.join(tmp, "home"), USERPROFILE: path.join(tmp, "home") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(tmp, "codex.json"), "utf8")).state, "verified");
  await fs.rm(tmp, { recursive: true, force: true });
});

test("agent-discover validates v1.1 conditional shapes and rejects secrets", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-v11-schema-"));
  const transcript = valid("transcript-agent");
  const hook = { ...valid("hook-agent"), read: { mode: "none" }, write: { mode: "hook", source: "hook-agent", sources: [], credentialRef: "memory-lib/hook-agent", agent: "hook-agent-01", role: "capture-ingest" }, inject: "native" };
  const none = { ...valid("none-agent"), read: { mode: "none" }, write: { mode: "none" } };
  await fs.writeFile(path.join(tmp, "transcript.json"), JSON.stringify(transcript));
  await fs.writeFile(path.join(tmp, "hook.json"), JSON.stringify(hook));
  await fs.writeFile(path.join(tmp, "none.json"), JSON.stringify(none));
  const good = await run(discover, ["--validate", "--manifest-dir", tmp]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /OK transcript\.json/);
  assert.match(good.stdout, /OK hook\.json/);
  assert.match(good.stdout, /OK none\.json/);

  await fs.writeFile(path.join(tmp, "bad-id.json"), JSON.stringify({ ...valid(), id: "bad agent!" }));
  await fs.writeFile(path.join(tmp, "plain-key.json"), JSON.stringify({ ...valid(), secret: "REDACTED_TEST_VALUE" }));
  const bad = await run(discover, ["--validate", "--manifest-dir", tmp]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /bad-id\.json\.id.*kebab-case/);
  assert.match(bad.stderr, /plain-key\.json\.secret.*明文密钥/);
  await fs.rm(tmp, { recursive: true, force: true });
});

test("agent-discover validates concrete manifest fields", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-schema-"));
  await fs.writeFile(path.join(tmp, "bad.json"), JSON.stringify({ ...valid(), state: "broken", write: { ...valid().write, sources: [{ dirs: [], format: "guess", glob: 4 }] } }));
  const result = await run(discover, ["--validate", "--manifest-dir", tmp]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /state|write\.sources\[0\]\.dirs|format|glob/);
  await fs.rm(tmp, { recursive: true, force: true });
});

test("agent-discover writes missing codex as discovered without crashing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-discover-"));
  const missing = path.join(tmp, "no-codex");
  const result = await run(discover, ["--agent", "codex", "--write", "--manifest-dir", path.join(tmp, "manifests")], { HOME: tmp, USERPROFILE: tmp, CODEX_SESSIONS_DIR: missing });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await fs.readFile(path.join(tmp, "manifests", "codex.json"), "utf8"));
  assert.equal(manifest.state, "discovered");
  assert.match(manifest.notes, /目录未出现/);
  await fs.rm(tmp, { recursive: true, force: true });
});

test("agent-discover errors on unknown message shapes and preserves discovered", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-shape-"));
  const sessions = path.join(tmp, ".codex", "sessions");
  const manifests = path.join(tmp, "manifests");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "unknown.jsonl"), JSON.stringify({ kind: "mystery", value: 3 }) + "\n");
  const result = await run(discover, ["--agent", "codex", "--write", "--manifest-dir", manifests], { HOME: tmp, USERPROFILE: tmp });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /抽不到消息形状/);
  assert.equal(JSON.parse(await fs.readFile(path.join(manifests, "codex.json"), "utf8")).state, "discovered");
  await fs.rm(tmp, { recursive: true, force: true });
});

test("capture-tail help exits without reading manifests or guarding", async () => {
  for (const args of [["--help"], ["-h"]]) {
    const result = await run(capture, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:|用法/);
    assert.match(result.stdout, /--agent|--dir|--once|--backfill|--verify|--dry-run|--state|--interval/);
    assert.doesNotMatch(result.stdout, /启动：|本轮/);
  }
});

test("capture-tail retains offset and escalates an unparsable file on round three", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-unparsable-"));
  const sessionDir = path.join(tmp, "sessions");
  const manifestDir = path.join(tmp, "manifests");
  const stateFile = path.join(tmp, "state.json");
  const transcript = path.join(sessionDir, "junk.jsonl");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(transcript, '{"kind":"unknown","value":3}\n');
  const manifest = valid("sample");
  manifest.write.sources = [{ dirs: [sessionDir], format: "jsonl", glob: "*.jsonl" }];
  await fs.writeFile(path.join(manifestDir, "sample.json"), JSON.stringify(manifest));
  const common = ["--agent", "sample", "--once", "--backfill", "--manifest-dir", manifestDir, "--state", stateFile];

  const dry = await run(capture, [...common, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`WARN unparsable .*junk\\.jsonl @offset=0`));
  assert.equal(await fs.stat(stateFile).catch(() => null), null);

  for (let round = 1; round <= 2; round++) {
    const result = await run(capture, common, { MEMORY_LIB_SECRET: "test-only" });
    assert.equal(result.status, 0, `round ${round}: ${result.stderr}`);
    assert.match(result.stdout, /WARN unparsable .*junk\.jsonl @offset=0/);
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(state[transcript].offset, 0);
    assert.equal(state[transcript].unparsableRounds, round);
  }
  const third = await run(capture, [...common, "--verify"], { MEMORY_LIB_SECRET: "test-only" });
  assert.equal(third.status, 1);
  assert.match(third.stdout, /WARN unparsable .*junk\.jsonl @offset=0/);
  const finalState = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(finalState[transcript].offset, 0);
  assert.equal(finalState[transcript].unparsableRounds, 3);
  const finalManifest = JSON.parse(await fs.readFile(path.join(manifestDir, "sample.json"), "utf8"));
  assert.equal(finalManifest.notes, `unparsable:${transcript}`);
  assert.equal(finalManifest.state, "discovered");
  await fs.rm(tmp, { recursive: true, force: true });
});

test("capture-tail manifest mode reads jsonl-zst, commits once, and is idempotent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-capture-"));
  const sessionDir = path.join(tmp, "sessions");
  const manifestDir = path.join(tmp, "manifests");
  const state = path.join(tmp, "state.json");
  await fs.mkdir(sessionDir, { recursive: true });
  const raw = Buffer.from(JSON.stringify({ role: "user", content: "zstd probe" }) + "\n" + JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "captured" }] } }) + "\n");
  await fs.writeFile(path.join(sessionDir, "one.jsonl.deleted.1.zst"), zstdCompressSync(raw));
  const manifest = valid("sample");
  manifest.write.sources = [{ dirs: [sessionDir], format: "jsonl-zst", glob: "*.zst" }];
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, "sample.json"), JSON.stringify(manifest));
  const calls = [];
  const result = await run(capture, ["--agent", "sample", "--once", "--backfill", "--dry-run", "--manifest-dir", manifestDir, "--state", state], { MEMORY_LIB_URL: "http://127.0.0.1:1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 条消息/);
  assert.equal((await fs.stat(state).catch(() => null)), null, "dry-run must not advance state");
  void calls;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("capture-tail verify commits, reads evidence, advances verified, then is idempotent", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-verify-"));
  const sessionDir = path.join(tmp, "sessions");
  const manifestDir = path.join(tmp, "manifests");
  const state = path.join(tmp, "state.json");
  const evidencePath = path.join(tmp, "evidence.md");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "verify.jsonl"), JSON.stringify({ role: "user", content: "verify me" }) + "\n");
  await fs.writeFile(evidencePath, "---\nsource: sample\n---\nverify me\n");
  const manifest = valid("sample");
  manifest.write.sources = [{ dirs: [sessionDir], format: "jsonl", glob: "*.jsonl" }];
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(manifestDir, "sample.json"), JSON.stringify(manifest));
  const server = await new Promise((resolve) => {
    const instance = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, data: { evidencePath, source: JSON.parse(body).source } })); });
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    const first = await run(capture, ["--agent", "sample", "--once", "--backfill", "--verify", "--manifest-dir", manifestDir, "--state", state], { MEMORY_LIB_URL: `http://127.0.0.1:${address.port}`, MEMORY_LIB_SECRET: "test-only" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /evidence: .*evidence\.md source=sample/);
    assert.match(first.stdout, /manifest state: discovered → verified/);
    assert.equal(JSON.parse(await fs.readFile(path.join(manifestDir, "sample.json"), "utf8")).state, "verified");
    const second = await run(capture, ["--agent", "sample", "--once", "--verify", "--manifest-dir", manifestDir, "--state", state], { MEMORY_LIB_URL: `http://127.0.0.1:${address.port}`, MEMORY_LIB_SECRET: "test-only" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /抽出 0 条消息，提交 0 次/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("capture-tail failed verify leaves manifest discovered", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-verify-fail-"));
  const sessionDir = path.join(tmp, "sessions");
  const manifestDir = path.join(tmp, "manifests");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "failure.jsonl"), JSON.stringify({ role: "user", content: "must fail" }) + "\n");
  const manifest = valid("sample");
  manifest.write.sources = [{ dirs: [sessionDir], format: "jsonl", glob: "*.jsonl" }];
  await fs.writeFile(path.join(manifestDir, "sample.json"), JSON.stringify(manifest));
  const server = await new Promise((resolve) => {
    const instance = http.createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "TEST_FAILURE" } }));
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const result = await run(capture, ["--agent", "sample", "--once", "--backfill", "--verify", "--manifest-dir", manifestDir, "--state", path.join(tmp, "state.json")], { MEMORY_LIB_URL: `http://127.0.0.1:${server.address().port}`, MEMORY_LIB_SECRET: "test-only" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /manifest state:/);
    assert.equal(JSON.parse(await fs.readFile(path.join(manifestDir, "sample.json"), "utf8")).state, "discovered");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("capture-tail rejects manifest paths coupled to data\\memory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-coupling-"));
  const manifest = valid("bad");
  manifest.write.sources[0].dirs = ["D:\\MemoryLib\\data\\memory\\x"];
  await fs.writeFile(path.join(tmp, "bad.json"), JSON.stringify(manifest));
  const result = await run(capture, ["--agent", "bad", "--once", "--manifest-dir", tmp]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /data[\\/\\\\]memory/);
  await fs.rm(tmp, { recursive: true, force: true });
});
