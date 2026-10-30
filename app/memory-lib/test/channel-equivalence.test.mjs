// memory-lib — F4: REST / MCP-stdio / MCP-streamable-HTTP channel equivalence.
//
// The same identity may reach the library over three transports. They are not
// three products: REST (/v1/*) is the core, the MCP stdio server forwards to it
// through the environment-bound identity, and the /mcp streamable-HTTP endpoint
// runs the same JSON-RPC handler against the in-process core. This file pins
// that the three agree on the core operations (search / get / capture+complete /
// pet-remember) and on the two denial modes
// (401 unauthenticated, 403 unauthorized action), so an endpoint or a permission
// check that exists on only one channel fails the suite instead of shipping.
//
// Run directly: node test/channel-equivalence.test.mjs   (registered in `npm test`)
// Isolation: every case runs against a throwaway workspace copy plus a throwaway
// registry/secret store. Production data is never read or written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createTestAuth } from "./test-auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const MCP_STDIO_ENTRY = path.join(ROOT, "mcp", "mcp-server.mjs");

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-channel-equivalence-"));
await fs.cp(path.join(here, "fixtures", "workspace"), path.join(TMP, "workspace"), { recursive: true });
const AUTH = await createTestAuth(ROOT, TMP);
const authRegistry = JSON.parse(await fs.readFile(AUTH.registryPath, "utf8"));
const authRole = authRegistry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.find((item) => item.role_id === "researcher");
for (const role of authRegistry.frameworks[0].agents.flatMap((agent) => agent.roles)) {
  role.group_id ??= "group-f4";
  role.user_id ??= "user-f4";
}
const unboundRole = structuredClone(authRole);
unboundRole.role_id = "capture-unbound";
delete unboundRole.group_id;
delete unboundRole.user_id;
authRegistry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01").roles.push(unboundRole);
authRole.group_id = "group-f4";
authRole.user_id = "user-f4";
const pilot = authRegistry.frameworks[0].agents.find((item) => item.agent_id === "pilot-01");
for (const identity of [
  { agent_id: "same-group-other-user", group_id: "group-f4", user_id: "user-other" },
  { agent_id: "other-group", group_id: "group-other", user_id: "user-f4" },
]) {
  pilot.roles.push({ ...structuredClone(authRole), role_id: identity.agent_id, group_id: identity.group_id, user_id: identity.user_id });
}
await fs.writeFile(AUTH.registryPath, JSON.stringify(authRegistry, null, 2) + "\n", "utf8");
const FIXTURE_WORKSPACE = path.join(TMP, "workspace");
const FIXTURE_DATA = path.join(FIXTURE_WORKSPACE, "memory");
const AUDIT_PATH = path.join(TMP, "audit.jsonl");
const DEV_SECRET = (await fs.readFile(path.join(AUTH.secretStore.dir, "memory-lib_deepseek-harness.secret"), "utf8")).replace(/\r?\n$/, "");

const libFactory = ({ scopes, principal }) => createMemoryLib({ dataRoot: FIXTURE_DATA, workspaceRoot: FIXTURE_WORKSPACE, scopes, principal });
// F7：capture 走提取链路时必须注入确定性 stub LLM，不得依赖在线模型。
const captureStubLlm = { async chat() { return "[]"; } };
const adapter = createLocalhostServer({ libFactory, registryPath: AUTH.registryPath, secretStore: AUTH.secretStore, auditPath: AUDIT_PATH, host: "127.0.0.1", port: 0, llm: captureStubLlm });
const addr = await adapter.listen();
const BASE = `http://127.0.0.1:${addr.port}`;

// The three channels, expressed as the operation -> transport mapping each one
// really uses. A channel is only "equivalent" if these stay equivalent.
const REST_ROUTES = {
  search: "/v1/search",
  get: "/v1/get",
  capture: "/v1/conversations/capture",
  complete: "/v1/conversations/complete",
  petRemember: "/v1/pet/remember",
};
const MCP_TOOLS = {
  search: "memory_search",
  get: "memory_get",
  capture: "memory_capture_conversation",
  complete: "memory_capture_complete",
  petRemember: "pet_remember",
};
const CHANNELS = ["rest", "mcp-stdio", "mcp-streamable-http"];
const UNKNOWN_ID = "mem_does_not_exist_channel_equivalence";

