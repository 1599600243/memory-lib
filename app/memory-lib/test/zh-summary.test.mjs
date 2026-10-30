// memory-lib — F6 中文摘要 sidecar + 控制台渲染（隔离测试，不依赖 Ollama / 生产数据）。
// Run directly: node test/zh-summary.test.mjs
//
// 覆盖：
//   1. 路径规范化（分隔符 / 盘符大小写 / `..`）——sidecar 按**规范化路径**建键（不是 id）
//   2. sidecar 存在：list / get / search 结果**附加** summaryZh(+keyPoints)
//   3. 缺失路径不附加（id 命中但路径不匹配 → 不得附加，证明按路径而非 id）
//   4. sidecar 缺失 / JSON 损坏 / 关闭：不报错、不加字段，英文原文回退（响应形状与改动前一致）
//   5. 控制台渲染：中文摘要优先、英文原文可折叠、缺失回退英文、内容转义
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { attachZhSummary, loadSummaryIndex, normalizeSummaryKey } from "../src/zh-summary-index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-zh-summary-"));
const WORKSPACE = path.join(TMP, "workspace");
const DATA = path.join(WORKSPACE, "memory");
const SHARED = path.join(DATA, "curated", "shared");
// 隔离：向量车道指向一个必然不可达的端口，检索走文件/词法车道（不需要 Ollama）
const DEAD_OLLAMA = { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 };

const MEM_A = path.join(SHARED, "2026-09-18T00-00-00-000Z-shared-zh000001.md");
const MEM_B = path.join(SHARED, "2026-09-18T00-00-01-000Z-shared-zh000002.md");
const SIDECAR = path.join(TMP, "zh-summary.json");
const BROKEN_SIDECAR = path.join(TMP, "zh-summary-broken.json");

function memoryFile(id, updatedAt, body) {
  return `---\nid: ${id}\nscope: shared\nstatus: promoted\nupdatedAt: ${updatedAt}\n---\n# Memory\n\n${body}\n`;
}

await fs.mkdir(SHARED, { recursive: true });
await fs.writeFile(MEM_A, memoryFile("shared-zh000001", "2026-09-18T00:00:00.000Z", "Approval workflow requires a second reviewer."), "utf8");
await fs.writeFile(MEM_B, memoryFile("shared-zh000002", "2026-09-18T00:00:01.000Z", "Rollback plan keeps the previous release available."), "utf8");
// sidecar：MEM_A 命中；另一条刻意「id 命中但路径不存在」——不允许按 id 附加
await fs.writeFile(SIDECAR, JSON.stringify({
  generatedAt: "2026-09-19T00:00:00.000Z",
  model: "qwen3:latest",
  results: [
    { path: MEM_A, id: "shared-zh000001", updatedAt: "2026-09-18T00:00:00.000Z", summaryZh: "审批流程需要第二审核人", keyPoints: ["审批需双人复核", "例外需管理员批准"] },
    { path: path.join(SHARED, "no-such-file.md"), id: "shared-zh000002", updatedAt: "", summaryZh: "不该出现：id 命中但路径不匹配" },
  ],
  failures: [],
  skipped: [],
}), "utf8");
await fs.writeFile(BROKEN_SIDECAR, "{ not json", "utf8");

const lib = (options = {}) => createMemoryLib({ dataRoot: DATA, workspaceRoot: WORKSPACE, scopes: null, ollama: DEAD_OLLAMA, indexRefresh: false, ...options });

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// --- 1. 路径规范化 ------------------------------------------------------------

test("zh-summary：路径规范化（分隔符 / 大小写 / .. / 结尾分隔符）", () => {
  const canonical = normalizeSummaryKey("I:/OpenClaw/memory-data/memory/curated/shared/a.md");
  assert.equal(normalizeSummaryKey("I:\\OpenClaw\\memory-data\\memory\\curated\\shared\\a.md"), canonical);
  assert.equal(normalizeSummaryKey("i:\\openclaw\\MEMORY-DATA\\memory\\curated\\shared\\a.md"), canonical);
  assert.equal(normalizeSummaryKey("I:\\OpenClaw\\memory-data\\memory\\curated\\other\\..\\shared\\a.md"), canonical);
  assert.equal(normalizeSummaryKey("I:/OpenClaw/memory-data/memory/curated/shared/a.md/"), canonical);
  assert.equal(normalizeSummaryKey("   " + canonical + "  "), canonical);
  assert.equal(normalizeSummaryKey(""), null);
  assert.equal(normalizeSummaryKey(null), null);
});

test("zh-summary：索引按路径键控，未命中的路径返回 null", () => {
  const index = loadSummaryIndex(SIDECAR);
  // 索引收录所有「有 path + 有 summaryZh」的条目（含指向不存在文件的条目——它只是不会命中任何记忆）
  assert.equal(index.size, 2);
  assert.ok(index.get(MEM_A));
  assert.equal(index.get(MEM_B), null);
  assert.equal(index.get(path.join(SHARED, "no-such-file.md"))?.summaryZh.includes("不该出现"), true);
  assert.equal(index.get("I:\\no\\such\\file.md"), null);
});

