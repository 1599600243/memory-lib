// MAINT10 —— `deprecate` 的写回分支（memory-lib.mjs:667）从来没被任何测试执行过。
//
// 线上实测：POST /v1/memory/deprecate → 400 {"message":"buildFrontmatter is not defined"}
// 根因：那条分支调用了一个**全仓从未定义**的 buildFrontmatter。
//
// 本文件是它的第一条真实用例：一条真正走到写回路径的 deprecate（先红后绿）。
// 断言都打具体值：落盘 frontmatter 字段、正文逐字节不变、读回仍可读、默认检索不再返回。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-maint10-"));
const principal = { framework_id: "framework-m10", group_id: "group-m10", user_id: "user-m10", agent_id: "agent-m10", role_id: "role-m10", tenant_id: "default" };
const writer = createMemoryWriter({ dataRoot: root });
const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null, principal, ollama: { endpoint: "http://127.0.0.1:1", model: "none", dimension: 1 } });

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const MARK = "MAINT10-DEPRECATE-PROBE";
const BODY = `${MARK} 这条记录只用于验证 deprecate 的写回分支。`;

test("MAINT10 deprecate 走通写回：status/updatedAt/replacementId/reason 落盘、正文逐字节不变、仍可读、默认检索不再返回", async () => {
  const written = await writer.write({ layer: "curated-shared", id: "maint10-probe-private", body: BODY, evidence_refs: ["evidence:maint10"], principal });
  assert.equal(written.created, true, "fixture write must create the record");
  const before = await fs.readFile(written.path, "utf8");
  const beforeFm = parseFrontmatterTyped(before);
  assert.equal(beforeFm.frontmatter.status, "active", "fixture must start active");

  // 1) 写回本身不能抛（修前这里就是 "buildFrontmatter is not defined"）
  const result = await lib.deprecate("maint10-probe-private", "maint10-successor", "superseded by a newer note");
  assert.equal(result.status, "deprecated", `deprecate must report status deprecated, got ${JSON.stringify(result)}`);
  assert.equal(result.id, "maint10-probe-private");

  // 2) 落盘 frontmatter 是具体值
  const after = await fs.readFile(written.path, "utf8");
  const afterFm = parseFrontmatterTyped(after);
  assert.equal(afterFm.frontmatter.status, "deprecated", `on-disk status must be deprecated, got ${JSON.stringify(afterFm.frontmatter.status)}`);
  assert.equal(afterFm.frontmatter.replacementId, "maint10-successor", `replacementId must persist, got ${JSON.stringify(afterFm.frontmatter.replacementId)}`);
  assert.equal(afterFm.frontmatter.deprecationReason, "superseded by a newer note", `deprecationReason must persist, got ${JSON.stringify(afterFm.frontmatter.deprecationReason)}`);
  assert.equal(typeof afterFm.frontmatter.updatedAt, "string", `updatedAt must be written, got ${JSON.stringify(afterFm.frontmatter.updatedAt)}`);
  assert.ok(!Number.isNaN(Date.parse(afterFm.frontmatter.updatedAt)), `updatedAt must be a parseable timestamp, got ${JSON.stringify(afterFm.frontmatter.updatedAt)}`);

  // 3) 正文逐字节不变（只准动 frontmatter 的这四个字段）
  assert.equal(afterFm.body.trim(), beforeFm.body.trim(), "the body must be byte-identical after deprecate");
  assert.ok(afterFm.body.includes(MARK), "the original body text must survive");

  // 4) 其它 frontmatter 字段不被重新渲染/丢失
  for (const key of ["id", "layer", "visibility", "tenant_id", "group_id", "user_id"]) {
    assert.deepEqual(afterFm.frontmatter[key], beforeFm.frontmatter[key], `frontmatter field "${key}" must be unchanged by deprecate`);
  }

  // 5) id 精确读取仍然拿得到（deprecated 不等于删除）
  //    注意：lib.get() 回来的 frontmatter 值是**带引号的**（'"deprecated"'），这里按落盘口径归一。
  const unq = (v) => (typeof v === "string" ? v.trim().replace(/^["']|["']$/gu, "") : v);
  const fetched = await lib.get("maint10-probe-private");
  assert.ok(fetched, "a deprecated record must still be retrievable by id");
  const fetchedStatus = unq(fetched.frontmatter?.status ?? parseFrontmatterTyped(String(fetched.text ?? "")).frontmatter.status);
  assert.equal(fetchedStatus, "deprecated", `the read-back record must expose status=deprecated, got ${JSON.stringify(fetchedStatus)}`);

  // 6) 默认检索不再返回它（memory-lib.mjs:1083 对 status=deprecated 直接过滤）
  //    lib.search() 直接返回结果数组（见 contract.test.mjs 的用法）。
  const hits = await lib.search({ query: MARK, limit: 10, graphExpand: false });
  const rows = Array.isArray(hits) ? hits : (hits?.results ?? []);
  const paths = rows.map((hit) => String(hit.path ?? hit.id ?? ""));
  assert.equal(paths.some((p) => p.includes("maint10-probe-private")), false, `default search must not return a deprecated record, got ${JSON.stringify(paths)}`);
});

test("MAINT10 deprecate 对不存在的 id 仍然失败（不是静默成功）", async () => {
  await assert.rejects(
    () => lib.deprecate("maint10-does-not-exist"),
    /Curated item not found/u,
    "deprecating an unknown id must fail loudly",
  );
});