let seq = 0;
const nextId = () => (seq += 1);

// ---- REST channel ---------------------------------------------------------------
async function restCall(route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { transport: response.status, body: await response.json().catch(() => null) };
}

// The REST body carries an `ok` envelope flag that the in-process MCP payload
// does not; it marks the transport, not the operation result, so it is dropped
// before comparing payloads. Everything else is compared verbatim.
function payloadOf(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !("ok" in data)) return data;
  const { ok: _ok, ...payload } = data;
  return payload;
}

function normalizeRest(transport, body) {
  if (transport !== 200) return { transport, isError: true, status: transport, code: body?.error?.code ?? null, data: null, text: JSON.stringify(body) };
  return { transport, isError: false, status: 200, code: null, data: payloadOf(body), text: JSON.stringify(body) };
}

async function restInvoke(op, args, role, agent = "pilot-01") {
  const { transport, body } = await restCall(REST_ROUTES[op], { credential_ref: AUTH.credentialRef, secret: DEV_SECRET, principal: { agent_id: agent, role_id: role }, ...args });
  return normalizeRest(transport, body);
}

// ---- MCP channels ---------------------------------------------------------------
// Both MCP transports produce one JSON-RPC envelope, so both normalize the same
// way: a transport-level denial keeps its HTTP status/code, a tool-level failure
// carries `操作失败(<status>): <CODE> message`, a success carries a JSON payload.
function normalizeMcp(transport, body) {
  if (transport !== 200) return { transport, isError: true, status: transport, code: body?.error?.code ?? null, data: null, text: JSON.stringify(body) };
  const result = body?.result;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) {
    const match = text.match(/操作失败\((\d+)\):\s*(\S+)/);
    return { transport, isError: true, status: match ? Number(match[1]) : null, code: match ? match[2] : null, data: null, text };
  }
  let data = null;
  try { data = payloadOf(JSON.parse(text)); } catch { data = null; }
  return { transport, isError: false, status: 200, code: null, data, text };
}

async function mcpHttpCall(message, role, { secret = DEV_SECRET, agent = "pilot-01", anonymous = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (!anonymous) {
    headers["x-mcp-credential-ref"] = AUTH.credentialRef;
    headers["x-mcp-secret"] = secret;
    headers["x-mcp-agent"] = agent;
    headers["x-mcp-role"] = role;
  }
  const response = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  return { transport: response.status, body: await response.json().catch(() => null) };
}

async function mcpHttpInvoke(tool, args, role, options) {
  const { transport, body } = await mcpHttpCall({ jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: tool, arguments: args } }, role, options);
  return normalizeMcp(transport, body);
}

function stdioEnv(role, secret, agent) {
  const env = { ...process.env, MCP_MEMORY_URL: BASE, MCP_MEMORY_CRED_REF: AUTH.credentialRef, MCP_MEMORY_AGENT: agent, MCP_MEMORY_ROLE: role };
  delete env.MCP_MEMORY_SECRET;
  delete env.MCP_MEMORY_SECRET_FILE;
  if (typeof secret === "string") env.MCP_MEMORY_SECRET = secret;
  return env;
}

// `secret: null` starts the server with no credential at all (the startup check
// must refuse it), while the default spawns it with the real one.
function spawnStdio(role, { secret = DEV_SECRET, agent = "pilot-01" } = {}) {
  return spawn(process.execPath, [MCP_STDIO_ENTRY], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: stdioEnv(role, secret, agent) });
}

