import assert from "node:assert/strict";
import test from "node:test";
import { identifierHits, identifierRerankEnabled, queryIdentifiers, rerankByIdentifiers } from "../src/identifier-rerank.mjs";

test("queryIdentifiers extracts latin identifiers and ignores Chinese filler", () => {
  assert.deepEqual(queryIdentifiers("MAINT7 的独立验收结论是什么"), ["maint7"]);
  assert.deepEqual(queryIdentifiers("TZ-CONFIG-1 的根因在哪"), ["tz-config-1"]);
  assert.deepEqual(queryIdentifiers("canSeePath 谁在调用"), ["canseepath"]);
});

test("queryIdentifiers drops stopwords and short tokens", () => {
  assert.deepEqual(queryIdentifiers("the and for how what"), []);
  assert.deepEqual(queryIdentifiers("a b c"), []);
});

test("identifierHits counts case-insensitively", () => {
  assert.equal(identifierHits("见 MAINT7 报告", ["maint7"]), 1);
  assert.equal(identifierHits("见 MAINT7 与 TZ-CONFIG-1", ["maint7", "tz-config-1"]), 2);
  assert.equal(identifierHits("没有", ["maint7"]), 0);
});

test("rerankByIdentifiers promotes candidates whose body mentions the identifier", async () => {
  const results = [
    { path: "a.md" }, { path: "b.md" }, { path: "c.md" },
  ];
  const texts = { "a.md": "验收结论", "b.md": "MAINT7 验收结论", "c.md": "验收" };
  const reranked = await rerankByIdentifiers(results, ["maint7"], async (file) => texts[file] ?? "");
  assert.deepEqual(reranked.map((r) => r.path), ["b.md", "a.md", "c.md"]);
});

test("rerank keeps original order when nothing hits", async () => {
  const results = [{ path: "a.md" }, { path: "b.md" }];
  const reranked = await rerankByIdentifiers(results, ["maint7"], async () => "无关内容");
  assert.deepEqual(reranked.map((r) => r.path), ["a.md", "b.md"]);
});

test("identifierRerankEnabled honours option and env kill switch", () => {
  assert.equal(identifierRerankEnabled({}), true);
  assert.equal(identifierRerankEnabled({ identifierRerank: false }), false);
  const previous = process.env.MEMORY_IDENTIFIER_RERANK;
  process.env.MEMORY_IDENTIFIER_RERANK = "0";
  try { assert.equal(identifierRerankEnabled({}), false); }
  finally { if (previous === undefined) delete process.env.MEMORY_IDENTIFIER_RERANK; else process.env.MEMORY_IDENTIFIER_RERANK = previous; }
});
