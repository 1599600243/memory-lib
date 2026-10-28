import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d8-deploy-"));
test.after(() => fs.rm(root, { recursive: true, force: true }));

test("capture deployment syncs the adapter beside capture with matching hash", async () => {
  const result = spawnSync(process.execPath, ["scripts/sync-capture-deployment.mjs"], { cwd: path.resolve("."), env: { ...process.env, DSH_MEMORY_CAPTURE_DIR: root }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const source = await fs.readFile("adapters/dsh/session-snapshot.mjs");
  const deployed = await fs.readFile(path.join(root, "session-snapshot.mjs"));
  assert.equal(crypto.createHash("sha256").update(source).digest("hex"), crypto.createHash("sha256").update(deployed).digest("hex"));
});
