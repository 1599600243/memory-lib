import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";

const html = await readFile(new URL("../web/v2/index.html", import.meta.url), "utf8");
const inlineScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1] || "";
new vm.Script(inlineScript);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const refs = [...inlineScript.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
const missing = [...new Set(refs.filter((id) => !ids.includes(id)))];
console.log("inline script syntax: OK");
console.log(`DOM ids: declared=${ids.length} duplicate=${new Set(duplicates).size} missing=${missing.length}`);
if (duplicates.length || missing.length) { console.error(JSON.stringify({ duplicates, missing })); process.exit(1); }

const pages = ["knowledge", "tools", "projects", "plans", "profile", "learning", "pet", "graph"];
const fixtures = {
  "/v1/memory/list": { items: [{ id: "doc-1", path: "knowledge/fixture.md", layer: "knowledge", source: "fixture", updatedAt: "2026-01-01" }] },
  "/v1/tools/list": { items: [{ tool_name: "fixture-tool", source: "fixture", last_used_at: "2026-01-01", status: "active" }] },
  "/v1/project/list": { items: [{ project: "fixture-project", status: "active", updated_at: "2026-01-01" }] },
  "/v1/plans/list": { items: [{ topic: "fixture-plan", status: "active", updated_at: "2026-01-01" }] },
  "/v1/profile/list": { items: [{ id: "fixture-profile", summary: "fixture summary", source: "fixture", updated_at: "2026-01-01" }] },
  "/v1/learning/plan_get": { plan: { modules: ["fixture module"] } },
  "/v1/learning/progress_get": { progress: { completed: 1 } },
  "/v1/learning/review_get": { review: { due: 1 } },
  "/v1/pet/runtime/persona/list": { personas: [{ id: "fixture-persona", content: "persona fixture" }] },
  "/v1/pet/runtime/drafts/list": { drafts: [{ id: "fixture-draft", content: "draft fixture" }] },
  "/v1/graph/query": { graph: { nodes: [{ id: "fixture-node", type: "fact" }], edges: [{ source: "a", type: "links", target: "b" }] } },
};
const injected = `<script>
sessionStorage.setItem('memlib-v2-token','fixture');
window.fetch=async url=>({ok:true,status:200,json:async()=>(${JSON.stringify(fixtures)}[new URL(url,location.href).pathname]||{})});
window.addEventListener('DOMContentLoaded',()=>{(async()=>{for(const page of ${JSON.stringify(pages)}){location.hash='#/'+page;await new Promise(r=>setTimeout(r,40));if(page==='learning'){document.getElementById('lrTopic').value='fixture-topic';document.getElementById('lrLoad').click()}if(page==='graph'){document.getElementById('grProject').value='fixture-project';document.getElementById('grLoad').click()}await new Promise(r=>setTimeout(r,100));const v=document.getElementById('view-'+page);const ok=v.querySelectorAll('.card').length>0&&v.querySelectorAll('tbody tr').length>0&&/fixture/.test(v.innerText||'')&&!/读取失败|加载失败|端点不存在/.test(v.innerText||'');document.body.dataset['check'+page]=String(ok)}document.body.dataset.checkDone='true'})()});
</script>`;
const instrumented = html.replace("<script>\n(function () {", injected + "\n<script>\n(function () {");
if (process.argv[2] === "--verify") {
  const output = await readFile(process.argv[3], "utf8");
  let failures = 0;
  for (const page of pages) { const ok = output.includes(`data-check${page}=\"true\"`); console.log(`${page}: ${ok ? "PASS" : "FAIL"}`); if (!ok) failures++; }
  console.log(`browser fixture pages: ${pages.length}; failures: ${failures}`);
  if (!output.includes('data-checkDone=\"true\"') || failures) process.exitCode = 1;
} else {
  const target = join(tmpdir(), "memory-v2-browser-fixture.html");
  await writeFile(target, instrumented);
  console.log(`fixture: ${target}`);
}
