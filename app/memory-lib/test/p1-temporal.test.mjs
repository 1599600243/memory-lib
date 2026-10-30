import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryWriter } from "../src/write-memory.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { parseFrontmatterTyped } from "../src/frontmatter-util.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-p1-temporal-"));
const principal = { framework_id: "framework-p1", group_id: "group-p1", user_id: "user-p1", agent_id: "agent-p1", role_id: "role-p1", tenant_id: "default" };
const writer = createMemoryWriter({ dataRoot: root });
const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null, principal, ollama: { endpoint: "http://127.0.0.1:1", model: "none", dimension: 1 } });

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("ordinary write needs no temporal fields and is searchable", async () => {
  const written = await writer.write({ layer: "curated-shared", id: "p1-ordinary", body: "P1 ordinary timeless marker", evidence_refs: ["evidence:p1"] , principal });
  assert.equal(written.created, true);
  const text = await fs.readFile(written.path, "utf8");
  const { frontmatter } = parseFrontmatterTyped(text);
  assert.equal(frontmatter.status, "active");
  assert.equal(typeof frontmatter.valid_from, "string");
  assert.equal(frontmatter.valid_to, null);
  assert.equal(frontmatter.superseded_by, null);
  assert.deepEqual(frontmatter.supersedes, []);
  assert.ok((await lib.search({ query: "P1 ordinary timeless marker", searchMode: "formal", graphExpand: false })).some((item) => item.path === written.path));
});

test("supersede keeps history and default/as-of/history retrieval distinguish versions", async () => {
  const old = await writer.write({ layer: "curated-shared", id: "p1-old", body: "P1 preference uses old value", evidence_refs: ["evidence:p1"], principal, valid_from: "2026-01-01T00:00:00.000Z" });
  const replaced = await writer.supersede({ oldId: "p1-old", layer: "curated-shared", id: "p1-new", body: "P1 preference uses new value", evidence_refs: ["evidence:p1"], principal, valid_from: "2026-02-01T00:00:00.000Z" });
  assert.equal(replaced.new.id, "p1-new");
  const oldText = await fs.readFile(old.path, "utf8");
  const oldFm = parseFrontmatterTyped(oldText).frontmatter;
  assert.equal(oldFm.status, "superseded");
  assert.equal(oldFm.superseded_by, "p1-new");
  assert.equal(oldFm.valid_to, "2026-02-01T00:00:00.000Z");
  const current = await lib.search({ query: "P1 preference", searchMode: "formal", graphExpand: false });
  assert.ok(current.some((item) => item.path === replaced.new.path));
  assert.ok(!current.some((item) => item.path === old.path));
  const past = await lib.search({ query: "P1 preference", searchMode: "formal", as_of: "2026-01-15T00:00:00.000Z", graphExpand: false });
  assert.ok(past.some((item) => item.path === old.path));
  assert.ok(!past.some((item) => item.path === replaced.new.path));
  const history = await lib.search({ query: "P1 preference", searchMode: "formal", include_superseded: true, graphExpand: false });
  assert.ok(history.some((item) => item.path === old.path));
  assert.ok(history.some((item) => item.path === replaced.new.path));
});

test("raw conversation without temporal fields remains searchable", async () => {
  const raw = path.join(root, "evidence", "conversations", "p1-raw.md");
  await fs.mkdir(path.dirname(raw), { recursive: true });
  await fs.writeFile(raw, "---\nid: p1-raw\ntype: conversation\ngroupId: group-p1\nuserId: user-p1\n---\n\nP1 raw timeless marker\n", "utf8");
  const results = await lib.search({ query: "P1 raw timeless marker", searchMode: "raw", rawQuota: 1, graphExpand: false });
  assert.ok(results.some((item) => item.path === raw));
});

test("supersede inherits private agent layer and visibility when omitted", async () => {
  const old = await writer.write({ layer: "agent", id: "p1-private-old", body: "P1 private old marker", visibility: "agent", evidence_refs: ["evidence:p1"], principal });
  const replaced = await writer.supersede({ oldId: "p1-private-old", id: "p1-private-new", body: "P1 private new marker", evidence_refs: ["evidence:p1"], principal });
  const fm = parseFrontmatterTyped(await fs.readFile(replaced.new.path, "utf8")).frontmatter;
  assert.equal(fm.layer, "role");
  assert.equal(fm.visibility, "agent");
  assert.equal(replaced.new.path.includes(path.join("curated", "agents", "agent-p1")), true);
  const owner = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null, principal });
  const other = createMemoryLib({ dataRoot: root, workspaceRoot: root, scopes: null, principal: { ...principal, agent_id: "agent-other", role_id: "role-other", user_id: "user-other" } });
  assert.ok(await owner.get("p1-private-new"));
  assert.equal(await other.get("p1-private-new"), null);
});

test("failed supersede leaves old memory active", async () => {
  const old = await writer.write({ layer: "curated-shared", id: "p1-atomic-old", body: "P1 atomic old marker", evidence_refs: ["evidence:p1"], principal });
  await assert.rejects(() => writer.supersede({ oldId: "p1-atomic-old", layer: "curated-shared", id: "../invalid", body: "must fail", evidence_refs: ["evidence:p1"], principal }));
  const fm = parseFrontmatterTyped(await fs.readFile(old.path, "utf8")).frontmatter;
  assert.equal(fm.status, "active");
  assert.equal(fm.valid_to, null);
  assert.equal(fm.superseded_by, null);
});
