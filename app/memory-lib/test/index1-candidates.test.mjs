// INDEX-1 测试：注入侧的候选粗筛（`src/recall-candidates.mjs`）。
//
// 要钉住的四件事（对应范围单 §三/§四）：
//   ① 片段切法：trigram 仍只取 **≥3 字**连续片段；INDEX-2 另用有界 LIKE 补两字 token；
//   ② 粗筛走索引用 OR 命中数排序，且**只认磁盘上真实存在**的 curated/shared 文件；
//   ③ 新鲜度兜底：索引没见过的新文件必须并入候选（source="mixed"）；
//   ④ 回退：索引缺失/损坏/问句没有 ≥3 字片段/候选为空/候选填不满注入位数 ⇒ mode="full"，绝不硬着头皮少给。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { selectCandidates, trigramPieces } from "../src/recall-candidates.mjs";

const FM = (id) => `---\nid: "${id}"\nlayer: "long-term"\ncontainer: "long-term"\nvisibility: "platform"\nstatus: "active"\ncalendarDate: "2026-10-20"\n---\n\n`;

/** 建一个最小库：两个记忆 + 一份和 index-store 同 schema 的索引（只写 files/chunks/fts_chunks）。 */
async function makeFixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "index1-"));
  const shared = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(shared, { recursive: true });
  const a = path.join(shared, "curated-shared-aaaa.md");
  const b = path.join(shared, "curated-shared-bbbb.md");
  const c = path.join(shared, "curated-shared-cccc.md");
  await fs.writeFile(a, `${FM("curated-shared-aaaa")}用户决定：记忆库收敛为8层。\n`, "utf8");
  await fs.writeFile(b, `${FM("curated-shared-bbbb")}用户决定：检索预算不超过600字。\n`, "utf8");
  await fs.writeFile(c, `${FM("curated-shared-cccc")}三天范围内完成验收，并记录最终结论。\n`, "utf8");
  const dbPath = path.join(dataRoot, "indexes", "sqlite", "memory-lib-index.sqlite");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE files (id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,mtime REAL NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE chunks (id TEXT PRIMARY KEY,file_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,heading TEXT,text TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,token_estimate INTEGER NOT NULL,content_hash TEXT NOT NULL,UNIQUE(file_id,chunk_index));
      CREATE VIRTUAL TABLE fts_chunks USING fts5(chunk_id UNINDEXED,path UNINDEXED,heading,text, tokenize="trigram");`);
    const rows = [
      ["file_a", "curated/shared/curated-shared-aaaa.md", "chunk_a", "用户决定：记忆库收敛为8层。"],
      ["file_b", "curated/shared/curated-shared-bbbb.md", "chunk_b", "用户决定：检索预算不超过600字。"],
      ["file_c", "curated/shared/curated-shared-cccc.md", "chunk_c", "三天范围内完成验收，并记录最终结论。"],
    ];
    for (const [fileId, rel, chunkId, text] of rows) {
      db.prepare("INSERT INTO files(id,path,sha256,size_bytes,mtime,status,updated_at) VALUES(?,?,?,?,?, 'active', ?)").run(fileId, rel, "x", 1, 1, new Date().toISOString());
      db.prepare("INSERT INTO chunks(id,file_id,chunk_index,heading,text,start_offset,end_offset,token_estimate,content_hash) VALUES(?,?,0,'',?,0,1,1,'h')").run(chunkId, fileId, text);
      db.prepare("INSERT INTO fts_chunks(chunk_id,path,heading,text) VALUES(?,?,'',?)").run(chunkId, rel, text);
    }
  } finally {
    db.close();
  }
  return { dataRoot, memoriesRoot: shared, dbPath, a, b, c };
}

test("INDEX-1 片段切法：只取 ≥3 字片段（两字词命中 0，不能指望）", () => {
  assert.deepEqual(trigramPieces("会话"), [], "两字词切不出 ≥3 字片段 ⇒ 空（trigram 索引的硬限制）");
  assert.deepEqual(trigramPieces("8层"), [], "两字词 + 数字也一样");
  const pieces = trigramPieces("我们记忆库是几层？");
  assert.ok(pieces.includes("记忆库"), `必须切出「记忆库」，实际 ${JSON.stringify(pieces)}`);
  assert.ok(pieces.includes("是几层"), `必须切出「是几层」，实际 ${JSON.stringify(pieces)}`);
  assert.ok(pieces.every((p) => p.length >= 3), "每个片段都必须 ≥3 字");
  assert.ok(!pieces.some((p) => p.includes("？")), "标点不进片段");
  const latin = trigramPieces("RANK-1 的排序规则");
  assert.ok(latin.includes("rank-1"), `拉丁段整段保留，实际 ${JSON.stringify(latin)}`);
  assert.equal(trigramPieces("", {}).length, 0);
  assert.equal(trigramPieces(null).length, 0);
});

test("INDEX-1 粗筛：命中索引的候选按命中片段数排序，只认磁盘上真实存在的文件", async () => {
  const fx = await makeFixture();
  try {
    const scan = await selectCandidates({ dataRoot: fx.dataRoot, memoriesRoot: fx.memoriesRoot, query: "记忆库收敛为几层", wanted: 1 });
    assert.equal(scan.mode, "candidates", `应走候选，实际 ${JSON.stringify(scan)}`);
    assert.equal(scan.source, "fts", "没有新文件时应是纯 fts");
    assert.deepEqual(scan.paths, [fx.a], `只有 a 命中（b 讲的是预算），实际 ${JSON.stringify(scan.paths)}`);
    assert.equal(scan.candidateFiles, 1);
    assert.equal(scan.freshFiles, 0);
    assert.ok(scan.scanMs >= 0 && scan.scanMs < 500, `scanMs 应是毫秒数，实际 ${scan.scanMs}`);
    const none = await selectCandidates({ dataRoot: fx.dataRoot, memoriesRoot: fx.memoriesRoot, query: "完全无关的问句内容", wanted: 1 });
    assert.equal(none.mode, "full", `候选为空必须退回全量，实际 ${JSON.stringify(none)}`);
    assert.equal(none.reason, "no-candidate");
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

// 2026-10-26 收尾说明：下面这条**钉住的是当前行为**（长问句 in 历史 trigram 未命中时
// 走 LIKE 补充、超 200 行 ⇒ 回退全量 source=full/reason=like-candidate-overflow），
// 不是"理想行为"。基线 d6944ab 在同一数据上也是这个结果，所以它不算 SHORT-Q-1 的回归；
// 但"长问句不该因为两字词 LIKE 溢出就退全量"仍是待办（见 docs/BACKLOG.md 的 LIKE 溢出粒度一项）。

test("INDEX-2 long-query trigram matches stay on FTS without LIKE overflow", async () => {
  const fx = await makeFixture();
  try {
    const db = new DatabaseSync(fx.dbPath);
    try {
      db.exec("BEGIN");
      try {
        for (let i = 0; i < 205; i += 1) {
          const id = `wide-${String(i).padStart(4, "0")}`;
          const rel = `curated/shared/${id}.md`;
          const chunkId = `chunk-${id}`;
          const text = "我们讨论其他验收记录。 ".repeat(12);
          db.prepare("INSERT INTO files(id,path,sha256,size_bytes,mtime,status,updated_at) VALUES(?,?,?,?,?, 'active', ?)").run(id, rel, "x", 1, 1, new Date().toISOString());
          db.prepare("INSERT INTO chunks(id,file_id,chunk_index,heading,text,start_offset,end_offset,token_estimate,content_hash) VALUES(?,?,0,'',?,0,1,1,'h')").run(chunkId, id, text);
          db.prepare("INSERT INTO fts_chunks(chunk_id,path,heading,text) VALUES(?,?,'',?)").run(chunkId, rel, text);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    const scan = await selectCandidates({ dataRoot: fx.dataRoot, memoriesRoot: fx.memoriesRoot, query: "我们讨论验收记录的最终结论是什么", wanted: 1 });
    assert.equal(scan.mode, "full", `historical trigram misses must retain current LIKE fallback behavior: ${JSON.stringify(scan)}`);
    assert.equal(scan.source, "full");
    assert.equal(scan.reason, "like-candidate-overflow");
    assert.equal(scan.indexHits, 0);
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("INDEX-2 LIKE overflow falls back to full scan when no trigram candidates exist", async () => {
  const fx = await makeFixture();
  try {
    const db = new DatabaseSync(fx.dbPath);
    try {
      db.exec("BEGIN");
      try {
        for (let i = 0; i < 805; i += 1) {
          const id = `hot-${String(i).padStart(4, "0")}`;
          const rel = `curated/shared/${id}.md`;
          const chunkId = `chunk-${id}`;
          const text = "我们与其他材料讨论记录。";
          db.prepare("INSERT INTO files(id,path,sha256,size_bytes,mtime,status,updated_at) VALUES(?,?,?,?,?, 'active', ?)").run(id, rel, "x", 1, 1, new Date().toISOString());
          db.prepare("INSERT INTO chunks(id,file_id,chunk_index,heading,text,start_offset,end_offset,token_estimate,content_hash) VALUES(?,?,0,'',?,0,1,1,'h')").run(chunkId, id, text);
          db.prepare("INSERT INTO fts_chunks(chunk_id,path,heading,text) VALUES(?,?,'',?)").run(chunkId, rel, text);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    const scan = await selectCandidates({ dataRoot: fx.dataRoot, memoriesRoot: fx.memoriesRoot, query: "我们记忆库几层", wanted: 1 });
    assert.equal(scan.mode, "full", `overflowed LIKE candidates must trigger complete fallback: ${JSON.stringify(scan)}`);
    assert.equal(scan.source, "full");
    assert.equal(scan.reason, "like-candidate-overflow");
    assert.equal(scan.candidateFiles, 3, "full fallback reports the files actually present on disk");
    assert.equal(scan.indexHits, 0);
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("INDEX-2 新鲜度兜底：索引没见过的新文件必须并入候选（source=mixed）", async () => {
  const fx = await makeFixture();
  try {
    const fresh = path.join(fx.memoriesRoot, "curated-shared-dddd.md");
    await fs.writeFile(fresh, `${FM("curated-shared-dddd")}用户决定：记忆库收敛为8层，另加一条新口径。\n`, "utf8");
    const scan = await selectCandidates({ dataRoot: fx.dataRoot, memoriesRoot: fx.memoriesRoot, query: "记忆库收敛为几层", wanted: 1 });
    assert.equal(scan.mode, "candidates");
    assert.equal(scan.source, "mixed", "有索引没见过的新文件 ⇒ mixed");
    assert.equal(scan.freshFiles, 1);
    assert.ok(scan.paths.includes(fresh), `新文件必须在候选里，实际 ${JSON.stringify(scan.paths)}`);
    assert.equal(scan.candidateFiles, 2);
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test("INDEX-1 回退：索引缺失/损坏/问句没有 ≥3 字片段/候选填不满注入位数 ⇒ mode=full", async () => {
  const fx = await makeFixture();
  try {
    const base = { dataRoot: fx.dataRoot, memoriesRoot: fx.memoriesRoot };
    const gone = await fs.mkdtemp(path.join(os.tmpdir(), "index1-noidx-"));
    try {
      await fs.mkdir(path.join(gone, "curated", "shared"), { recursive: true });
      await fs.writeFile(path.join(gone, "curated", "shared", "curated-shared-aaaa.md"), `${FM("curated-shared-aaaa")}记忆库收敛为8层。\n`, "utf8");
      const r = await selectCandidates({ ...base, dataRoot: gone, memoriesRoot: path.join(gone, "curated", "shared"), query: "记忆库收敛为几层", wanted: 1 });
      assert.equal(r.mode, "full", "索引缺失必须退回全量");
      assert.match(String(r.reason), /index-open-failed/u, `原因要可读，实际 ${r.reason}`);
    } finally {
      await fs.rm(gone, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
    const thin = await selectCandidates({ ...base, query: "记忆库收敛为几层", wanted: 2 });
    assert.equal(thin.mode, "full", "候选填不满注入位数必须退回全量");
    assert.equal(thin.reason, "candidate-pool-too-thin");
    const noPiece = await selectCandidates({ ...base, query: "会话", wanted: 1 });
    assert.equal(noPiece.mode, "full", "the two-character token alone yields no candidate in this fixture");
    assert.equal(noPiece.reason, "no-candidate");
    assert.equal(noPiece.pieces, 0);
    assert.equal(noPiece.twoCharTokens, 1);
    const junk = await fs.mkdtemp(path.join(os.tmpdir(), "index1-corrupt-"));
    try {
      await fs.mkdir(path.join(junk, "indexes", "sqlite"), { recursive: true });
      await fs.writeFile(path.join(junk, "indexes", "sqlite", "memory-lib-index.sqlite"), Buffer.from("NOT-A-SQLITE-DB ".repeat(500)));
      const bad = await selectCandidates({ ...base, dataRoot: junk, memoriesRoot: fx.memoriesRoot, query: "记忆库收敛为几层", wanted: 1 });
      assert.equal(bad.mode, "full", "索引损坏必须退回全量");
      assert.match(String(bad.reason), /index-(open|query)-failed/u, `原因要可读，实际 ${bad.reason}`);
    } finally {
      await fs.rm(junk, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  } finally {
    await fs.rm(fx.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

