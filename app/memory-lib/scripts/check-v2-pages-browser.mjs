// 真浏览器验证 8 个新页面：临时静态服务 + CDP + fetch 桩
// 用法：node scripts/check-v2-pages-browser.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/v2/index.html");
const PORT = 8799;
const CDP_PORT = 9341;
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const FIXTURES = {
  "/v1/memory/stats": { ok: true, totals: { memories: 1, evidence: 1 }, identities: [], sources: [] },
  "/v1/memory/list": { ok: true, items: [
    { id: "doc-1", path: "knowledge/fixture.md", layer: "knowledge", source: "fixture", updated_at: "2026-01-01", frontmatter: { layer: "knowledge" } },
    { id: "doc-2", path: "curated/shared/fixture-longterm.md", layer: "long-term", source: "fixture", updated_at: "2026-01-02" },
  ] },
  "/v1/health": { ok: true, service: "memory-lib", version: 1, health: { status: "healthy" }, vector: {}, index: {}, audit_rotation: {} },
  "/v1/knowledge/list": { ok: true, count: 1, items: [{ id: "fixture-doc", path: "evidence/documents/fixture.md", title: "fixture 知识文档", source: "fixture", updated_at: "2026-01-01" }] },
  "/v1/roles/list": { ok: true, items: [{ id: "fixture-role", kind: "lesson", confidence: "high", status: "active", sections: { 经验: "fixture 经验内容" } }] },
  "/v1/tools/list": { ok: true, items: [{ id: "fixture-tool", tool_name: "fixture-tool", kind: "cli", env: "win-local", verified_at: "2026-01-01", status: "active" }] },
  "/v1/project/list": { ok: true, items: [{
    project: "fixture-project",
    code_graph: { registered: true, state: "EXISTING", files: 372, nodes: 3210, edges: 8355, last_built_at: "2026-10-31T14:20:50.000Z", stale_reasons: [] },
    code_refs: [{ type: "file", value: "visibility.mjs", file: "src/visibility.mjs", line: 34 }],
    current_state: { status: "active", updated_at: "2026-01-03T00:00:00Z", path: "fixture.md" },
    decisions: [{ id: "d1", updated_at: "2026-01-02T00:00:00Z" }],
    progress: { path: "fixture-progress.md", updated_at: "2026-01-01T00:00:00Z" },
  }] },
  "/v1/plans/list": { ok: true, items: [{ topic: "fixture-plan", status: "active", updated_at: "2026-01-01" }] },
  "/v1/profile/list": { ok: true, items: [{ id: "fixture-profile", summary: "fixture summary", source: "fixture", updated_at: "2026-01-01" }] },
  "/v1/learning/plan_get": { ok: true, plan: { modules: [{ title: "fixture module" }] } },
  "/v1/learning/progress_get": { ok: true, progress: { completed: 1 } },
  "/v1/learning/review_get": { ok: true, review: { due: 1 } },
  "/v1/pet/runtime/persona/list": { ok: true, personas: [{ id: "fixture-persona", content: "persona fixture" }] },
  "/v1/pet/runtime/drafts/list": { ok: true, drafts: [{ id: "fixture-draft", content: "draft fixture" }] },
  "/v1/graph/dump": { ok: true, nodes: [
    { id: "fixture-project", type: "project", label: "fixture project" },
    { id: "fixture-memory", type: "memory", label: "fixture memory" },
    { id: "fixture-tag", type: "tag", label: "fixture tag" },
  ], edges: [
    { src_id: "fixture-project", predicate: "contains", dst_id: "fixture-memory", evidence_id: "fixture-evidence-1" },
    { src_id: "fixture-memory", predicate: "tagged", dst_id: "fixture-tag", evidence_id: "fixture-evidence-2" },
  ], totals: { nodes: 3, edges: 2, truncated: false } },
};

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/index")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(HTML, "utf8"));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-v2-8p-"));
  const child = spawn(edge, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-gpu", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      version = await res.json();
      break;
    } catch { await sleep(250); }
  }
  if (!version) throw new Error("CDP 没起来");
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => {
    const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });

  const stub = `(() => {
    try { sessionStorage.setItem("memlib-v2-token", "test-token"); } catch {}
    const F = ${JSON.stringify(FIXTURES)};
    const orig = window.fetch;
    window.fetch = async (url, init) => {
      const key = String(url).split("?")[0];
      if (F[key]) return new Response(JSON.stringify(F[key]), { status: 200, headers: { "content-type": "application/json" } });
      return orig(url, init);
    };
  })();`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: stub });
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2000);

  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
    return r.result?.result?.value;
  };

  const pages = ["knowledge", "tools", "roles", "projects", "plans", "profile", "learning", "pet", "graph"];
  let failures = 0;
  for (const page of pages) {
    await ev(`location.hash = "#/${page}"; true`);
    await sleep(500);
    if (page === "learning") {
      await ev(`document.getElementById("lrTopic").value = "fixture-topic"; document.getElementById("lrLoad").click(); true`);
      await sleep(900);
    }
    if (page === "graph") {
      await ev(`document.getElementById("grProject").value = "fixture-project"; document.getElementById("grLoad").click(); true`);
      await sleep(1200);
    }
    const state = await ev(`(() => {
      const v = document.getElementById("view-${page}");
      if (!v) return { found: false };
      const text = v.innerText || "";
      const svg = v.querySelector("svg.graph-svg");
      return {
        found: true,
        cards: v.querySelectorAll(".card").length,
        rows: v.querySelectorAll("tbody tr").length,
        hasFixture: /fixture/i.test(text),
        failed: /读取失败|加载失败|端点不存在/.test(text),
        graphSvg: !!svg,
        graphNodes: v.querySelectorAll("svg.graph-svg circle.graph-node").length,
        snippet: text.replace(/\\s+/g, " ").slice(0, 80)
      };
    })()`);
    const graphOk = page !== "graph" || (state.graphSvg && state.graphNodes > 0);
    let projectsOk = true;
    if (page === "projects") {
      projectsOk = await ev(`(() => {
        const t = document.getElementById("view-projects").innerText || "";
        return /代码/.test(t) && /372 文件 · 3210 符号/.test(t) && /visibility\\.mjs/.test(t);
      })()`);
      if (!projectsOk) console.log("    项目页断言失败：期望同时出现 代码 / 372 文件 · 3210 符号 / visibility.mjs");
    }
    const ok = state.found && !state.failed && state.hasFixture && (state.cards > 0 || state.rows > 0) && graphOk && projectsOk;
    if (!ok) failures += 1;
    console.log(`  ${page.padEnd(10)} ${ok ? "PASS" : "FAIL"}  cards=${state.cards} rows=${state.rows} fixture=${state.hasFixture} failedText=${state.failed}${page === "graph" ? ` svg=${state.graphSvg} nodes=${state.graphNodes}` : ""}`);
    if (!ok) console.log(`    显示内容: ${state.snippet}`);
  }

  console.log(`  pages=${pages.length} failures=${failures}`);
  console.log(`  运行期异常: ${errs.length ? errs.slice(0, 3).join(" | ") : "无"}`);
  ws.close();
  child.kill();
  server.close();
  process.exitCode = failures ? 1 : 0;
}

if (process.argv.includes("--print-graph-fixture")) {
  const fixture = FIXTURES["/v1/graph/dump"];
  console.log(JSON.stringify({ endpoint: "/v1/graph/dump", nodeCount: fixture.nodes.length, edgeCount: fixture.edges.length, fixture }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", e.message); server.close(); process.exitCode = 1; });
