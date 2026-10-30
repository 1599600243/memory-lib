import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationMemory } from "../src/conversation-memory.mjs";

const principal = { framework_id: "deepseek-harness", agent_id: "admin-01", role_id: "librarian-admin", group_id: "capture-group", user_id: "capture-user" };
const scopes = [{ layer: "memory", visibility: "shared" }];

test("complete capture replaces an earlier partial event and only later replays dedupe", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d15-partial-"));
  let proposed = 0;
  const memory = createConversationMemory({
    dataRoot,
    libFactory: () => ({
      scopes,
      propose: async ({ content }) => ({ id: `candidate-${++proposed}`, path: path.join(dataRoot, "inbox", `${proposed}.md`), status: "proposed", content }),
    }),
  });
  const common = { conversationId: "conversation-1", source: "dsh", eventId: "event-1", principal, scopes };
  const partial = await memory.capture({ ...common, partial: true, messages: [{ role: "assistant", content: "正在整理前半段" }] });
  assert.equal(partial.partial, true);
  const complete = await memory.capture({ ...common, partial: false, messages: [{ role: "assistant", content: "完整结论：提交前必须运行全套测试并保存结果。" }] });
  assert.equal(complete.duplicate, undefined);
  assert.equal(complete.partial, false);
  assert.equal(complete.evidenceId, partial.evidenceId);
  const evidence = await fs.readFile(complete.evidencePath, "utf8");
  assert.match(evidence, /完整结论/);
  assert.doesNotMatch(evidence, /正在整理前半段/);
  const replay = await memory.capture({ ...common, partial: false, messages: [{ role: "assistant", content: "完整结论：提交前必须运行全套测试并保存结果。" }] });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.partial, false);
});

test("queued complete event replaces a queued partial record with the same fingerprint", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d15-partial-queue-"));
  const memory = createConversationMemory({ dataRoot, libFactory: () => ({ scopes, propose: async () => ({}) }) });
  const common = { conversationId: "conversation-2", source: "dsh", eventId: "event-2", principal, scopes, extract: false };
  const queued = await memory.enqueue({ ...common, partial: true, messages: [{ role: "assistant", content: "半段" }] });
  await memory.enqueue({ ...common, partial: false, messages: [{ role: "assistant", content: "完整内容" }] });
  const record = JSON.parse(await fs.readFile(queued.path, "utf8"));
  assert.equal(record.partial, false);
  assert.equal(record.messages[0].content, "完整内容");
});