// --- 2/3. list / get / search 附加摘要 ---------------------------------------

test("zh-summary：/memory/list 语义（listMemories）按路径附加 summaryZh + keyPoints", async () => {
  const items = await lib({ summaryIndex: SIDECAR }).listMemories({ limit: 50 });
  const hit = items.find((item) => item.path === MEM_A);
  const miss = items.find((item) => item.path === MEM_B);
  assert.ok(hit && miss, "两条 fixture 记忆都应被列出");
  assert.equal(hit.summaryZh, "审批流程需要第二审核人");
  assert.deepEqual(hit.keyPoints, ["审批需双人复核", "例外需管理员批准"]);
  // 未命中（含「id 命中但路径不匹配」）→ 连字段都不出现
  assert.equal(Object.hasOwn(miss, "summaryZh"), false);
  assert.equal(Object.hasOwn(miss, "keyPoints"), false);
  assert.equal(items.some((item) => String(item.summaryZh ?? "").includes("不该出现")), false);
  // 原有字段不受影响
  assert.equal(hit.id, "shared-zh000001");
  assert.ok(hit.body.includes("second reviewer"));
});

test("zh-summary：/get 语义（get）按路径附加 summaryZh；未命中保持原形状", async () => {
  const withIndex = lib({ summaryIndex: SIDECAR });
  const hit = await withIndex.get("shared-zh000001");
  assert.equal(hit.summaryZh, "审批流程需要第二审核人");
  assert.deepEqual(hit.keyPoints, ["审批需双人复核", "例外需管理员批准"]);
  const miss = await withIndex.get("shared-zh000002");
  assert.equal(Object.hasOwn(miss, "summaryZh"), false);
  assert.ok(miss.body.includes("Rollback plan"));
});

test("zh-summary：/search 语义（search）按路径附加 summaryZh", async () => {
  const results = await lib({ summaryIndex: SIDECAR }).search({ query: "second reviewer", limit: 5, graphExpand: false });
  const hit = results.find((result) => result.path === MEM_A);
  assert.ok(hit, "词法车道应命中 approval fixture");
  assert.equal(hit.summaryZh, "审批流程需要第二审核人");
  assert.ok(Array.isArray(hit.keyPoints));
  assert.ok(hit.excerpt.includes("Approval workflow"));
});

// --- 4. 缺失 / 损坏 / 关闭 → 英文回退，形状不变 --------------------------------

test("zh-summary：sidecar 缺失 → 不加字段（英文回退），且结果与未注入索引一致", async () => {
  const withMissing = lib({ summaryIndex: path.join(TMP, "no-sidecar-here.json") });
  const withoutIndex = lib();
  const missingItems = await withMissing.listMemories({ limit: 50 });
  const plainItems = await withoutIndex.listMemories({ limit: 50 });
  assert.deepEqual(
    missingItems.map((item) => Object.keys(item)),
    plainItems.map((item) => Object.keys(item)),
    "sidecar 缺失时必须与未注入索引的响应形状完全一致",
  );
  assert.equal(missingItems.some((item) => Object.hasOwn(item, "summaryZh")), false);
  const got = await withMissing.get("shared-zh000001");
  assert.equal(Object.hasOwn(got, "summaryZh"), false);
  const results = await withMissing.search({ query: "second reviewer", limit: 5, graphExpand: false });
  assert.equal(results.some((result) => Object.hasOwn(result, "summaryZh")), false);
});

test("zh-summary：sidecar JSON 损坏 → 不抛错、不加字段（英文回退）", async () => {
  const items = await lib({ summaryIndex: BROKEN_SIDECAR }).listMemories({ limit: 50 });
  assert.ok(items.length >= 2);
  assert.equal(items.some((item) => Object.hasOwn(item, "summaryZh")), false);
});

test("zh-summary：索引来源形状（关闭标记 / 数组 / 容器对象 / Map / 已加载索引）", () => {
  assert.equal(loadSummaryIndex("none"), null);
  assert.equal(loadSummaryIndex("off"), null);
  assert.equal(loadSummaryIndex(""), null);
  assert.equal(loadSummaryIndex(null), null);
  const entry = { path: MEM_A, summaryZh: "来自数组" };
  assert.equal(loadSummaryIndex([entry, { path: "", summaryZh: "无路径被丢弃" }, { path: MEM_B, summaryZh: "   " }]).size, 1);
  assert.equal(loadSummaryIndex({ results: [entry] }).size, 1);
  assert.equal(loadSummaryIndex({ items: [entry] }).size, 1);
  assert.equal(loadSummaryIndex(new Map([[MEM_A, entry]])).size, 1);
  const index = loadSummaryIndex(SIDECAR);
  assert.equal(loadSummaryIndex(index), index);
  // 纯函数：未命中时原样返回同一个对象（连字段都不加）
  const item = { path: MEM_B, id: "x" };
  assert.equal(attachZhSummary(item, index), item);
  assert.equal(attachZhSummary(item, null), item);
});

