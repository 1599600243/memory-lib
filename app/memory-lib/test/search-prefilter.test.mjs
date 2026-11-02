// 2026-11-02 检索前置过滤（pre-filter）回归：
//   · 隔离不只是"目录根"，还有 tenant / group / user / agent / role / visibility / project；
//   · 关键回归：别人家的热门记录**不能**把调用者自己的召回挤出 Top-N。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIndexStore } from "../src/index-store.mjs";
import { memoryIndexSearch, buildAuthFilter, relativeRootPrefixes } from "../src/index-search.mjs";

const OWNER = {
  tenant_id: "default", framework_id: "f", agent_id: "qq-bot", role_id: "chat-reader",
  group_id: "home-circle", user_id: "u-owner",
};
const STRANGER = {
  tenant_id: "default", framework_id: "f", agent_id: "qq-other", role_id: "chat-reader",
  group_id: "group-x", user_id: "u_group_1000000",
};
const fakeEmbed = async () => ({ ok: true, status: 200, json: async () => ({ embedding: [1] }) });

function memoryFile({ id, visibility, user = null, group = "home-circle", agent = null, role = null, project = null, text }) {
  return [
    "---",
    `id: "${id}"`,
    'layer: "long-term"',
    'container: "long-term"',
    `visibility: "${visibility}"`,
    'status: "active"',
    user ? `user_id: "${user}"` : null,
    group ? `group_id: "${group}"` : null,
    agent ? `agent_id: "${agent}"` : null,
    role ? `role_id: "${role}"` : null,
    project ? `project: "${project}"` : null,
    'tenant_id: "default"',
    "---",
    "",
    text,
    "",
  ].filter((line) => line !== null).join("\n");
}

async function fixture(files) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "search-prefilter-"));
  const dir = path.join(dataRoot, "curated", "shared");
  await fs.mkdir(dir, { recursive: true });
  for (const file of files) {
    await fs.writeFile(path.join(dir, `${file.id}.md`), memoryFile(file), "utf8");
  }
  const store = createIndexStore({ dataRoot, ollama: { dimension: 1 }, fetchImpl: fakeEmbed });
  const indexed = await store.index();
  assert.equal(indexed.failed, 0);
  return { dataRoot };
}

async function search(dataRoot, { query, limit = 10, authRoots = null, authz = null } = {}) {
  return memoryIndexSearch(dataRoot, query, limit, authRoots, { dimension: 1 }, fakeEmbed, authz);
}

test("relativeRootPrefixes converts absolute roots to dataRoot-relative prefixes", () => {
  assert.deepEqual(relativeRootPrefixes([path.join("D:/data", "curated", "shared")], "D:/data"), ["curated/shared"]);
  assert.equal(relativeRootPrefixes(null, "D:/data"), null);
  assert.deepEqual(relativeRootPrefixes([], "D:/data"), []);
  assert.deepEqual(relativeRootPrefixes(["/outside/root"], "D:/data"), []);
});

test("buildAuthFilter emits principal constraints and never path-only", () => {
  const { sql, params } = buildAuthFilter({
    authz: { principal: OWNER, scopes: [{ layer: "memory", visibility: "user" }], tenantId: "default" },
    authRoots: null,
    dataRoot: "D:/data",
    hasPrincipals: true,
  });
  assert.match(sql, /p\.user_id = :user/u);
  assert.match(sql, /p\.tenant_id/u);
  assert.equal(params.user, "u-owner");
  assert.equal(buildAuthFilter({ authz: null, authRoots: null, dataRoot: "D:/data", hasPrincipals: true }).sql, "");
});

