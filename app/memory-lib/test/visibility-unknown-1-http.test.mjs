import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "./test-auth.mjs";
import { createGraphStore } from "../src/graph-retrieval.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = "2026-10-19";
const ID = "VISUNKNOWN-HTTP-PRIVATE";
const MARKER = "VISUNKNOWN_HTTP_ADMIN_ONLY";

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visibility-unknown-http-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const dir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  const content = `---\nid: ${ID}\nlayer: long-term\ncontainer: long-term\nvisibility: private\nstatus: active\ntenant_id: default\nframework_id: deepseek-harness\ngroup_id: unknown\nuser_id: unknown\nagent_id: admin-01\nrole_id: librarian-admin\nkind: fact\noccurred_at: \"${DAY}T03:00:00.000Z\"\nvalid_from: \"${DAY}T03:00:00.000Z\"\ncalendarDate: ${DAY}\n---\n${MARKER}\n`;
  await fs.writeFile(path.join(dir, `${ID}.md`), content, "utf8");
  const evidenceId = "evidence:VISUNKNOWN-HTTP";
  await fs.writeFile(path.join(dir, "source-evidence.md"), `---\nid: ${evidenceId}\ntype: evidence\n---\nHTTP graph visibility evidence.\n`, "utf8");
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const unknownAgent = registry.frameworks[0].agents.find((agent) => agent.agent_id === "visunknown-unknown-agent");
  if (!unknownAgent) registry.frameworks[0].agents.push({ agent_id: "visunknown-unknown-agent", roles: [{ role_id: "visunknown-unknown-role", group_id: "unknown", user_id: "unknown", scopes: [{ layer: "memory", visibility: "shared" }], actions: ["search", "get"] }] });
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  const graphStore = createGraphStore({ dataRoot });
  await graphStore.ingest({ event_id: "evt-VISUNKNOWN-HTTP", type: "project.linked", tenant_id: "default", evidence_id: evidenceId, payload: { src_id: "project:visunknown-http", predicate: "belongs_to_project", dst_id: `memory:${ID}`, visibility: "private", container: "long-term", group_id: "unknown", user_id: "unknown", agent_id: "admin-01", role_id: "librarian-admin", project: "visunknown-http" } });
  return { tmp, workspaceRoot, dataRoot, auth };
}

test("V5 HTTP: search, calendarDate, brief and graph APIs deny sentinel-only identities but keep real admin identity", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const server = createLocalhostServer({
    registryPath: f.auth.registryPath,
    secretStore: f.auth.secretStore,
    dataRoot: f.dataRoot,
    workspaceRoot: f.workspaceRoot,
    auditPath: path.join(f.tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    libFactory: createServerLibFactory({ dataRoot: f.dataRoot, workspaceRoot: f.workspaceRoot, vectorLane: { probe: false }, calendarTimezone: "Asia/Shanghai" }),
    calendarTimezone: "Asia/Shanghai",
  });
  t.after(() => server.close());
  const address = await server.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const admin = { credential_ref: f.auth.credentialRef, secret: f.auth.authValue, principal: { agent_id: "admin-01", role_id: "librarian-admin" } };
  const unknown = { credential_ref: f.auth.credentialRef, secret: f.auth.authValue, principal: { agent_id: "visunknown-unknown-agent", role_id: "visunknown-unknown-role" } };
  async function post(route, identity, body = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, ...body }) });
    return { status: response.status, body: await response.json() };
  }
  const searchAdmin = await post("/v1/search", admin, { query: MARKER, searchMode: "formal", graphExpand: false });
  assert.equal(searchAdmin.status, 200, JSON.stringify(searchAdmin.body));
  assert.equal(searchAdmin.body.results.some((row) => row.path.endsWith(`${ID}.md`)), true, "admin search returns the private marker");
  const searchUnknown = await post("/v1/search", unknown, { query: MARKER, searchMode: "formal", graphExpand: false });
  assert.equal(searchUnknown.status, 200, JSON.stringify(searchUnknown.body));
  assert.equal(searchUnknown.body.results.some((row) => row.path.endsWith(`${ID}.md`)), false, "unknown-only search does not return the private marker");

  const dayAdmin = await post("/v1/search", admin, { query: "", calendarDate: DAY, calendarTimezone: "Asia/Shanghai", limit: 100 });
  assert.equal(dayAdmin.status, 200, JSON.stringify(dayAdmin.body));
  assert.deepEqual(dayAdmin.body.results.map((row) => row.id), [ID], "admin calendarDate read returns exact single record");
  const dayUnknown = await post("/v1/search", unknown, { query: "", calendarDate: DAY, calendarTimezone: "Asia/Shanghai", limit: 100 });
  assert.equal(dayUnknown.status, 200, JSON.stringify(dayUnknown.body));
  assert.deepEqual(dayUnknown.body.results.map((row) => row.id), [], "unknown-only calendarDate read returns no records");

  const briefAdmin = await post("/v1/recall/brief", admin, { query: MARKER, format: "markdown", memory_only: true });
  assert.equal(briefAdmin.status, 200, JSON.stringify(briefAdmin.body));
  assert.equal(briefAdmin.body.included.some((item) => item.id === ID), true, "admin recall brief includes the private marker");
  const briefUnknown = await post("/v1/recall/brief", unknown, { query: MARKER, format: "markdown", memory_only: true });
  assert.equal(briefUnknown.status, 200, JSON.stringify(briefUnknown.body));
  assert.equal(briefUnknown.body.included.some((item) => item.id === ID), false, "unknown-only recall brief excludes the private marker");

  const graphAdmin = await post("/v1/graph/query", admin, { project_id: "visunknown-http" });
  assert.equal(graphAdmin.status, 200, JSON.stringify(graphAdmin.body));
  assert.equal(graphAdmin.body.graph.edges.length, 1, "admin graph API returns its private edge");
  const graphUnknown = await post("/v1/graph/query", unknown, { project_id: "visunknown-http" });
  assert.equal(graphUnknown.status, 200, JSON.stringify(graphUnknown.body));
  assert.deepEqual(graphUnknown.body.graph.edges, [], "unknown-only graph API returns no private edge");

  const jointAdmin = await post("/v1/search/joint", admin, { query: "VISUNKNOWN_HTTP", exact: { src_id: "project:visunknown-http", predicate: "belongs_to_project", dst_id: `memory:${ID}` } });
  assert.equal(jointAdmin.status, 200, JSON.stringify(jointAdmin.body));
  assert.equal(jointAdmin.body.results[0]?.id, `memory:${ID}`, "admin joint search returns the private graph target");
  const jointUnknown = await post("/v1/search/joint", unknown, { query: "VISUNKNOWN_HTTP", exact: { src_id: "project:visunknown-http", predicate: "belongs_to_project", dst_id: `memory:${ID}` } });
  assert.equal(jointUnknown.status, 200, JSON.stringify(jointUnknown.body));
  assert.deepEqual(jointUnknown.body.results, [], "unknown-only joint search excludes the private graph target");
});