// One request per line, one response line back: the real stdio transport.
function stdioRequest(child, message, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => finish(reject, new Error(`MCP stdio timed out after ${timeoutMs}ms; stderr: ${stderr.trim()}`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.id === message.id) { finish(resolve, parsed); return; }
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => finish(reject, new Error(`MCP stdio child exited (${code}) before responding; stderr: ${stderr.trim()}`)));
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function stdioInvoke(tool, args, role, options) {
  const child = spawnStdio(role, options);
  try {
    const response = await stdioRequest(child, { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: tool, arguments: args } });
    return normalizeMcp(200, response);
  } finally {
    child.kill();
  }
}

// ---- channel-agnostic invocation + comparison -----------------------------------
async function invoke(channel, op, args, role, options) {
  const payload = args;
  if (channel === "rest") return restInvoke(op, payload, role, options?.agent);
  if (channel === "mcp-stdio") return stdioInvoke(MCP_TOOLS[op], payload, role, options);
  if (channel === "mcp-streamable-http") return mcpHttpInvoke(MCP_TOOLS[op], payload, role, options);
  throw new Error(`unknown channel ${channel}`);
}

async function acrossChannels(op, args, role, describe, options) {
  const observed = {};
  for (const channel of CHANNELS) observed[channel] = await describe(await invoke(channel, op, args, role, options), channel);
  return observed;
}

function assertEquivalent(observed, label) {
  const names = Object.keys(observed);
  for (const name of names.slice(1)) {
    assert.deepEqual(observed[name], observed[names[0]], `${label}: ${name} disagrees with ${names[0]}\n  ${names[0]}: ${JSON.stringify(observed[names[0]])}\n  ${name}: ${JSON.stringify(observed[name])}`);
  }
  return observed[names[0]];
}

// Describes a refusal the same way whichever transport produced it.
function denial(label) {
  return (envelope, channel) => {
    assert.equal(envelope.isError, true, `${label} (${channel}): expected a refusal, got: ${envelope.text}`);
    return { status: envelope.status, code: envelope.code };
  };
}

const rel = (target) => (typeof target === "string" ? path.relative(FIXTURE_WORKSPACE, target).replace(/\\/g, "/") : target);

async function readFileOrNull(target) {
  try { return await fs.readFile(target, "utf8"); } catch { return null; }
}

