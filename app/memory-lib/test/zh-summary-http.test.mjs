import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { generateZhSummary } from "../scripts/generate-zh-summary.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-r8-http-"));
const workspace = path.join(tmp, "workspace");
const dataRoot = path.join(workspace, "memory");
const shared = path.join(dataRoot, "curated", "shared");
await fs.mkdir(shared, { recursive: true });
const hitPath = path.join(shared, "summary-hit.md");
const missPath = path.join(shared, "summary-miss.md");
await fs.writeFile(hitPath, "---\nid: r8-summary-hit\nscope: shared\nstatus: promoted\n---\n# Approval workflow\n\nApproval workflow requires a second reviewer.\n", "utf8");
await fs.writeFile(missPath, "---\nid: r8-summary-miss\nscope: shared\nstatus: promoted\n---\n# Rollback plan\n\nRollback plan keeps the previous release available.\n", "utf8");
const sidecar = path.join(workspace, "zh-summary.json");
await fs.writeFile(sidecar, JSON.stringify({ results: [{ path: hitPath, summaryZh: "审批流程需要第二审核人", keyPoints: ["审批需双人复核"] }] }), "utf8");
const auth = await createTestAuth(root, tmp);
const libFactory = ({ scopes }) => createMemoryLib({ dataRoot, workspaceRoot: workspace, scopes, summaryIndex: sidecar, indexRefresh: false, ollama: { endpoint: "http://127.0.0.1:1", model: "missing", dimension: 768 } });
const auditPath = path.join(tmp, "audit.jsonl");
const adapter = createLocalhostServer({ libFactory, registryPath: auth.registryPath, secretStore: auth.secretStore, auditPath, host: "127.0.0.1", port: 0 });
const address = await adapter.listen();
const base = `http://127.0.0.1:${address.port}`;

after(async () => {
  await adapter.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test("R8 generator writes a loadable sidecar without modifying source memory", async () => {
  const sourceBefore = await fs.readFile(hitPath, "utf8");
  const generated = path.join(tmp, "generated-summary.json");
  const checkpoint = path.join(tmp, "generated-checkpoint.json");
  const fakeOllama = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: { content: JSON.stringify({ summaryZh: "本地模型生成的中文摘要", keyPoints: ["不改原始记忆"] }) } }));
    });
  });
  await new Promise((resolve, reject) => fakeOllama.listen(0, "127.0.0.1", resolve).once("error", reject));
  const ollamaAddress = fakeOllama.address();
  try {
    const report = await generateZhSummary({ roots: [shared], out: generated, checkpoint, endpoint: `http://127.0.0.1:${ollamaAddress.port}`, model: "fixture", maxBody: 6000, timeoutMs: 5000 });
    assert.equal(report.sourceCount, 2);
    assert.equal(report.resultCount, 2);
    const payload = JSON.parse(await fs.readFile(generated, "utf8"));
    assert.equal(payload.results.every((item) => item.summaryZh === "本地模型生成的中文摘要"), true);
    assert.equal(await fs.readFile(hitPath, "utf8"), sourceBefore);
  } finally {
    await new Promise((resolve) => fakeOllama.close(resolve));
  }
});

test("R8 /v1/memory/list exposes summaryZh and preserves English fallback", async () => {
  const response = await fetch(`${base}/v1/memory/list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "reader" }, limit: 50 }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const hit = payload.items.find((item) => item.id === "r8-summary-hit");
  const miss = payload.items.find((item) => item.id === "r8-summary-miss");
  assert.equal(hit.summaryZh, "审批流程需要第二审核人");
  assert.deepEqual(hit.keyPoints, ["审批需双人复核"]);
  assert.equal(Object.hasOwn(miss, "summaryZh"), false);
  assert.match(miss.body, /Rollback plan keeps the previous release available/u);
  console.log(JSON.stringify({ status: response.status, count: payload.count, summarized: { id: hit.id, summaryZh: hit.summaryZh }, fallback: { id: miss.id, hasSummaryZh: Object.hasOwn(miss, "summaryZh"), body: miss.body.trim().split(/\r?\n/u).at(-1) } }, null, 2));
});
