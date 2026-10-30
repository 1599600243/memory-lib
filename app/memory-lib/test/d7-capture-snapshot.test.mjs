import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotAndExtract } from "../adapters/dsh/session-snapshot.mjs";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-lib-d7-capture-"));
test.after(() => fsp.rm(tmp, { recursive: true, force: true }));

test("capture decompresses a private snapshot, never the active session file", async () => {
  const source = path.join(tmp, "session.jsonl.zstd");
  const output = path.join(tmp, "out");
  fs.writeFileSync(source, "live source bytes");
  let openedSource = false;
  const result = await snapshotAndExtract(source, output, "session-a", {
    sevenZip: "7z",
    runExtractor(_exe, snapshot, outDir) {
      assert.notEqual(snapshot, source);
      assert.equal(fs.readFileSync(snapshot, "utf8"), "live source bytes");
      fs.writeFileSync(path.join(outDir, "session.jsonl"), "{}");
      openedSource = snapshot === source;
    },
    pid: 10,
    now: () => 20,
  });
  assert.equal(openedSource, false);
  assert.equal(fs.readFileSync(source, "utf8"), "live source bytes");
  assert.equal(fs.readFileSync(result.jsonl, "utf8"), "{}");
});

test("capture snapshot retries transient busy reads with exponential backoff", async () => {
  const source = path.join(tmp, "busy-session.zstd");
  fs.writeFileSync(source, "snapshot bytes");
  let copyAttempts = 0;
  const waits = [];
  const result = await snapshotAndExtract(source, path.join(tmp, "retry"), "session-b", {
    sevenZip: "7z",
    copyFile(src, dst) {
      copyAttempts += 1;
      if (copyAttempts < 3) {
        const error = new Error("busy");
        error.code = "EBUSY";
        throw error;
      }
      fs.copyFileSync(src, dst);
    },
    runExtractor(_exe, _snapshot, outDir) { fs.writeFileSync(path.join(outDir, "session.jsonl"), "ok"); },
    wait: async (ms) => waits.push(ms),
    backoffMs: 7,
    pid: 11,
    now: () => 21,
  });
  assert.equal(copyAttempts, 3);
  assert.deepEqual(waits, [7, 14]);
  assert.equal(fs.readFileSync(result.jsonl, "utf8"), "ok");
});

test("simultaneous session snapshots use isolated output directories", async () => {
  const source = path.join(tmp, "parallel.zstd");
  fs.writeFileSync(source, "parallel bytes");
  let call = 0;
  const results = await Promise.all(["session-c", "session-d"].map((sessionId) => snapshotAndExtract(source, path.join(tmp, "parallel"), sessionId, {
    sevenZip: "7z",
    runExtractor(_exe, _snapshot, outDir) { fs.writeFileSync(path.join(outDir, "session.jsonl"), `${++call}`); },
    pid: 12,
    now: () => 22,
  })));
  assert.notEqual(results[0].runDir, results[1].runDir);
  assert.notEqual(fs.readFileSync(results[0].jsonl, "utf8"), fs.readFileSync(results[1].jsonl, "utf8"));
});
