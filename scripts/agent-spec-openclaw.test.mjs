import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1)));
const capture = path.join(root, "capture-tail.mjs");
const discover = path.join(root, "agent-discover.mjs");
async function run(script, args, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
async function firstZst(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = await firstZst(full); if (found) return found; }
    if (entry.isFile() && entry.name.endsWith(".zst")) return full;
  }
  return null;
}
test("real OpenClaw zstd sample verifies against an isolated capture endpoint", async () => {
  const sample = await firstZst(path.join(process.env.USERPROFILE ?? "C:\\Users\\admin", ".openclaw", "agents"));
  assert.ok(sample, "OpenClaw zstd sample must exist for S2");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-spec-openclaw-"));
  const manifestDir = path.join(tmp, "manifests");
  const state = path.join(tmp, "state.json");
  const evidencePath = path.join(tmp, "openclaw-evidence.md");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(evidencePath, "---\nsource: openclaw\n---\nreal sample\n");
  const discovery = await run(discover, ["--agent", "openclaw", "--write", "--manifest-dir", manifestDir], {});
  assert.equal(discovery.status, 0, discovery.stderr);
  const written = JSON.parse(await fs.readFile(path.join(manifestDir, "openclaw.json"), "utf8"));
  written.write.sources = [{ dirs: [path.dirname(sample)], format: "jsonl-zst", glob: path.basename(sample) }];
  await fs.writeFile(path.join(manifestDir, "openclaw.json"), JSON.stringify(written));
  const server = await new Promise((resolve) => {
    const instance = http.createServer((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, data: { evidencePath, source: JSON.parse(body).source } })); }); });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const port = server.address().port;
    const first = await run(capture, ["--agent", "openclaw", "--once", "--backfill", "--verify", "--manifest-dir", manifestDir, "--state", state], { MEMORY_LIB_URL: `http://127.0.0.1:${port}`, MEMORY_LIB_SECRET: "test-only" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /evidence: .*openclaw-evidence\.md source=openclaw/);
    const second = await run(capture, ["--agent", "openclaw", "--once", "--manifest-dir", manifestDir, "--state", state], { MEMORY_LIB_URL: `http://127.0.0.1:${port}`, MEMORY_LIB_SECRET: "test-only" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /抽出 0 条消息，提交 0 次/);
    console.log(first.stdout.trim());
    console.log(second.stdout.trim());
  } finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(tmp, { recursive: true, force: true }); }
});
