import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { queryAudit } from "../src/admin.mjs";
import { countAuditLines, readAuditLines, readAuditTail } from "../src/audit.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d22-audit-"));
after(async () => fs.rm(root, { recursive: true, force: true }));

function jsonLine(id, extra = {}) {
  return JSON.stringify({ ts: `2026-10-01T00:00:${String(id).padStart(2, "0")}Z`, id, allow: id % 2 === 0, ...extra }) + "\n";
}

test("audit tail matches full-file truth and exposes scan metadata", async () => {
  const file = path.join(root, "tail.jsonl");
  const lines = Array.from({ length: 200 }, (_, i) => jsonLine(i));
  await fs.writeFile(file, lines.join(""));
  const truth = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse).slice(-17).reverse();
  const actual = await queryAudit(file, { limit: 17, chunkBytes: 1024 });
  assert.deepEqual([...actual], truth);
  assert.equal(actual.truncated, false);
  assert.ok(actual.scanned_bytes < Buffer.byteLength(lines.join("")));
});

test("audit tail preserves UTF-8 across block boundaries and ignores a partial final line", async () => {
  const file = path.join(root, "utf8.jsonl");
  const complete = [jsonLine(1, { message: "边界前" }), jsonLine(2, { message: "自动化脚本权限异常" }), jsonLine(3, { message: "边界后" })].join("");
  await fs.writeFile(file, complete + '{"ts":"partial","message":"未写完');
  const actual = await readAuditTail(file, { limit: 3, chunkBytes: 1024 });
  assert.deepEqual(actual.map((event) => event.id), [3, 2, 1]);
  assert.equal(actual[1].message, "自动化脚本权限异常");
});

test("audit tail handles empty, missing, and lines larger than one block", async () => {
  const empty = path.join(root, "empty.jsonl");
  await fs.writeFile(empty, "");
  assert.deepEqual([...(await readAuditTail(empty))], []);
  assert.deepEqual([...(await readAuditTail(path.join(root, "missing.jsonl")))], []);
  const long = path.join(root, "long.jsonl");
  await fs.writeFile(long, jsonLine(1, { message: "长".repeat(10_000) }));
  const [event] = await readAuditTail(long, { limit: 1, chunkBytes: 1024, maxScanBytes: 64 * 1024 });
  assert.equal(event.id, 1);
  assert.equal(event.message.length, 10_000);
});

test("audit tail bounds sparse filtered scans and reports truncation", async () => {
  const file = path.join(root, "bounded.jsonl");
  await fs.writeFile(file, Array.from({ length: 500 }, (_, i) => jsonLine(i, { allow: true })).join(""));
  const actual = await queryAudit(file, { limit: 10, allow: false, maxScanBytes: 4096, chunkBytes: 1024 });
  assert.equal(actual.length, 0);
  assert.equal(actual.truncated, true);
  assert.equal(actual.scanned_bytes, 4096);
});

test("streaming audit count includes a complete non-newline final row and readAuditLines is chronological", async () => {
  const file = path.join(root, "count.jsonl");
  await fs.writeFile(file, jsonLine(1) + jsonLine(2) + JSON.stringify({ id: 3, allow: false }));
  assert.equal(await countAuditLines(file), 3);
  const rows = await readAuditLines(file, { limit: 2 });
  assert.deepEqual(rows.map((row) => row.id), [2, 3]);
});