test("prefilter hides other identities' rows from a user-scoped principal", async () => {
  const { dataRoot } = await fixture([
    { id: "owner-rice", visibility: "user", user: "u-owner", text: "主人爱吃米饭，米饭要软。" },
    { id: "stranger-rice", visibility: "user", user: "u_group_1000000", group: "group-x", text: "群友也爱吃米饭，米饭要硬。" },
    { id: "shared-rice", visibility: "shared", group: "home-circle", text: "家里常备米饭。" },
    { id: "platform-rice", visibility: "platform", text: "米饭是主食。" },
  ]);
  const all = await search(dataRoot, { query: "米饭" });
  assert.equal(all.prefiltered, false);
  const mine = await search(dataRoot, {
    query: "米饭",
    authz: { principal: OWNER, scopes: [{ layer: "memory", visibility: "user" }], tenantId: "default" },
  });
  const names = mine.results.map((row) => path.basename(row.path, ".md")).sort();
  assert.ok(mine.prefiltered, "expected SQL prefilter to be active");
  assert.ok(names.includes("owner-rice"), JSON.stringify(names));
  assert.ok(!names.includes("stranger-rice"), `leaked stranger memory: ${JSON.stringify(names)}`);
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("hot rows from other identities cannot crowd out the caller's row (Top-N starvation)", async () => {
  const others = Array.from({ length: 40 }, (_, i) => ({
    id: `stranger-${i}`, visibility: "user", user: "u_group_1000000", group: "group-x",
    text: `米饭 米饭 米饭 米饭 米饭 群友 ${i} 的米饭记录。`,
  }));
  const { dataRoot } = await fixture([
    ...others,
    { id: "owner-only", visibility: "user", user: "u-owner", text: "主人只吃一点点米饭。" },
  ]);
  const mine = await search(dataRoot, {
    query: "米饭",
    limit: 1,
    authz: { principal: OWNER, scopes: [{ layer: "memory", visibility: "user" }], tenantId: "default" },
  });
  assert.deepEqual(mine.results.map((row) => path.basename(row.path, ".md")), ["owner-only"], JSON.stringify(mine.results.map((r) => r.path)));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("explicit empty roots deny everything", async () => {
  const { dataRoot } = await fixture([
    { id: "owner-rice", visibility: "user", user: "u-owner", text: "主人爱吃米饭。" },
  ]);
  const denied = await search(dataRoot, {
    query: "米饭",
    authRoots: [],
    authz: { principal: OWNER, scopes: [], tenantId: "default" },
  });
  assert.deepEqual(denied.results, []);
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("stranger principal cannot see the owner's user-scoped row", async () => {
  const { dataRoot } = await fixture([
    { id: "owner-rice", visibility: "user", user: "u-owner", text: "主人爱吃米饭。" },
    { id: "stranger-rice", visibility: "user", user: "u_group_1000000", group: "group-x", text: "群友爱吃米饭。" },
  ]);
  const theirs = await search(dataRoot, {
    query: "米饭",
    authz: { principal: STRANGER, scopes: [{ layer: "memory", visibility: "user" }], tenantId: "default" },
  });
  assert.deepEqual(theirs.results.map((row) => path.basename(row.path, ".md")), ["stranger-rice"], JSON.stringify(theirs.results.map((r) => r.path)));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("evidence records use camelCase identity fields (groupId/userId) and stay scoped", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "search-prefilter-evidence-"));
  const dir = path.join(dataRoot, "evidence", "conversations");
  await fs.mkdir(dir, { recursive: true });
  const evidence = ({ id, groupId, userId, text }) => [
    "---",
    `id: ${id}`,
    "type: conversation",
    `groupId: "${groupId}"`,
    `userId: "${userId}"`,
    'tenantId: "default"',
    "---",
    "",
    text,
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "conversation-aaaaaaaaaaaaaaaaaaaaaaaa.md"), evidence({ id: "conversation-aaaaaaaaaaaaaaaaaaaaaaaa", groupId: "home-circle", userId: "u-owner", text: "主人今晚吃了米饭。" }), "utf8");
  await fs.writeFile(path.join(dir, "conversation-bbbbbbbbbbbbbbbbbbbbbbbb.md"), evidence({ id: "conversation-bbbbbbbbbbbbbbbbbbbbbbbb", groupId: "group-x", userId: "u_group_1000000", text: "群友今晚也吃米饭。" }), "utf8");
  const store = createIndexStore({ dataRoot, ollama: { dimension: 1 }, fetchImpl: fakeEmbed });
  await store.index();
  const mine = await search(dataRoot, {
    query: "米饭",
    authz: { principal: OWNER, scopes: [{ layer: "memory", visibility: "user" }], tenantId: "default" },
  });
  assert.deepEqual(mine.results.map((row) => path.basename(row.path, ".md")), ["conversation-aaaaaaaaaaaaaaaaaaaaaaaa"], JSON.stringify(mine.results.map((r) => r.path)));
  await fs.rm(dataRoot, { recursive: true, force: true });
});
