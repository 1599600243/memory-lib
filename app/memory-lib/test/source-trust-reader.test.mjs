import assert from "node:assert/strict";
import test from "node:test";
import { createSourceTrustReader } from "../src/source-trust-reader.mjs";

function fixture(map) {
  let reads = 0;
  const stats = new Map();
  const readFile = async (p) => {
    reads += 1;
    if (!map.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const entry = map.get(p);
    if (entry.throw) throw new Error("boom");
    return entry.text;
  };
  const stat = async (p) => {
    if (!map.has(p) || map.get(p).missing) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const entry = map.get(p);
    return { mtimeMs: entry.mtimeMs ?? 1000, size: entry.text ? entry.text.length : 1 };
  };
  return { readFile, stat, reads: () => reads, map, stats };
}

test("reads source_trust from frontmatter", async () => {
  const f = fixture(new Map([["a.md", { text: '---\nsource_trust: "external"\n---\nbody' }]]));
  const reader = createSourceTrustReader(f);
  assert.equal(await reader.trustOf("a.md"), "external");
});

test("legacy file without the field is unknown", async () => {
  const f = fixture(new Map([["old.md", { text: "---\nid: x\n---\nbody" }]]));
  const reader = createSourceTrustReader(f);
  assert.equal(await reader.trustOf("old.md"), "unknown");
});

test("second read of an unchanged file does not hit disk again", async () => {
  const f = fixture(new Map([["a.md", { text: "---\nsource_trust: internal\n---\n" }]]));
  const reader = createSourceTrustReader(f);
  assert.equal(await reader.trustOf("a.md"), "internal");
  const afterFirst = f.reads();
  assert.equal(await reader.trustOf("a.md"), "internal");
  assert.equal(f.reads(), afterFirst, "unchanged file must be served from cache");
  assert.equal(reader.size, 1);
});

test("mtime change invalidates the cache and re-reads", async () => {
  const entry = { text: "---\nsource_trust: internal\n---\n", mtimeMs: 1000 };
  const f = fixture(new Map([["a.md", entry]]));
  const reader = createSourceTrustReader({ ...f, ttlMs: 0 });
  assert.equal(await reader.trustOf("a.md"), "internal");
  entry.text = "---\nsource_trust: external\n---\n";
  entry.mtimeMs = 2000;
  assert.equal(await reader.trustOf("a.md"), "external");
  assert.equal(f.reads(), 2);
});

test("unreadable or missing files yield unknown without throwing", async () => {
  const f = fixture(new Map([["missing.md", { missing: true }], ["bad.md", { text: "---\n", throw: true }]]));
  const reader = createSourceTrustReader(f);
  assert.equal(await reader.trustOf("missing.md"), "unknown");
  assert.equal(await reader.trustOf("bad.md"), "unknown");
  assert.equal(await reader.trustOf(""), "unknown");
  assert.equal(await reader.trustOf(null), "unknown");
});

test("cache is bounded and evicts oldest entries", async () => {
  const f = fixture(new Map([
    ["a.md", { text: "---\nsource_trust: internal\n---\n" }],
    ["b.md", { text: "---\nsource_trust: internal\n---\n" }],
    ["c.md", { text: "---\nsource_trust: internal\n---\n" }],
  ]));
  const reader = createSourceTrustReader({ ...f, maxEntries: 2 });
  await reader.trustOf("a.md");
  await reader.trustOf("b.md");
  await reader.trustOf("c.md");
  assert.ok(reader.size <= 2, `cache size ${reader.size} must stay bounded`);
});

test("quoted and padded values are unquoted", async () => {
  const f = fixture(new Map([["q.md", { text: "---\nsource_trust: 'External'\n---\n" }]]));
  const reader = createSourceTrustReader(f);
  assert.equal(await reader.trustOf("q.md"), "External");
});

test("ttl window skips stat and readFile entirely", async () => {
  let statCalls = 0;
  const f = fixture(new Map([["a.md", { text: "---\nsource_trust: external\n---\n", mtimeMs: 1 }]]));
  const stat = async (p) => { statCalls += 1; return f.stat(p); };
  const reader = createSourceTrustReader({ ...f, stat, ttlMs: 60000 });
  assert.equal(await reader.trustOf("a.md"), "external");
  const statAfterFirst = statCalls;
  assert.equal(await reader.trustOf("a.md"), "external");
  assert.equal(statCalls, statAfterFirst, "within ttl the reader must not stat the file again");
});
