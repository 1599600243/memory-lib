import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1)));
const repoRoot = path.resolve(here, "..");
const appRoot = path.join(repoRoot, "app", "memory-lib");
const install = path.join(here, "install.mjs");
const doctor = path.join(here, "doctor.mjs");
const q = (input) => process.platform === "win32" ? `"${String(input).replaceAll('"', '""')}"` : `'${String(input).replaceAll("'", `'"'"'`)}'`;

function run(script, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: path.resolve(here, ".."), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deploy1-"));
  return { root, dataRoot: path.join(root, "data") };
}

test("install and doctor help exit zero without running actions", async () => {
  for (const [script, flag] of [[install, "--help"], [install, "-h"], [doctor, "--help"], [doctor, "-h"]]) {
    const result = await run(script, [flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/);
    assert.doesNotMatch(result.stdout, /(?:DRY-RUN|ok 1\/10|FAIL 1\/10)/);
  }
});

test("install defaults to dry-run and does not create the data root", async () => {
  const f = await fixture();
  try {
    const result = await run(install, ["--data-root", f.dataRoot, "--secret-store", "file"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN/);
    await assert.rejects(fs.stat(f.dataRoot), { code: "ENOENT" });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("install write is idempotent and persists a file credential", async () => {
  const f = await fixture();
  try {
    const args = ["--write", "--data-root", f.dataRoot, "--secret-store", "file", "--port", "18787", "--timezone", "Asia/Shanghai"];
    const first = await run(install, args);
    assert.equal(first.status, 0, first.stderr);
    const configPath = path.join(f.dataRoot, "runtime", "deploy.json");
    const identityPath = path.join(f.dataRoot, "runtime", "identity.json");
    const before = await fs.readFile(configPath, "utf8");
    assert.equal(JSON.parse(before).port, 18787);
    assert.equal(JSON.parse(await fs.readFile(identityPath, "utf8")).frameworks[0].credential_ref, "memory-lib/local");
    const second = await run(install, args);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /no-op/);
    assert.equal(await fs.readFile(configPath, "utf8"), before);
    const secret = await fs.readFile(path.join(f.dataRoot, "runtime", "secrets", "memory-lib_local.secret"), "utf8");
    assert.equal(secret.trim().length, 64);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("doctor checks the credential store declared by this deployment", async () => {
  const f = await fixture();
  try {
    const installed = await run(install, ["--write", "--data-root", f.dataRoot, "--secret-store", "file", "--port", "18790"]);
    assert.equal(installed.status, 0, installed.stderr);
    const secretFile = path.join(f.dataRoot, "runtime", "secrets", "memory-lib_local.secret");
    const present = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const presentCheck = JSON.parse(present.stdout).checks.find((item) => item.id === 5);
    assert.equal(presentCheck.status, "ok");
    assert.equal(presentCheck.detail, `store=file path=${secretFile} size=64`);

    const secret = await fs.readFile(secretFile, "utf8");
    await fs.rm(secretFile);
    const missing = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const missingCheck = JSON.parse(missing.stdout).checks.find((item) => item.id === 5);
    assert.equal(missingCheck.status, "fail");
    assert.equal(missingCheck.detail, `store=file path=${secretFile} missing`);

    await fs.writeFile(secretFile, secret, { mode: 0o600 });
    const restored = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const restoredCheck = JSON.parse(restored.stdout).checks.find((item) => item.id === 5);
    assert.equal(restoredCheck.status, "ok");
    assert.equal(restoredCheck.detail, `store=file path=${secretFile} size=64`);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("install rejects an unknown non-empty root and force creates a backup", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(f.dataRoot, { recursive: true });
    await fs.writeFile(path.join(f.dataRoot, "keep.txt"), "keep");
    const rejected = await run(install, ["--write", "--data-root", f.dataRoot, "--secret-store", "file"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /非空/);
    const forced = await run(install, ["--write", "--force", "--data-root", f.dataRoot, "--secret-store", "file"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /backup=.*\.json\.gz/);
    assert.equal(await fs.readFile(path.join(f.dataRoot, "keep.txt"), "utf8"), "keep");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("doctor independently reports wrong port, missing credential, and read-only root", async () => {
  const f = await fixture();
  try {
    const installed = await run(install, ["--write", "--data-root", f.dataRoot, "--secret-store", "file", "--port", "18789"]);
    assert.equal(installed.status, 0, installed.stderr);
    const configPath = path.join(f.dataRoot, "runtime", "deploy.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.port = 65534;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await fs.rm(path.join(f.dataRoot, "runtime", "secrets", "memory-lib_local.secret"));
    await fs.chmod(f.dataRoot, 0o444);
    const checked = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const payload = JSON.parse(checked.stdout);
    assert.equal(payload.checks.find((item) => item.id === 2).status, "fail");
    assert.equal(payload.checks.find((item) => item.id === 4).status, "fail");
    assert.equal(payload.checks.find((item) => item.id === 5).status, "fail");
    assert.equal(payload.checks.find((item) => item.id === 2).fix, `node ${q(install)} --write --data-root ${q(f.dataRoot)} --secret-store file`);
    assert.equal(payload.checks.find((item) => item.id === 4).fix, `node ${q(path.join(appRoot, "server.mjs"))} --data-root ${q(path.join(f.dataRoot, "memory"))} --workspace-root ${q(f.dataRoot)} --registry ${q(path.join(f.dataRoot, "runtime", "identity.json"))} --secrets-dir ${q(path.join(f.dataRoot, "runtime", "secrets"))} --audit ${q(path.join(f.dataRoot, "runtime", "audit", "access.jsonl"))} --port 65534 --calendar-timezone ${q("Asia/Shanghai")} --secret-store file --summary-index none`);
    assert.equal(payload.checks.find((item) => item.id === 5).fix, `node ${q(install)} --write --data-root ${q(f.dataRoot)} --force --secret-store file`);
  } finally {
    await fs.chmod(f.dataRoot, 0o755).catch(() => {});
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("doctor warns but succeeds when only the vector lane is stale", async () => {
  const f = await fixture();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "memory-lib",
      health: "degraded",
      vector: { status: "stale", reason: "vector-lane stale: no active embeddings" },
      index: { failed: 0, indexed_files: 0, library_files: 1, pending_changes: 1 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const installed = await run(install, ["--write", "--data-root", f.dataRoot, "--secret-store", "file", "--port", String(port)]);
    assert.equal(installed.status, 0, installed.stderr);

    const machine = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const payload = JSON.parse(machine.stdout);
    const healthCheck = payload.checks.find((item) => item.id === 4);
    assert.equal(machine.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(healthCheck.status, "warn");
    assert.equal(healthCheck.detail, `http://127.0.0.1:${port}/v1/health HTTP 200 service=memory-lib health=degraded vector=stale reason=vector-lane stale: no active embeddings attempt=2`);
    assert.equal(healthCheck.fix, "ollama pull bge-m3");

    const human = await run(doctor, ["--data-root", f.dataRoot]);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /^WARN 4\/10 服务健康: .*vector=stale reason=vector-lane stale: no active embeddings attempt=2$/mu);
    assert.match(human.stdout, /^doctor: 10\/10 ok \(1 warning\)$/mu);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("doctor warns when bge-m3 is missing but fails on an index error", async () => {
  const f = await fixture();
  let indexFailed = 0;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "memory-lib",
      health: "degraded",
      vector: { status: "down", reason: "vector-lane down: embedding model missing (bge-m3)" },
      index: { failed: indexFailed, indexed_files: 0, library_files: 1, pending_changes: 1 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const installed = await run(install, ["--write", "--data-root", f.dataRoot, "--secret-store", "file", "--port", String(port)]);
    assert.equal(installed.status, 0, installed.stderr);
    const result = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const healthCheck = JSON.parse(result.stdout).checks.find((item) => item.id === 4);
    assert.equal(result.status, 0);
    assert.equal(healthCheck.status, "warn");
    assert.equal(healthCheck.fix, "ollama pull bge-m3");
    assert.match(healthCheck.detail, /vector=down reason=vector-lane down: embedding model missing \(bge-m3\) attempt=2$/u);

    indexFailed = 1;
    const failed = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).checks.find((item) => item.id === 4).status, "fail");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("doctor emits exactly ten read-only checks with executable fixes", async () => {
  const f = await fixture();
  try {
    const installed = await run(install, ["--write", "--data-root", f.dataRoot, "--secret-store", "file", "--port", "18788"]);
    assert.equal(installed.status, 0, installed.stderr);
    const before = await fs.readFile(path.join(f.dataRoot, "runtime", "deploy.json"), "utf8");
    const result = await run(doctor, ["--json", "--data-root", f.dataRoot]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.checks.length, 10);
    assert.deepEqual(payload.checks.map((item) => item.id), [1,2,3,4,5,6,7,8,9,10]);
    assert.deepEqual(payload.checks.map((item) => item.name), ["Node 与 zstd", "数据根存在且可写", "端口可用", "服务健康", "凭据可读", "IANA 时区", "索引表可查", "审计文件可写", "计划任务", "data 未被 Git 跟踪"]);
    assert.deepEqual(payload.checks.map((item) => item.fix.split(" ", 1)[0]), process.platform === "win32" ? ["winget", "node", "netstat", "node", "node", "node", "node", "powershell", "node", "git"] : ["npx", "node", "ss", "node", "node", "node", "node", "chmod", "node", "git"]);
    assert.equal(await fs.readFile(path.join(f.dataRoot, "runtime", "deploy.json"), "utf8"), before);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