after(async () => {
  await adapter.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

// ---- search ---------------------------------------------------------------------
test("F4 search: identical hits on REST, MCP-stdio and MCP-streamable-http", async () => {
  const observed = await acrossChannels("search", { query: "原则" }, "researcher", (envelope, channel) => {
    assert.equal(envelope.isError, false, `search via ${channel} failed: ${envelope.text}`);
    return {
      count: envelope.data.count,
      results: envelope.data.results.map((hit) => ({ path: rel(hit.path), line: hit.line, sourceType: hit.sourceType, matchCount: hit.matchCount, excerpt: hit.excerpt })),
    };
  });
  const value = assertEquivalent(observed, "search 原则");
  assert.ok(value.count >= 1, "fixture search must return at least one hit");
  assert.ok(value.results.some((hit) => hit.path.endsWith("business-principles.md")), "fixture hit missing");
});

// ---- RETRIEVAL-1 FIX1 entrance matrix --------------------------------------------
function resultPaths(data) {
  const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.items) ? data.items : [];
  return [...new Set(rows.map((row) => rel(row.path)).filter(Boolean))].sort();
}

test("M2.1-A timeline enumeration keeps channels and principal visibility equivalent", async () => {
  const day = "2026-10-10";
  const target = path.join(FIXTURE_DATA, "evidence", "conversations", "m21-a-matrix.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, [
    "---",
    "id: m21-a-matrix",
    "type: conversation",
    "capturedAt: 2026-10-10T03:00:00.000Z",
    "groupId: group-f4",
    "userId: user-f4",
    "---",
    "",
    "M21APRIVATE timeline visibility matrix excerpt.",
  ].join("\n"), "utf8");
  const platformTarget = path.join(FIXTURE_DATA, "tools-memory", "m21-a-platform.md");
  await fs.mkdir(path.dirname(platformTarget), { recursive: true });
  await fs.writeFile(platformTarget, [
    "---",
    "id: m21-a-platform",
    "container: tool",
    "visibility: platform",
    "updatedAt: 2026-10-10T04:00:00.000Z",
    "---",
    "",
    "M21APLATFORM timeline visibility matrix excerpt.",
  ].join("\n"), "utf8");
  const args = { since: day, until: day, limit: 100, offset: 0 };
  const observed = await acrossChannels("search", args, "researcher", (envelope, channel) => {
    assert.equal(envelope.isError, false, `timeline via ${channel} failed: ${envelope.text}`);
    return {
      total_count: envelope.data.total_count,
      next_offset: envelope.data.next_offset,
      results: envelope.data.results.map((item) => ({ path: rel(item.path), updatedAt: item.updatedAt, excerpt: item.excerpt })),
    };
  });
  const visible = assertEquivalent(observed, "M2.1-A timeline");
  assert.equal(visible.results.some((item) => item.path.endsWith("m21-a-matrix.md")), true);

  const visibilityCases = [
    { name: "same principal", role: "researcher", expected: true },
    { name: "same group other user", role: "same-group-other-user", expected: false },
    { name: "other group same user", role: "other-group", expected: false },
  ];
  for (const fixture of visibilityCases) {
    const rest = await restInvoke("search", args, fixture.role);
    const mcp = await invoke("mcp-streamable-http", "search", args, fixture.role);
    assert.equal(rest.isError, false, `${fixture.name} REST: ${rest.text}`);
    assert.equal(mcp.isError, false, `${fixture.name} MCP: ${mcp.text}`);
    const restVisible = resultPaths(rest.data).some((item) => item.endsWith("m21-a-matrix.md"));
    const mcpVisible = resultPaths(mcp.data).some((item) => item.endsWith("m21-a-matrix.md"));
    assert.equal(restVisible, fixture.expected, `${fixture.name} REST visibility`);
    assert.equal(mcpVisible, fixture.expected, `${fixture.name} MCP visibility`);
    assert.equal(resultPaths(rest.data).some((item) => item.endsWith("m21-a-platform.md")), true, `${fixture.name} REST platform visibility`);
    assert.equal(resultPaths(mcp.data).some((item) => item.endsWith("m21-a-platform.md")), true, `${fixture.name} MCP platform visibility`);
    const keyword = await restInvoke("search", { query: "M21APRIVATE", limit: 100 }, fixture.role);
    assert.equal(keyword.isError, false, `${fixture.name} keyword search: ${keyword.text}`);
    assert.equal(resultPaths(keyword.data).some((item) => item.endsWith("m21-a-matrix.md")), fixture.expected, `${fixture.name} enumeration/search visibility agreement`);
  }
});

