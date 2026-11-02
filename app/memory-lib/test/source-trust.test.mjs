import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMemoryWriter, sourceTrustOf } from "../src/write-memory.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTestAuth } from "./test-auth.mjs";

const MEMORY_LIB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_PRINCIPAL = { tenant_id: "default", framework_id: "source-trust-test", group_id: "source-trust-group", user_id: "source-trust-user", agent_id: "pilot-01", role_id: "source-trust-reader" };

test("source trust derives from external evidence refs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-source-trust-"));
  try {
    const writer = createMemoryWriter({ dataRoot: root });
    const result = await writer.write({
      layer: "curated-shared", id: "external-source-trust", body: "external fact",
      evidence_refs: ["napcat:group:1#2"], visibility: "private", principal: WRITER_PRINCIPAL,
    });
    const parsed = parseFrontmatterTyped(await fs.readFile(result.path, "utf8"));
    assert.equal(parsed.frontmatter.source_trust, "external");
    assert.equal(parsed.frontmatter.visibility, "private");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("internal evidence refs are written as internal trust", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-source-trust-"));
  try {
    const result = await createMemoryWriter({ dataRoot: root }).write({ layer: "curated-shared", id: "internal-source-trust", body: "internal fact", evidence_refs: ["dsh-session:abc"], principal: WRITER_PRINCIPAL });
    const parsed = parseFrontmatterTyped(await fs.readFile(result.path, "utf8"));
    assert.equal(parsed.frontmatter.source_trust, "internal");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing and empty refs classify as internal without changing required-ref validation", () => {
  assert.equal(sourceTrustOf(undefined), "internal");
  assert.equal(sourceTrustOf([]), "internal");
});

test("mixed internal and external refs classify as external", () => {
  assert.equal(sourceTrustOf(["dsh-session:abc", "napcat:group:1#2"]), "external");
});

test("unparseable and non-string refs do not classify as external", () => {
  assert.equal(sourceTrustOf(["weird", 42]), "internal");
});

test("project progress records trust from its evidence refs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-source-trust-"));
  try {
    const result = await createMemoryWriter({ dataRoot: root }).writeProgress({
      project: "source-trust-progress", entries: [{ topic: "进展", at: "2026-10-31", text: "progress item" }],
      evidence_refs: ["qq-group:1#2"], principal: WRITER_PRINCIPAL,
    });
    const parsed = parseFrontmatterTyped(await fs.readFile(result.path, "utf8"));
    assert.equal(parsed.frontmatter.source_trust, "external");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("source trust is persisted and evidence merges refresh it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-source-trust-"));
  try {
    const writer = createMemoryWriter({ dataRoot: root });
    const result = await writer.write({ layer: "curated-shared", id: "source-trust-durable", body: "durable fact", evidence_refs: ["dsh-session:abc"], principal: WRITER_PRINCIPAL });
    let parsed = parseFrontmatterTyped(await fs.readFile(result.path, "utf8"));
    assert.equal(parsed.frontmatter.source_trust, "internal");
    await writer.mergeEvidenceRefs({ filePath: result.path, evidence_refs: ["qq-group:1#2"] });
    parsed = parseFrontmatterTyped(await fs.readFile(result.path, "utf8"));
    assert.equal(parsed.frontmatter.source_trust, "external");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("list, find, and search expose source trust and label legacy files unknown", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-source-trust-http-"));
  const dataRoot = path.join(tmp, "memory");
  const workspaceRoot = tmp;
  let server;
  try {
    const auth = await createTestAuth(MEMORY_LIB_ROOT, tmp);
    const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
    const framework = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef);
    const pilot = framework.agents.find((item) => item.agent_id === "pilot-01");
    pilot.roles.push({
      role_id: "source-trust-reader", group_id: WRITER_PRINCIPAL.group_id, user_id: WRITER_PRINCIPAL.user_id,
      actions: ["search", "admin"], scopes: [{ layer: "memory", visibility: "shared" }],
    });
    await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const shared = path.join(dataRoot, "curated", "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "legacy-source-trust.md"), [
      "---", "id: legacy-source-trust", "layer: long-term", "container: long-term", "visibility: shared",
      "type: memory", "status: active", "updated_at: 2026-10-31T00:00:00.000Z", 'evidence_refs: ["dsh-session:old"]', "---", "",
      "legacy source trust marker", "",
    ].join("\n"), "utf8");
    await createMemoryWriter({ dataRoot }).write({
      layer: "curated-shared", id: "external-source-trust-http", body: "external source trust marker",
      evidence_refs: ["napcat:group:1#2"], visibility: "shared", principal: WRITER_PRINCIPAL,
    });

    server = createLocalhostServer({
      registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
      auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0, indexScheduleEnabled: false,
      libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
    });
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    async function post(route, body = {}) {
      const response = await fetch(`${base}${route}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "source-trust-reader" }, ...body }),
      });
      return { status: response.status, data: await response.json() };
    }

    const listed = await post("/v1/memory/list");
    assert.equal(listed.status, 200);
    assert.equal(listed.data.items.find((item) => item.id === "external-source-trust-http")?.source_trust, "external");
    assert.equal(listed.data.items.find((item) => item.id === "legacy-source-trust")?.source_trust, "unknown");

    const found = await post("/v1/memory/find", { query: "legacy source trust marker" });
    assert.equal(found.status, 200);
    assert.equal(found.data.items.find((item) => item.id === "legacy-source-trust")?.source_trust, "unknown");

    const searched = await post("/v1/search", { query: "legacy source trust marker", graphExpand: false });
    assert.equal(searched.status, 200);
    assert.equal(searched.data.results.find((item) => item.path.endsWith("legacy-source-trust.md"))?.source_trust, "unknown");
    assert.equal(searched.data.results.find((item) => item.path.endsWith("external-source-trust-http.md"))?.source_trust, "external");
  } finally {
    await server?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
