import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateAgents,
  formatReport,
  main,
  readTailLines,
  registrySets,
  scan,
  summarize,
} from "../scripts/scan-ghost-agents.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "scan-ghost-agents-"));
after(() => fs.rm(TMP, { recursive: true, force: true }));

const registryPath = path.join(TMP, "identity.json");
const identitiesPath = path.join(TMP, "identities.json");
const auditPath = path.join(TMP, "access.jsonl");

const registryJson = { frameworks: [{ framework_id: "deepseek-harness", agents: [
  { agent_id: "agent-known", roles: [{ role_id: "chat-reader" }] },
] }] };
const identitiesJson = { identities: [
  { agent_id: "agent-known", channel_uid: "known" },
  { agent_id: "agent-identities-only", channel_uid: "only" },
] };

const line = (fields) => JSON.stringify({ ts: "2026-11-22T10:00:00.000Z", agent: "agent-known", role: "chat-reader", allow: true, denyReason: null, ...fields });

const fixtureLines = [
  line({ agent: "agent-known" }),
  line({ agent: "agent-known", ts: "2026-11-22T11:00:00.000Z" }),
  line({ agent: "agent-ghost", role: "chat-writer", allow: false, denyReason: "CONVERSATION_CAPTURE_REJECTED", ts: "2026-11-22T09:00:00.000Z" }),
  line({ agent: "agent-ghost", role: "chat-writer", allow: false, denyReason: "CONVERSATION_CAPTURE_REJECTED", ts: "2026-11-22T12:34:56.000Z", repeat: 2, aggregated: true }),
  line({ agent: "agent-identities-only", role: "chat-reader", allow: true, ts: "2026-11-22T08:00:00.000Z" }),
  "{not json",
  JSON.stringify({ ts: "2026-11-22T13:00:00.000Z", allow: false, denyReason: "UNAUTHENTICATED" }),
  "",
];

await fs.writeFile(registryPath, JSON.stringify(registryJson));
await fs.writeFile(identitiesPath, JSON.stringify(identitiesJson));
await fs.writeFile(auditPath, `${fixtureLines.join("\n")}\n`);

test("registered agent is not reported as ghost", async () => {
  const { summary } = await scan({ audit: auditPath, registry: registryPath, identities: identitiesPath, tail: 100 });
  const known = summary.rows.find((row) => row.agent === "agent-known");
  assert.equal(known.status, "ok");
  assert.equal(known.inIdentity, true);
  assert.equal(known.inIdentities, true);
  assert.deepEqual(summary.ghosts.map((row) => row.agent), ["agent-ghost"]);
});

test("ghost agent keeps allow/deny counts and the latest timestamp (repeat included)", async () => {
  const { summary } = await scan({ audit: auditPath, registry: registryPath, identities: identitiesPath, tail: 100 });
  const ghost = summary.ghosts.find((row) => row.agent === "agent-ghost");
  assert.ok(ghost, "ghost should be listed");
  assert.equal(ghost.allow, 0);
  assert.equal(ghost.deny, 4); // 1 plain line + 1 line with repeat=2
  assert.equal(ghost.events, 4);
  assert.equal(ghost.last, "2026-11-22T12:34:56.000Z");
  assert.deepEqual(ghost.denyReasons, { CONVERSATION_CAPTURE_REJECTED: 4 });
});

test("identities.json-only agent is flagged separately and is not a ghost", async () => {
  const { summary } = await scan({ audit: auditPath, registry: registryPath, identities: identitiesPath, tail: 100 });
  const only = summary.rows.find((row) => row.agent === "agent-identities-only");
  assert.equal(only.status, "identities-only");
  assert.equal(only.inIdentity, false);
  assert.equal(only.inIdentities, true);
  assert.deepEqual(summary.identitiesOnly.map((row) => row.agent), ["agent-identities-only"]);
  assert.deepEqual(summary.ghosts.map((row) => row.agent), ["agent-ghost"]);
});

test("invalid and agent-less lines are skipped without throwing", async () => {
  const aggregation = aggregateAgents(fixtureLines);
  assert.equal(aggregation.skipped, 2); // invalid JSON + record without agent; blank line ignored
  assert.equal(aggregation.agents.size, 3);
  assert.deepEqual([...aggregation.agents.keys()].sort(), ["agent-ghost", "agent-identities-only", "agent-known"]);
});

test("readTailLines honours the tail limit and keeps the newest line", async () => {
  const lines = await readTailLines(auditPath, 2);
  assert.equal(lines.length, 2);
  assert.match(lines.at(-1), /UNAUTHENTICATED/u);
  const wider = await readTailLines(auditPath, 6);
  assert.equal(wider.length, 6);
  assert.ok(wider.some((line) => /agent-identities-only/u.test(line)));
});

test("registrySets tolerates malformed registry documents", () => {
  assert.deepEqual([...registrySets(null, null).identityAgents], []);
  assert.deepEqual([...registrySets({ frameworks: [{ agents: [{ agent_id: "" }, {}] }] }, { identities: "nope" }).identityRecords], []);
});

test("formatReport prints the ghost section and its counts", async () => {
  const { summary, meta } = await scan({ audit: auditPath, registry: registryPath, identities: identitiesPath, tail: 100 });
  const text = formatReport(summary, meta);
  assert.match(text, /GHOST \(未注册但在活动\): 1/u);
  assert.match(text, /agent-ghost/u);
  assert.match(text, /CONVERSATION_CAPTURE_REJECTED=4/u);
  assert.match(text, /IDENTITIES-ONLY/u);
});

test("CLI exits 0 even when a ghost is found, and --json is machine readable", async () => {
  const logs = [];
  const original = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  let code;
  try {
    code = await main(["--audit", auditPath, "--registry", registryPath, "--identities", identitiesPath, "--tail", "100", "--json"]);
  } finally { console.log = original; }
  assert.equal(code, 0);
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(payload.totals.ghosts, 1);
  assert.equal(payload.meta.identityAgents, 1);
  assert.equal(payload.ghosts[0].agent, "agent-ghost");
});
