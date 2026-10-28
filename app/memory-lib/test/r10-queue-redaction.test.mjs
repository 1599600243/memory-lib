import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createConversationMemory } from "../src/conversation-memory.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-r10-"));
let releaseExtraction;
const extractionPending = new Promise((resolve) => { releaseExtraction = resolve; });
const memory = createConversationMemory({
  dataRoot: root,
  llm: { chat: async () => { await extractionPending; return "[]"; } },
  libFactory: () => ({ propose: async () => { throw new Error("unexpected propose"); } }),
});

after(async () => {
  releaseExtraction();
  await fs.rm(root, { recursive: true, force: true });
});

test("enqueue persists only the redacted capture contract before drain", async () => {
  const credential = "R10_QUEUE_CREDENTIAL_SHOULD_NOT_PERSIST_123456789";
  const result = await memory.enqueue({
    conversationId: "r10-conversation",
    source: "http",
    eventId: "r10-event#1",
    sessionId: "r10-session",
    workspace: "D:/workspace/r10",
    tags: ["queue", "r10"],
    principal: { agent_id: "pilot-01", role_id: "reader", group_id: "capture-group", user_id: "capture-user", credential_ref: credential, secret: credential },
    scopes: [{ layer: "memory", visibility: "shared" }],
    extract: true,
    messages: [{ role: "user", content: `请记住这个决定；secret=${credential}; 以后使用中文。` }],
    private_token: credential,
  });

  const queued = JSON.parse(await fs.readFile(result.path, "utf8"));
  assert.equal(queued.fingerprint, result.fingerprint);
  assert.deepEqual(Object.keys(queued).sort(), [
    "attempts", "conversationId", "eventId", "extract", "fingerprint", "messages", "nextAttemptAt", "partial",
    "principal", "queuedAt", "scopes", "sessionId", "source", "status", "tags", "version", "workspace",
  ].sort());
  assert.equal(queued.principal.credential_ref, undefined);
  assert.equal(queued.principal.secret, undefined);
  assert.equal(queued.private_token, undefined);
  assert.equal(new RegExp(credential).test(JSON.stringify(queued)), false);
  assert.match(queued.messages[0].content, /（含凭证，略）/);
  assert.equal(queued.messages[0].role, "user");

  releaseExtraction();
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await memory.queueStatus()).pending === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
});
