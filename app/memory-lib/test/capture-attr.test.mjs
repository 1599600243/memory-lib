import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createConversationMemory } from "../src/conversation-memory.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createTranscriptImporter } from "../src/transcript-importer.mjs";
import { parseFrontmatter } from "../src/read-only-core.mjs";
import { unquote } from "../src/frontmatter-util.mjs";
import { createTestAuth } from "./test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const owner = { framework_id: "test", agent_id: "capture-agent", role_id: "capture-role", group_id: "capture-group", user_id: "capture-user" };

async function assertOwnedEvidence(filePath) {
  const frontmatter = parseFrontmatter(await fs.readFile(filePath, "utf8")).frontmatter;
  assert.equal(unquote(frontmatter.groupId), owner.group_id);
  assert.equal(unquote(frontmatter.userId), owner.user_id);
}

test("real conversation capture persists credential ownership and rejects an unbound principal", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-capture-attr-"));
  const workspaceRoot = path.join(tmp, "workspace");
  const dataRoot = path.join(workspaceRoot, "memory");
  const evidenceRoot = path.join(dataRoot, "evidence", "conversations");
  const transcriptImportRoot = path.join(tmp, "transcript-import");
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const pilot = registry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01");
  const researcher = pilot.roles.find((item) => item.role_id === "researcher");
  researcher.group_id = "capture-group";
  researcher.user_id = "capture-user";
  const unbound = pilot.roles.find((item) => item.role_id === "steward");
  delete unbound.group_id;
  delete unbound.user_id;
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    transcriptImportRoot,
    vectorLane: { probe: false },
    libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
  });
  try {
    const address = await server.listen();
    async function capture(role, eventId) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/conversations/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credential_ref: auth.credentialRef,
          secret: auth.authValue,
          principal: { agent_id: "pilot-01", role_id: role },
          source: "capture-attr-test",
          conversation_id: eventId,
          event_id: eventId,
          messages: [{ role: "user", content: `capture ownership contract ${eventId}` }],
        }),
      });
      return { status: response.status, body: await response.json() };
    }

    const owned = await capture("researcher", "owned");
    assert.equal(owned.status, 200);
    const ownedText = await fs.readFile(path.join(evidenceRoot, `${owned.body.evidenceId}.md`), "utf8");
    const ownedFrontmatter = parseFrontmatter(ownedText).frontmatter;
    assert.equal(unquote(ownedFrontmatter.groupId), "capture-group");
    assert.equal(unquote(ownedFrontmatter.userId), "capture-user");

    const before = (await fs.readdir(evidenceRoot)).filter((name) => name.endsWith(".md"));
    const quarantineMarker = "CAPTURE_ATTR_2_QUARANTINE_ONLY_MARKER";
    async function unboundCapture() {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/conversations/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credential_ref: auth.credentialRef,
          secret: auth.authValue,
          principal: { agent_id: "pilot-01", role_id: "steward" },
          source: "capture-attr-test",
          conversation_id: "unbound-conversation",
          event_id: "unbound-event",
          messages: [{ role: "user", content: quarantineMarker }],
        }),
      });
      return { status: response.status, body: await response.json() };
    }
    const rejected = await unboundCapture();
    const duplicate = await unboundCapture();
    for (const response of [rejected, duplicate]) {
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "BAD_REQUEST");
      assert.equal(response.body.error.detail, "CONVERSATION_CAPTURE_REJECTED");
      assert.match(response.body.error.message, /group_id and user_id/iu);
    }
    const after = (await fs.readdir(evidenceRoot)).filter((name) => name.endsWith(".md"));
    assert.deepEqual(after, before, "an unbound capture must not persist evidence");

    const quarantineRoot = path.join(dataRoot, "quarantine", "unattributed-captures");
    const quarantined = (await fs.readdir(quarantineRoot)).filter((name) => name.endsWith(".json"));
    assert.equal(quarantined.length, 1, "replayed event_id must create exactly one quarantine record");
    const record = JSON.parse(await fs.readFile(path.join(quarantineRoot, quarantined[0]), "utf8"));
    assert.equal(record.reason, "unattributed-capture");
    assert.equal(record.conversation_id, "unbound-conversation");
    assert.equal(record.event_id, "unbound-event");
    assert.equal(record.source, "capture-attr-test");
    assert.match(record.capturedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(record.messages, [{ role: "user", content: quarantineMarker }]);
    assert.equal(record.principal.agent_id, "pilot-01");
    assert.equal(record.principal.role_id, "steward");
    assert.equal(record.principal.group_id, "unknown");
    assert.equal(record.principal.user_id, "unknown");

    async function search(payload) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "researcher" }, ...payload }),
      });
      return { status: response.status, body: await response.json() };
    }
    const ordinary = await search({ query: quarantineMarker, searchMode: "hybrid", rawQuota: 100, documentQuota: 100, limit: 100 });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body.results.some((item) => JSON.stringify(item).includes(quarantineMarker)), false);
    const timeline = await search({ query: "", since: "2000-01-01", until: "2100-01-01", limit: 100 });
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.results.some((item) => JSON.stringify(item).includes(quarantineMarker)), false);

    async function admin(route, role, extra = {}) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: role === "librarian-admin" ? "admin-01" : "pilot-01", role_id: role }, ...extra }),
      });
      return { status: response.status, body: await response.json() };
    }
    const ordinaryRead = await admin("/v1/admin/quarantine/unattributed-captures", "researcher");
    assert.equal(ordinaryRead.status, 403);
    assert.equal(ordinaryRead.body.error.detail, "ACTION_DENIED");
    const list = await admin("/v1/admin/quarantine/unattributed-captures", "librarian-admin");
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
    assert.equal(JSON.stringify(list.body).includes(quarantineMarker), false, "list must not expose quarantined message bodies");
    const read = await admin("/v1/admin/quarantine/unattributed-captures/read", "librarian-admin", { id: list.body.records[0].id });
    assert.equal(read.status, 200);
    assert.equal(read.body.record.messages[0].content, quarantineMarker);
    const partialResponse = await fetch(`http://127.0.0.1:${address.port}/v1/conversations/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "steward" }, source: "capture-attr-partial", conversation_id: "unbound-partial", event_id: "unbound-partial", partial: true, messages: [{ role: "assistant", content: "partial without session" }] }),
    });
    assert.equal(partialResponse.status, 400);

    await fs.mkdir(transcriptImportRoot, { recursive: true });
    await fs.writeFile(path.join(transcriptImportRoot, "unbound-queue.json"), JSON.stringify({ conversation_id: "unbound-queue", event_id: "unbound-queue", source: "capture-attr-transcript", messages: [{ role: "user", content: "queued transcript body" }] }), "utf8");
    const transcriptResponse = await fetch(`http://127.0.0.1:${address.port}/v1/transcripts/import/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: "steward" }, source: "capture-attr-transcript" }),
    });
    const transcriptBody = await transcriptResponse.json();
    assert.equal(transcriptResponse.status, 400);
    assert.equal(transcriptBody.error.code, "BAD_REQUEST");
    assert.equal(transcriptBody.error.detail, "CONVERSATION_CAPTURE_REJECTED");

    const finalList = await admin("/v1/admin/quarantine/unattributed-captures", "librarian-admin");
    assert.equal(finalList.body.count, 3);
    const partialMeta = finalList.body.records.find((item) => item.event_id === "unbound-partial");
    const partialRead = await admin("/v1/admin/quarantine/unattributed-captures/read", "librarian-admin", { id: partialMeta.id });
    assert.equal(partialRead.body.record.partial, true);
    assert.equal(partialRead.body.record.session_id, null);
    assert.ok(finalList.body.records.some((item) => item.event_id === "unbound-queue"));

    const health = await admin("/v1/admin/health", "librarian-admin");
    assert.equal(health.status, 200);
    assert.equal(health.body.quarantine.unattributed_captures, 3);
  } finally {
    await server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("every internal capture exit rejects missing ownership before persistence", async () => {
  const cases = [
    { name: "direct complete capture with empty session", invoke: (memory, common) => memory.capture({ ...common, sessionId: null, messages: [{ role: "user", content: "complete" }] }) },
    { name: "direct partial capture", invoke: (memory, common) => memory.capture({ ...common, partial: true, messages: [{ role: "assistant", content: "partial" }] }) },
    { name: "queued automatic capture", invoke: (memory, common) => memory.enqueue({ ...common, messages: [{ role: "user", content: "queued" }] }) },
  ];
  for (const fixture of cases) {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-capture-exit-"));
    try {
      const memory = createConversationMemory({ dataRoot });
      const common = { conversationId: fixture.name, eventId: fixture.name, source: "capture-exit-test", principal: owner, scopes: [] };
      const result = await fixture.invoke(memory, common);
      if (result.evidencePath) await assertOwnedEvidence(result.evidencePath);
      else {
        await memory.drain({ limit: 20 });
        const index = await memory.readIndex();
        await assertOwnedEvidence(path.join(memory.root, `${Object.values(index.events)[0].evidenceId}.md`));
      }
      for (const missing of ["group_id", "user_id"]) {
        const principal = { ...owner };
        delete principal[missing];
        await assert.rejects(fixture.invoke(memory, { ...common, eventId: `${fixture.name}-${missing}`, principal }), /principal group_id and user_id/u, `${fixture.name} must reject missing ${missing}`);
      }
      const quarantined = await memory.listQuarantine({ limit: 20 });
      assert.equal(quarantined.length, 2, `${fixture.name} must quarantine each missing ownership claim`);
      assert.ok(quarantined.every((item) => item.reason === "unattributed-capture"));
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
  }
});

test("drain quarantines and removes a legacy unattributed queue record instead of retrying", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-capture-legacy-queue-"));
  try {
    const memory = createConversationMemory({ dataRoot });
    await fs.mkdir(memory.queueRoot, { recursive: true });
    const fingerprint = "0123456789abcdef01234567";
    const queuePath = path.join(memory.queueRoot, `${fingerprint}.json`);
    await fs.writeFile(queuePath, `${JSON.stringify({ version: 1, status: "pending", attempts: 0, nextAttemptAt: new Date(0).toISOString(), fingerprint, conversationId: "legacy-unbound", eventId: "legacy-unbound", source: "legacy-queue", sessionId: null, principal: { agent_id: "legacy-agent", role_id: "legacy-role" }, scopes: [], partial: false, messages: [{ role: "user", content: "legacy queue body" }] }, null, 2)}\n`, "utf8");
    const result = await memory.drain({ limit: 20 });
    assert.deepEqual(result, { processed: 0, quarantined: 1, busy: false });
    assert.equal((await memory.queueStatus()).pending, 0);
    assert.equal((await memory.quarantineStatus()).unattributed_captures, 1);
    const record = await memory.readQuarantine(fingerprint);
    assert.equal(record.messages[0].content, "legacy queue body");
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("transcript batch inherits server principal and cannot queue without ownership", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-capture-import-"));
  const dataRoot = path.join(tmp, "memory");
  const importRoot = path.join(tmp, "imports");
  try {
    const memory = createConversationMemory({ dataRoot });
    const importer = createTranscriptImporter({ importRoot, conversationMemory: memory });
    await fs.mkdir(importRoot, { recursive: true });
    await fs.writeFile(path.join(importRoot, "owned.json"), JSON.stringify({ messages: [{ role: "user", content: "batch owned" }] }), "utf8");
    const imported = await importer.scan({ principal: owner, scopes: [] });
    assert.equal(imported.queued, 1);
    await memory.drain({ limit: 20 });
    const index = await memory.readIndex();
    await assertOwnedEvidence(path.join(memory.root, `${Object.values(index.events)[0].evidenceId}.md`));

    await fs.writeFile(path.join(importRoot, "unbound.json"), JSON.stringify({ messages: [{ role: "user", content: "batch unbound" }] }), "utf8");
    await assert.rejects(importer.scan({ principal: { ...owner, user_id: undefined }, scopes: [] }), /principal group_id and user_id/u);
    assert.equal((await memory.quarantineStatus()).unattributed_captures, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