test("FIX1 raw evidence entrance matrix keeps REST, joint, MCP, and get equivalent", async () => {
  const marker = `FIX1RAW${Date.now()}`;
  const capture = await restInvoke("capture", {
    source: "retrieval-1-fix1-matrix",
    conversation_id: `fix1-${Date.now()}`,
    event_id: `fix1-${Date.now()}#1`,
    messages: [{ role: "user", content: marker }],
  }, "researcher");
  assert.equal(capture.isError, false, capture.text);
  const evidenceId = capture.data.evidenceId;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const modes = ["hybrid", "formal", "raw"];
  const observations = {};
  for (const mode of modes) {
    const rest = await restInvoke("search", { query: marker, searchMode: mode, limit: 10, rawQuota: 3 }, "researcher");
    const mcp = await invoke("mcp-streamable-http", "search", { query: marker, searchMode: mode, limit: 10, rawQuota: 3 }, "researcher");
    assert.equal(rest.isError, false, `REST ${mode}: ${rest.text}`);
    assert.equal(mcp.isError, false, `MCP ${mode}: ${mcp.text}`);
    const restPaths = resultPaths(rest.data);
    const mcpPaths = resultPaths(mcp.data);
    assert.deepEqual(mcpPaths, restPaths, `${mode}: REST/MCP paths differ`);
    observations[mode] = { rest: restPaths, mcp: mcpPaths, channelsAgree: JSON.stringify(restPaths) === JSON.stringify(mcpPaths) };
  }
  const jointResponse = await restCall("/v1/search/joint", { query: marker, limit: 10, credential_ref: AUTH.credentialRef, secret: DEV_SECRET, principal: { agent_id: "pilot-01", role_id: "researcher" } });
  const joint = normalizeRest(jointResponse.transport, jointResponse.body);
  assert.equal(joint.isError, false, `joint: ${joint.text}`);
  observations.joint = { rest: resultPaths(joint.data), channelsAgree: true };
  assert.ok(observations.joint.rest.some((item) => item.includes("evidence/conversations/")), JSON.stringify(observations));
  const get = await restInvoke("get", { id: evidenceId }, "researcher");
  assert.equal(get.isError, false, `REST get: ${get.text}`);
  const mcpGet = await invoke("mcp-streamable-http", "get", { id: evidenceId }, "researcher");
  assert.equal(mcpGet.isError, false, `MCP get: ${mcpGet.text}`);
  assert.equal(mcpGet.data.item.id, get.data.item.id);
  assert.equal(mcpGet.data.item.path, get.data.item.path);
  observations.get = { rest: [rel(get.data.item.path)], mcp: [rel(mcpGet.data.item.path)], channelsAgree: true };
  assert.ok(observations.raw.rest.some((item) => item.includes("evidence/conversations/")), JSON.stringify(observations));
  console.log(JSON.stringify({ marker, evidenceId, observations }, null, 2));
});

// ---- get ------------------------------------------------------------------------
test("F4 get: identical item on every channel", async () => {
  const observed = await acrossChannels("get", { id: "mem_fixture_shared_business" }, "researcher", (envelope, channel) => {
    assert.equal(envelope.isError, false, `get via ${channel} failed: ${envelope.text}`);
    const item = envelope.data.item;
    return { id: item.id, path: rel(item.path), frontmatter: item.frontmatter, body: item.body };
  });
  const value = assertEquivalent(observed, "get mem_fixture_shared_business");
  assert.equal(value.id, "mem_fixture_shared_business");
});

test("F4 get: an unknown id is NOT_FOUND on every channel", async () => {
  const observed = await acrossChannels("get", { id: UNKNOWN_ID }, "researcher", denial("get unknown id"));
  assertEquivalent(observed, "get unknown id");
  assert.deepEqual(Object.values(observed)[0], { status: 404, code: "NOT_FOUND" });
});

// ---- capture + complete ---------------------------------------------------------
test("F4 capture + complete: one evidence id, cross-channel dedupe", async () => {
  const conversationId = `f4-channels-${Date.now()}`;
  const event = {
    source: "f4-channel-equivalence",
    conversation_id: conversationId,
    event_id: `${conversationId}#turn-1`,
    tags: ["f4-equivalence"],
    messages: [{ role: "user", content: `以后请记住：F4 三通道等价样本 ${conversationId}。` }, { role: "assistant", content: "已记录。" }],
  };
  const first = await invoke("rest", "capture", event, "researcher");
  assert.equal(first.isError, false, `capture via rest failed: ${first.text}`);
  assert.match(first.data.evidenceId, /^conversation-[0-9a-f]{24}$/);
  assert.equal(first.data.deduped, false, "the first capture must not be a replay");

  const replays = {};
  for (const [channel, op] of [["rest", "complete"], ["mcp-stdio", "complete"], ["mcp-streamable-http", "capture"]]) {
    const envelope = await invoke(channel, op, event, "researcher");
    assert.equal(envelope.isError, false, `${op} via ${channel} failed: ${envelope.text}`);
    replays[`${channel}:${op}`] = {
      evidenceId: envelope.data.evidenceId,
      fingerprint: envelope.data.fingerprint,
      candidateCount: envelope.data.candidateCount,
      conversationId: envelope.data.conversationId,
      deduped: envelope.data.deduped,
      duplicate: envelope.data.duplicate === true,
    };
  }
  for (const [label, replay] of Object.entries(replays)) {
    assert.equal(replay.evidenceId, first.data.evidenceId, `${label}: different evidence id`);
    assert.equal(replay.fingerprint, first.data.fingerprint, `${label}: different event fingerprint`);
    assert.equal(replay.candidateCount, first.data.candidateCount, `${label}: different candidate count`);
    assert.equal(replay.conversationId, conversationId, `${label}: different conversation id`);
    assert.deepEqual({ deduped: replay.deduped, duplicate: replay.duplicate }, { deduped: true, duplicate: true }, `${label}: not reported as a replay`);
  }
  const evidence = await readFileOrNull(first.data.evidencePath);
  assert.ok(evidence && evidence.includes(`F4 三通道等价样本 ${conversationId}`), "evidence must keep the raw conversation");
  assert.match(evidence, /groupId: "group-f4"/u, "capture must persist authenticated group ownership");
  assert.match(evidence, /userId: "user-f4"/u, "capture must persist authenticated user ownership");
  assert.equal(evidence.match(/F4 三通道等价样本/g)?.length, 1, "a replayed capture must not duplicate the evidence");
});

