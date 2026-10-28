import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryIngest } from "../src/memory-ingest.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d17-ingest-"));
after(async () => fs.rm(TMP, { recursive: true, force: true }));

const principal = { framework_id: "test", agent_id: "admin-01", role_id: "librarian-admin" };

async function filesUnder(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else found.push(path.relative(root, target));
    }
  }
  await walk(root);
  return found.sort();
}

test("document ingest previews without writes, imports once, and records versions", async () => {
  const workspaceRoot = path.join(TMP, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const sourceRoot = path.join(TMP, "external");
  await fs.mkdir(sourceRoot, { recursive: true });
  for (const [name, body] of [["one.md", "第一份外部资料"], ["two.txt", "第二份外部资料"], ["three.csv", "name,value\nthird,第三份外部资料"]]) await fs.writeFile(path.join(sourceRoot, name), body, "utf8");
  const ingest = createMemoryIngest({ dataRoot, workspaceRoot });
  const request = { paths: [sourceRoot], kind: "document", source: "external:fixture", dry_run: true };
  const before = await filesUnder(workspaceRoot);
  const preview = await ingest.run({ ...request, principal, unrestricted: true });
  assert.equal(preview.counts.planned, 3);
  assert.equal(preview.counts.imported, 0);
  assert.deepEqual(await filesUnder(workspaceRoot), before, "dry run must not write state or evidence");
  assert.ok(preview.impact.directories.some((item) => item.includes(path.join("evidence", "documents", "external-fixture"))));

  const result = await ingest.run({ ...request, dry_run: false, principal, unrestricted: true });
  assert.equal(result.counts.imported, 3);
  const documents = await filesUnder(path.join(dataRoot, "evidence", "documents"));
  assert.equal(documents.filter((item) => item.endsWith(".md")).length, 3);
  const stored = await fs.readFile(path.join(dataRoot, "evidence", "documents", documents[0]), "utf8");
  assert.match(stored, /original_path:/u);
  assert.match(stored, /content_hash:/u);
  assert.match(stored, /principal:/u);

  await ingest.run({ ...request, principal, unrestricted: true });
  const duplicate = await ingest.run({ ...request, dry_run: false, principal, unrestricted: true });
  assert.equal(duplicate.counts.imported, 0);
  assert.equal(duplicate.counts.skipped, 3);

  await fs.writeFile(path.join(sourceRoot, "one.md"), "第一份外部资料的新版本", "utf8");
  await ingest.run({ ...request, principal, unrestricted: true });
  const changed = await ingest.run({ ...request, dry_run: false, principal, unrestricted: true });
  assert.equal(changed.counts.imported, 1);
  assert.equal(changed.imported[0].prev_hash?.length, 64);
  assert.ok(changed.imported[0].supersedes);
});

test("ingest rejects restricted paths and skips credential-bearing files", async () => {
  const workspaceRoot = path.join(TMP, "restricted-workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const importsRoot = path.join(workspaceRoot, "imports");
  const outside = path.join(TMP, "outside-secret.md");
  await fs.mkdir(importsRoot, { recursive: true });
  await fs.writeFile(outside, "ordinary outside file", "utf8");
  await fs.writeFile(path.join(importsRoot, "secret.md"), "api_key=sk-proj-1234567890abcdefghijklmnop", "utf8");
  await fs.writeFile(path.join(importsRoot, "broken.json"), "{not valid json", "utf8");
  await fs.writeFile(path.join(importsRoot, "password.json"), JSON.stringify({ password: "hunter2secret" }), "utf8");
  const ingest = createMemoryIngest({ dataRoot, workspaceRoot });
  await assert.rejects(() => ingest.run({ paths: [outside], principal: { ...principal, role_id: "reader" }, unrestricted: false }), (error) => error.code === "PATH_DENIED");
  const preview = await ingest.run({ paths: [importsRoot], kind: "document", source: "external:restricted", principal: { ...principal, role_id: "reader" }, unrestricted: false });
  assert.equal(preview.counts.planned, 0);
  assert.equal(preview.counts.skipped, 3);
  assert.equal(preview.skipped.filter((item) => item.reason === "credential-sensitive").length, 2);
  assert.ok(preview.skipped.some((item) => item.reason === "unparseable"));
});

test("recursive conversation imports preserve deprecated extract compatibility", async () => {
  const workspaceRoot = path.join(TMP, "routing-workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const importsRoot = path.join(workspaceRoot, "imports");
  await fs.mkdir(path.join(importsRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(importsRoot, "top.txt"), "top-level document", "utf8");
  await fs.writeFile(path.join(importsRoot, "nested", "conversation.json"), JSON.stringify({ messages: [{ role: "user", content: "nested conversation" }] }), "utf8");
  const captures = [];
  const ingest = createMemoryIngest({ dataRoot, workspaceRoot, conversationMemory: { capture: async (event) => { captures.push(event); return { evidenceId: "conversation-fixture", candidateCount: 0 }; } } });
  const shallow = await ingest.run({ paths: [importsRoot], glob: "**/*.json", principal, unrestricted: true });
  assert.equal(shallow.counts.planned, 0);
  const request = { paths: [importsRoot], recursive: true, glob: "**/*.json", source: "external:routing", tags: ["d17"], scope: { layer: "memory", visibility: "shared" }, extract: true, principal, unrestricted: true };
  const preview = await ingest.run(request);
  assert.equal(preview.counts.planned, 1);
  assert.equal(preview.planned[0].kind, "conversation");
  const executed = await ingest.run({ ...request, dry_run: false });
  assert.equal(executed.counts.imported, 1);
  assert.equal(captures[0].extract, true);
  assert.deepEqual(captures[0].tags, ["d17"]);
  await fs.writeFile(path.join(importsRoot, "nested", "conversation.json"), JSON.stringify({ messages: [{ role: "user", content: "project conversation" }] }), "utf8");
  const projectRequest = { ...request, scope: { layer: "memory", visibility: "project", project: "alpha" }, scopes: [{ layer: "memory", visibility: "project", project: "alpha" }] };
  await ingest.run(projectRequest);
  await ingest.run({ ...projectRequest, dry_run: false });
  assert.equal(captures[1].workspace, "alpha");
  await assert.rejects(() => ingest.run({ ...projectRequest, scope: { layer: "memory", visibility: "project", project: "beta" } }), (error) => error.code === "SCOPE_DENIED");
});

test("execution requires a matching dry run and paths are mandatory", async () => {
  const workspaceRoot = path.join(TMP, "preview-workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const importsRoot = path.join(workspaceRoot, "imports");
  await fs.mkdir(importsRoot, { recursive: true });
  await fs.writeFile(path.join(importsRoot, "note.md"), "preview fixture", "utf8");
  const ingest = createMemoryIngest({ dataRoot, workspaceRoot });
  await assert.rejects(() => ingest.run({ paths: [], principal, unrestricted: true }), (error) => error.code === "PATHS_REQUIRED");
  await assert.rejects(() => ingest.run({ paths: [importsRoot], dry_run: false, principal, unrestricted: true }), (error) => error.code === "DRY_RUN_REQUIRED");
  const request = { paths: [importsRoot], kind: "document", principal, unrestricted: true };
  await ingest.run(request);
  await fs.writeFile(path.join(importsRoot, "note.md"), "changed after preview", "utf8");
  await assert.rejects(() => ingest.run({ ...request, dry_run: false }), (error) => error.code === "DRY_RUN_REQUIRED");
});

test("concurrent imports retain state and same-content aliases keep version lineage", async () => {
  const workspaceRoot = path.join(TMP, "concurrent-workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const importsRoot = path.join(workspaceRoot, "imports");
  await fs.mkdir(importsRoot, { recursive: true });
  const first = path.join(importsRoot, "first.md");
  const alias = path.join(importsRoot, "alias.md");
  const second = path.join(importsRoot, "second.md");
  await fs.writeFile(first, "same content", "utf8");
  await fs.writeFile(alias, "same content", "utf8");
  await fs.writeFile(second, "different content", "utf8");
  const ingest = createMemoryIngest({ dataRoot, workspaceRoot });
  const firstRequest = { paths: [first, alias], kind: "document", principal, unrestricted: true };
  const secondRequest = { paths: [second], kind: "document", principal, unrestricted: true };
  await Promise.all([ingest.run(firstRequest), ingest.run(secondRequest)]);
  await Promise.all([ingest.run({ ...firstRequest, dry_run: false }), ingest.run({ ...secondRequest, dry_run: false })]);
  const state = JSON.parse(await fs.readFile(ingest.statePath, "utf8"));
  assert.ok(state.paths[first]);
  assert.ok(state.paths[alias]);
  assert.ok(state.paths[second]);
  await fs.writeFile(alias, "alias changed", "utf8");
  await ingest.run(firstRequest);
  const changed = await ingest.run({ ...firstRequest, dry_run: false });
  const importedAlias = changed.imported.find((item) => item.path === alias);
  assert.equal(importedAlias.prev_hash, state.paths[alias].hash);
  assert.ok(importedAlias.supersedes);
});

test("project document imports are visible only to an authorized project scope", async () => {
  const workspaceRoot = path.join(TMP, "scope-workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const importsRoot = path.join(workspaceRoot, "imports");
  await fs.mkdir(importsRoot, { recursive: true });
  await fs.writeFile(path.join(importsRoot, "project.md"), "scope isolation marker azure-cedar", "utf8");
  const scope = { layer: "memory", visibility: "project", project: "alpha" };
  const request = { paths: [importsRoot], kind: "document", scope, scopes: [scope], principal, unrestricted: true };
  const ingest = createMemoryIngest({ dataRoot, workspaceRoot });
  await ingest.run(request);
  await ingest.run({ ...request, dry_run: false });
  const projectLib = createMemoryLib({ dataRoot, workspaceRoot, scopes: [scope], ollama: { enabled: false } });
  const sharedLib = createMemoryLib({ dataRoot, workspaceRoot, scopes: [{ layer: "memory", visibility: "shared" }], ollama: { enabled: false } });
  assert.equal((await projectLib.search({ query: "azure-cedar" })).length, 1);
  assert.equal((await sharedLib.search({ query: "azure-cedar" })).length, 0);
  assert.ok((await projectLib.listMemories()).some((item) => item.body.includes("azure-cedar")));
  assert.ok(!(await sharedLib.listMemories()).some((item) => item.body.includes("azure-cedar")));
});
