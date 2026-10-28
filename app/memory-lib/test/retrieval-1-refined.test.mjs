import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConversationMemory } from "../src/conversation-memory.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-retrieval1-refined-"));
const principal = { framework_id: "f-r1", group_id: "g-r1", user_id: "u-r1", agent_id: "a-r1", role_id: "r-r1", tenant_id: "default" };
const capture = createConversationMemory({ dataRoot: root });
const lib = createMemoryLib({ dataRoot: root, workspaceRoot: root, principal, scopes: null });

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("capture is stored and immediately retrievable by evidence id before indexing", async () => {
  const result = await capture.capture({ conversationId: "r1-state", eventId: "state-1", source: "test", principal, messages: [{ role: "user", content: "R1 stored immediately marker" }] });
  assert.equal(result.status, "stored");
  assert.equal(result.searchStatus, "stored");
  assert.equal(result.evidenceId, "conversation-" + result.fingerprint);
  const item = await lib.get(result.evidenceId);
  assert.ok(item, "stored evidence must be retrievable by id without index");
  assert.equal(item.frontmatter.type, "conversation");
});

test("search exposes memories documents evidence modes and hybrid caps evidence at three of top ten", async () => {
  for (let i = 0; i < 5; i += 1) await capture.capture({ conversationId: `r1-hybrid-${i}`, eventId: `hybrid-${i}`, source: "test", principal, messages: [{ role: "user", content: `R1 hybrid shared marker ${i}` }] });
  const modes = await Promise.all(["memories", "documents", "evidence"].map((searchMode) => lib.search({ query: "R1 hybrid shared marker", searchMode, limit: 10, graphExpand: false })));
  assert.ok(modes[0].every((item) => item.result_type === "memory"));
  assert.ok(modes[1].every((item) => item.result_type === "evidence"));
  assert.ok(modes[2].every((item) => item.result_type === "evidence"));
  const hybrid = await lib.search({ query: "R1 hybrid shared marker", searchMode: "hybrid", limit: 10, graphExpand: false });
  assert.ok(hybrid.length <= 10);
  assert.ok(hybrid.filter((item) => item.result_type === "evidence").length <= 3);
});

test("raw evidence results are deduplicated by conversation and windowed", async () => {
  const result = await capture.capture({ conversationId: "r1-window", eventId: "window-1", source: "test", principal, messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `R1 window marker ${i}` })) });
  const hits = await lib.search({ query: "R1 window marker", searchMode: "evidence", limit: 10, graphExpand: false });
  const sameConversation = hits.filter((item) => item.frontmatter?.conversationId === "r1-window" || item.conversation_id === "r1-window");
  assert.ok(sameConversation.length <= 1);
  assert.ok(hits.every((item) => String(item.excerpt ?? "").length > 0));
});