test("CAPTURE-ATTR-2 unbound identities are rejected and idempotently quarantined on every capture channel", async () => {
  const evidenceRoot = path.join(FIXTURE_DATA, "evidence", "conversations");
  const quarantineRoot = path.join(FIXTURE_DATA, "quarantine", "unattributed-captures");
  const before = (await fs.readdir(evidenceRoot)).filter((name) => name.endsWith(".md")).sort();
  const quarantineBefore = (await fs.readdir(quarantineRoot).catch(() => [])).filter((name) => name.endsWith(".json"));
  const marker = `CAPTURE_ATTR_2_CHANNEL_${Date.now()}`;
  const event = { source: "capture-attr-unbound", conversation_id: "capture-attr-unbound", event_id: "capture-attr-unbound", messages: [{ role: "user", content: marker }] };
  const observed = {};
  for (const [channel, op] of [["rest", "capture"], ["mcp-stdio", "capture"], ["mcp-streamable-http", "complete"]]) {
    const envelope = await invoke(channel, op, event, "capture-unbound");
    assert.equal(envelope.isError, true, `${channel} must reject unbound capture`);
    observed[channel] = { status: envelope.status, code: envelope.code };
  }
  assertEquivalent(observed, "unbound capture rejection");
  const after = (await fs.readdir(evidenceRoot)).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(after, before, "rejected channels must not persist conversation evidence");
  const quarantineAfter = (await fs.readdir(quarantineRoot)).filter((name) => name.endsWith(".json"));
  assert.equal(quarantineAfter.length, quarantineBefore.length + 1, "three channel replays of one event must add one quarantine record");
  const quarantined = await fs.readFile(path.join(quarantineRoot, quarantineAfter.find((name) => !quarantineBefore.includes(name))), "utf8");
  assert.match(quarantined, new RegExp(marker));
});

test("F4 capture: the private-field contract is rejected on every channel", async () => {
  const conversationId = `f4-contract-${Date.now()}`;
  const observed = {};
  for (const channel of CHANNELS) {
    const envelope = await invoke(channel, "complete", {
      source: "f4-channel-equivalence",
      conversation_id: conversationId,
      event_id: `${conversationId}#turn-1`,
      messages: [{ role: "user", content: "contract probe", private_message_field: "must reject" }],
    }, "researcher");
    assert.equal(envelope.isError, true, `${channel}: private message fields must be rejected`);
    assert.match(envelope.text, /UNSUPPORTED_MESSAGE_FIELDS|no other fields/i, `${channel}: unexpected rejection reason: ${envelope.text}`);
    observed[channel] = { status: envelope.status, code: envelope.code };
  }
  assertEquivalent(observed, "capture private-field contract");
  assert.deepEqual(Object.values(observed)[0], { status: 400, code: "BAD_REQUEST" });
});

