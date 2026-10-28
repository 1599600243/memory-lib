import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d9-deploy-"));
test.after(() => fs.rm(root, { recursive: true, force: true }));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("D9.1 sync deploys the repository poller and adapter byte-for-byte", async () => {
  const result = spawnSync(process.execPath, ["scripts/sync-capture-deployment.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, DSH_MEMORY_CAPTURE_DIR: root },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.files.length, 2);
  for (const [source, destination] of [
    ["adapters/dsh/poll-capture.mjs", path.join(root, "capture.mjs")],
    ["adapters/dsh/session-snapshot.mjs", path.join(root, "session-snapshot.mjs")],
  ]) {
    const sourceBytes = await fs.readFile(source);
    const deployedBytes = await fs.readFile(destination);
    assert.equal(sha256(deployedBytes), sha256(sourceBytes), destination);
  }
});

test("D30 poller captures evidence without the retired summary contract", async () => {
  const source = await fs.readFile("adapters/dsh/poll-capture.mjs", "utf8");
  assert.doesNotMatch(source, /\/v1\/conversations\/summarize/u);
  assert.doesNotMatch(source, /summaryErrors|summarySkipped|summarizedTurn|summarizedAt|_summarizedAt|_summarizedTurn/u);
  assert.match(source, /SESSION_DIR_PATTERN\.test\(entry\.name\)/u);
  assert.match(source, /MEMORY_LIB_CAPTURE_SESSION_ID/u);
  assert.match(source, /evidence_written:\s*evidenceWritten/u);
  assert.match(source, /candidates_created:\s*candidatesCreated/u);
  assert.doesNotMatch(source, /submitted:\s*evidenceWritten/u, "ambiguous submitted metric must not mask evidence writes");
  assert.match(source, /OK[^\n]*evidence_written=1[^\n]*candidates_created=\$\{Number\(result\.candidateCount \?\? 0\)\}/u);
  assert.match(source, /DONE[^\n]*evidence_written=\$\{evidenceWritten\}[^\n]*candidates_created=\$\{candidatesCreated\}/u);
  assert.match(source, /rotateLog/u);
  assert.match(source, /MEMORY_LIB_CAPTURE_ROLE \?\? "capture-ingest"/u);
  assert.doesNotMatch(source, /X-MCP-Role|X-MCP-Agent/u);
  assert.match(source, /MEMORY_LIB_AGENT \?\? "pilot-01"/u);
});