test("zh-summary：sidecar 重新生成后无需重启（按 mtime/size 失效重载）", async () => {
  const regenerated = path.join(TMP, "zh-summary-regenerated.json");
  await fs.writeFile(regenerated, JSON.stringify({ results: [{ path: MEM_B, summaryZh: "第一版" }] }), "utf8");
  const cachedLib = lib({ summaryIndex: regenerated });
  const before = await cachedLib.get("shared-zh000002");
  assert.equal(before.summaryZh, "第一版");
  await fs.writeFile(regenerated, JSON.stringify({ results: [{ path: MEM_B, summaryZh: "第二版：重新生成后立即可见" }, { path: MEM_A, summaryZh: "顺带补上 A" }] }), "utf8");
  const afterReload = await cachedLib.get("shared-zh000002");
  assert.equal(afterReload.summaryZh, "第二版：重新生成后立即可见");
  assert.equal((await cachedLib.get("shared-zh000001")).summaryZh, "顺带补上 A");
});

// --- 5. 控制台渲染 -----------------------------------------------------------

// 从 web/console.html 抽出真实渲染函数（纯函数，不依赖 DOM），用真实 esc/badge 断言转义。
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `console.html 未找到 function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`console.html: function ${name} 大括号不平衡`);
}

const consoleHtml = await fs.readFile(path.join(ROOT, "web", "console.html"), "utf8");
const consoleRender = new Function(
  "scopeLabel",
  "candidateSummary",
  `${["esc", "badge", "zhFirst", "searchResultCard", "memoryCard"].map((name) => extractFunction(consoleHtml, name)).join("\n")}
   return { memoryCard, searchResultCard };`,
)((scope) => String(scope || ""), (body) => String(body || "").replace(/^\s*#\s*Candidate Memory\s*\r?\n?/i, "").trim());

test("console：有中文摘要 → 中文在前、英文原文折叠、显示摘要标记与要点", () => {
  const html = consoleRender.memoryCard({
    id: "shared-zh000001",
    path: MEM_A,
    frontmatter: { title: "Approval workflow", scope: "shared", updatedAt: "2026-09-18T00:00:00.000Z" },
    body: "Approval workflow requires a second reviewer.",
    summaryZh: "审批流程需要第二审核人",
    keyPoints: ["审批需双人复核", "例外需管理员批准"],
  });
  const zhAt = html.indexOf("审批流程需要第二审核人");
  const enAt = html.indexOf("Approval workflow requires a second reviewer.");
  assert.ok(zhAt >= 0, "应显示中文摘要");
  assert.ok(enAt >= 0, "英文原文仍应可读到（折叠区）");
  assert.ok(zhAt < enAt, "中文摘要必须排在英文原文之前");
  assert.match(html, /<details[^>]*><summary>查看英文原文<\/summary>/, "英文原文应在可折叠的 details 中");
  assert.ok(html.includes("中文摘要"), "应显示中文摘要标记");
  assert.ok(html.includes("审批需双人复核") && html.includes("例外需管理员批准"), "应显示关键要点");
  assert.ok(html.includes(MEM_A.replace(/\\/g, "\\")), "技术信息保留路径");
});

test("console：无中文摘要 → 直接显示英文原文（回退），不出现折叠壳与标记", () => {
  const html = consoleRender.memoryCard({
    id: "shared-zh000002",
    path: MEM_B,
    frontmatter: { title: "Rollback plan", scope: "shared", updatedAt: "2026-09-18T00:00:01.000Z" },
    body: "Rollback plan keeps the previous release available.",
  });
  assert.ok(html.includes("Rollback plan keeps the previous release available."), "英文原文应直接可见");
  assert.equal(html.includes("查看英文原文"), false, "无摘要时不应出现「查看英文原文」折叠");
  assert.equal(html.includes("中文摘要"), false, "无摘要时不应出现中文摘要标记");
  assert.ok(html.includes("<details"), "技术信息折叠仍保留");
});

test("console：检索结果卡同样中文优先 / 缺失回退，且内容被转义", () => {
  const withSummary = consoleRender.searchResultCard({ sourceType: "curated", path: MEM_A, line: 3, excerpt: "Approval workflow requires a second reviewer.", summaryZh: "审批流程需要第二审核人<script>alert(1)</script>" });
  assert.ok(withSummary.indexOf("审批流程需要第二审核人") < withSummary.indexOf("Approval workflow requires"), "检索卡中文摘要在前");
  assert.equal(withSummary.includes("<script>"), false, "摘要内容必须转义");
  assert.ok(withSummary.includes("&lt;script&gt;"));
  const plain = consoleRender.searchResultCard({ sourceType: "curated", path: MEM_B, line: 1, excerpt: "Rollback plan keeps the previous release available." });
  assert.ok(plain.includes("Rollback plan keeps the previous release available."));
  assert.equal(plain.includes("查看英文原文"), false);
});