// ---- pet / remember -------------------------------------------------------------
test("F4 pet/remember: identical candidate and classification on every channel", async () => {
  const marker = `remember-${Date.now()}`;
  const observed = await acrossChannels("petRemember", { input: `记住：我每周三做备份（${marker}）`, mode: "assistant" }, "pet-assistant", async (envelope, channel) => {
    assert.equal(envelope.isError, false, `pet_remember via ${channel} failed: ${envelope.text}`);
    const { id, path: candidatePath, ...rest } = envelope.data;
    const candidate = await readFileOrNull(candidatePath);
    assert.ok(candidate, `${channel}: candidate file missing at ${candidatePath}`);
    return {
      fields: Object.keys(envelope.data).sort(),
      outcome: {
        importance: envelope.data.importance,
        original: envelope.data.original,
        summary: envelope.data.summary,
      },
      fileHasOriginal: candidate.includes(rest.original),
    };
  });
  const value = assertEquivalent(observed, "pet_remember");
  // The intent prefix is stripped before the candidate is written, on every channel.
  assert.deepEqual(value.outcome.original, `我每周三做备份（${marker}）`);
  assert.equal(value.outcome.summary, `用户要求记住：我每周三做备份（${marker}）`);
  assert.equal(value.outcome.importance, "ordinary");
  assert.equal(value.fileHasOriginal, true);
});

// D29 retired governance interop coverage with the routes themselves.

// ---- 401: unauthenticated --------------------------------------------------------
test("F4 401: an unauthenticated identity is refused by every channel", async () => {
  const restResult = await restCall("/v1/search", { query: "原则" });
  const rest = normalizeRest(restResult.transport, restResult.body);
  const httpResult = await mcpHttpCall({ jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: "memory_search", arguments: { query: "原则" } } }, "researcher", { anonymous: true });
  const http = normalizeMcp(httpResult.transport, httpResult.body);
  // The stdio transport carries identity in its environment: a wrong secret fails
  // per call, and with no secret at all the server refuses to start (it never
  // serves anonymously).
  const stdioWrongSecret = await stdioInvoke("memory_search", { query: "原则" }, "researcher", { secret: "not-the-secret" });

  const child = spawnStdio("researcher", { secret: null });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  child.kill();

  assert.deepEqual(denial("rest")(rest, "rest"), { status: 401, code: "UNAUTHENTICATED" });
  assert.deepEqual(denial("mcp-streamable-http")(http, "mcp-streamable-http"), { status: 401, code: "UNAUTHENTICATED" });
  assert.deepEqual(denial("mcp-stdio")(stdioWrongSecret, "mcp-stdio"), { status: 401, code: "UNAUTHENTICATED" });
  assert.notEqual(exitCode, 0, "the stdio server must refuse to start without a credential");
  assert.match(stderr, /MCP_MEMORY_SECRET/, `unexpected stdio startup failure: ${stderr.trim()}`);
});

// ---- 403: unauthorized action ----------------------------------------------------
test("F4 403: an unauthorized action is denied by every channel", async () => {
  const cases = [
    { op: "search", args: { query: "原则" }, role: "learner" },
    { op: "get", args: { id: "mem_fixture_shared_business" }, role: "learner" },
    { op: "petRemember", args: { input: "记住：越权测试", mode: "assistant" }, role: "reader" },
  ];

  const broken = [];
  for (const item of cases) {
    const label = `${item.op} as ${item.role}`;
    try {
      const observed = await acrossChannels(item.op, item.args, item.role, denial(label));
      assertEquivalent(observed, label);
      assert.deepEqual(Object.values(observed)[0], { status: 403, code: "FORBIDDEN" }, `${label}: expected 403 FORBIDDEN`);
    } catch (error) {
      broken.push(error.message);
    }
  }
  assert.deepEqual(broken, [], `unauthorized-action parity broken:\n- ${broken.join("\n- ")}`);
});
