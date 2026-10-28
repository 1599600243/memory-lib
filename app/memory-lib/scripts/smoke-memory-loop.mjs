// MEMORY-LOOP-1 — repeatable deploy-prep smoke run (real HTTP, one process, zero model calls).
//
// WHAT THIS IS FOR
//   A single command that answers, in one machine-readable artifact, "does the memory-loop
//   vertical still behave, end to end, on the code that is about to be deployed?" It is not a
//   substitute for the per-slice tests under test/ — those pin semantics far more finely. This is
//   the deploy gate: six groups, each an observable through the public HTTP surface, each written
//   with a POSITIVE CONTROL so that "it was rejected" can never be confused with "the route was
//   never wired and everything 404s".
//
// USAGE
//   node scripts/smoke-memory-loop.mjs [output.json]
//   MEMORY_LOOP_SMOKE_OUT=<path> node scripts/smoke-memory-loop.mjs
//   Default output: D:/MemoryLib/reports/DEPLOY-PREP-1-smoke.json
//   Exit code 1 if any check FAILs (the JSON is still written — a failed run is evidence too).
//
// HARD CONSTRAINTS THIS FILE OBEYS (they are the reason it is shaped this way)
//   * isolation: every byte it writes lives under os.tmpdir(); the deployment data root
//     (D:/MemoryLib/data) is never read or written. The identity registry is CLONED from
//     runtime/identity.json (a template inside the package) — never the deployment copy.
//   * port 8787 is never used and never touched: the server binds 127.0.0.1:0 (ephemeral).
//   * ZERO model calls: a tripwire `llm` whose `chat` throws is injected into the server, so an
//     accidental model call fails the run loudly instead of silently costing tokens.
//   * behaviour is asserted over HTTP only. The two filesystem uses are (i) snapshotting dataRoot
//     for the read-only check ⑥ and (ii) nothing else. No assertion in ①–⑤ is made against a file:
//     "the memory was written" is proven by reading it back through POST /v1/get.
//   * deterministic output: ids are normalised (<evidence-id>, <job-id>), instants become
//     <iso-instant>, absolute temp paths become <tmp>/<dataRoot>. Two runs must produce
//     byte-identical JSON; nothing in the artifact may drift with time or with the temp dir name.
//
// FIXTURES
//   Three identities, all in the cloned registry, all able to authenticate over real HTTP with
//   credential_ref + secret + principal{agent_id, role_id}:
//     smoke-a  (agent smoke-a-01, role smoke-a)  — group-a / user-a   the claimant
//     smoke-b  (agent smoke-b-01, role smoke-b)  — group-b / user-b   a different tenant
//     smoke-a2 (agent smoke-a-02, role smoke-a2) — group-a / user-a   same tenant, NOT the claimant
//   smoke-a2 is not decoration: the 409 ALREADY_CLAIMED and 403 NOT_CLAIMANT paths are
//   reachable ONLY by an identity that can still SEE the job, i.e. same group_id + user_id.
//   A cross-tenant caller gets 404 instead (verified below, check 02d/02f) — that difference is
//   itself a security property worth recording, not a gap.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createTestAuth } from "../test/test-auth.mjs";
// Existing helper (not modified): tree snapshot + strict diff. Used ONLY by check ⑥.
import { snapshotTree, diffSnapshots } from "./zero-write-check.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = "D:/MemoryLib/reports/DEPLOY-PREP-1-smoke.json";
const OUT_PATH = process.argv[2] ?? process.env.MEMORY_LOOP_SMOKE_OUT ?? DEFAULT_OUT;

// ── fixture constants (independent truth source: these are OUR inputs, not recomputed from SUT) ──
const WORKSPACE = "D:/MemoryLib/smoke/MEMORY-LOOP-1";
// Same documented transformation as the capture write entry (normalise → lowercase → collapse
// non-[a-z0-9._-] runs → trim dashes). Written out here so that a drift in the server's derivation
// shows up as a FAILED check instead of being silently mirrored.
const PROJECT = WORKSPACE.trim().replace(/\\/gu, "/").replace(/\/+$/gu, "").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100);
const STABLE_KEY = "smoke-1";
// Discriminative retrieval marker: present in BOTH versions' bodies so that "the old version is
// absent from default search" can only be explained by supersede filtering — not by the query
// simply not appearing in the old text (that would be a non-discriminating check).
const MARKER = "冒烟稳定键标记ZWQ7";
const BODY_OLD = `提炼结论：memory-loop-1 冒烟 ${MARKER} 第一版正文，要求带稳定键。`;
const BODY_NEW = `提炼结论：memory-loop-1 冒烟 ${MARKER} 第二版正文（取代第一版）。`;

const PRINCIPALS = {
  A: { agent_id: "smoke-a-01", role_id: "smoke-a" },
  A2: { agent_id: "smoke-a-02", role_id: "smoke-a2" },
  B: { agent_id: "smoke-b-01", role_id: "smoke-b" },
};

// ── deterministic scrubbers ───────────────────────────────────────────────────────────
let TMP_ROOT = "";
let WORKSPACE_ROOT = "";
let DATA_ROOT_REAL = "";
function scrub(value) {
  let out = String(value);
  // dataRoot is the longest of the three temp paths ⇒ replace it first.
  for (const [placeholder, prefix] of [["<dataRoot>", DATA_ROOT_REAL], ["<workspaceRoot>", WORKSPACE_ROOT], ["<tmp>", TMP_ROOT]]) {
    if (!prefix) continue;
    const variants = [prefix, JSON.stringify(prefix).slice(1, -1), prefix.split("\\").join("/")];
    for (const variant of variants) if (variant) out = out.split(variant).join(placeholder);
  }
  return out
    .replace(/conversation-[0-9a-f]{24}/gu, "<evidence-id>")
    .replace(/job-[0-9a-f]{24}/gu, "<job-id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<iso-instant>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, "<local-date>")
    .replace(/\b[0-9a-f]{24}\b/gu, "<hex24>");
}
function excerpt(value, limit = 300) {
  const text = scrub(typeof value === "string" ? value : JSON.stringify(value ?? null));
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
// /v1/get returns frontmatter as PLAIN text (existing contract, not changed here): values are
// rendered as JSON-quoted strings. Decode the same way so assertions compare typed values.
function plain(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try { const parsed = JSON.parse(raw); return typeof parsed === "string" ? parsed : raw; } catch { return raw; }
}

// ── result accumulation ──────────────────────────────────────────────────────────────
const checks = [];
function record({ id, name, expected, observed, ok, detail = "" }) {
  const entry = {
    id,
    name,
    expected: scrub(expected),
    observed: scrub(typeof observed === "string" ? observed : JSON.stringify(observed ?? null)),
    status: ok ? "PASS" : "FAIL",
    detail: scrub(detail),
  };
  checks.push(entry);
  console.log(`[${entry.status}] ${id} ${name} — expected ${entry.expected} / observed ${entry.observed}`);
  return Boolean(ok);
}

const tripwire = { attempted: 0, attempts: [] };
const tripwireLlm = {
  async chat(messages) {
    tripwire.attempted += 1;
    tripwire.attempts.push(scrub(JSON.stringify(messages ?? null).slice(0, 120)));
    throw new Error("SMOKE_TRIPWIRE: a model call was attempted during a zero-model smoke run");
  },
};

function messagesFor(label) {
  return [
    { role: "user", content: `memory-loop-1 冒烟对话 ${label}：驱动 捕获 → 待办 → 领取 → 提交 这条链路。` },
    { role: "assistant", content: `收到 ${label}：全程零模型调用，结论只能由领取者提交。` },
  ];
}

// ── the run ──────────────────────────────────────────────────────────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-loop-1-smoke-"));
TMP_ROOT = tmp;
const workspaceRoot = path.join(tmp, "workspace");
WORKSPACE_ROOT = workspaceRoot;
const dataRoot = path.join(workspaceRoot, "memory");
DATA_ROOT_REAL = dataRoot;

let server = null;
const invariants = {
  isolatedTempDataRoot: true,
  deploymentDataRootUntouched: true,
  boundHost: "127.0.0.1",
  boundPort: "ephemeral (port: 0; 8787 never used)",
  deployOrRestartPerformed: false,
  newDependenciesAdded: false,
  modelCallsAttempted: 0,
};
const state = {};

try {
  // ── fixtures: clone the template registry, then add three identities ──────────────
  const auth = await createTestAuth(ROOT, tmp);
  const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
  const framework = registry.frameworks.find((item) => item.credential_ref === auth.credentialRef);
  const scopesFor = () => ([
    { layer: "memory", visibility: "shared" },
    { layer: "memory", visibility: "episodic" },
    // Required by the capture write entry whenever a workspace is supplied.
    { layer: "memory", visibility: "project", project: PROJECT },
  ]);
  const addIdentity = ({ agentId, roleId, groupId, userId }) => {
    framework.agents = framework.agents.filter((item) => item.agent_id !== agentId);
    framework.agents.push({
      agent_id: agentId,
      roles: [{ role_id: roleId, group_id: groupId, user_id: userId, scopes: scopesFor(), actions: ["search", "get", "propose"] }],
    });
  };
  addIdentity({ agentId: "smoke-a-01", roleId: "smoke-a", groupId: "group-a", userId: "user-a" });
  addIdentity({ agentId: "smoke-a-02", roleId: "smoke-a2", groupId: "group-a", userId: "user-a" });
  addIdentity({ agentId: "smoke-b-01", roleId: "smoke-b", groupId: "group-b", userId: "user-b" });
  await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const libFactory = createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } });
  server = createLocalhostServer({
    registryPath: auth.registryPath,
    secretStore: auth.secretStore,
    dataRoot,
    workspaceRoot,
    auditPath: path.join(tmp, "audit.jsonl"),
    host: "127.0.0.1",
    port: 0,
    indexScheduleEnabled: false,
    vectorLane: { probe: false },
    calendarTimezone: "UTC",
    // ZERO MODEL CALLS: any chat() reached during this run throws.
    llm: tripwireLlm,
    libFactory,
  });
  const port = (await server.listen()).port;
  // The assigned ephemeral port number is deliberately NOT recorded: it varies per run and the
  // artifact must be byte-identical across runs. What matters is that port 0 was requested.
  if (!Number.isInteger(port) || port <= 0 || port === 8787) throw new Error(`unexpected assigned port ${port}`);

  async function post(url, body, principal) {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal, ...body }),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, body: parsed };
  }
  const relPath = (absolute) => {
    const text = String(absolute ?? "").split("\\").join("/");
    const root = dataRoot.split("\\").join("/");
    return text.startsWith(`${root}/`) ? text.slice(root.length + 1) : text;
  };
  const captureAs = async (principal, conversationId) => {
    const result = await post("/v1/conversations/capture", {
      messages: messagesFor(conversationId),
      conversation_id: conversationId,
      event_id: `${conversationId}-event`,
      source: "memory-loop-1-smoke",
      workspace: WORKSPACE,
    }, principal);
    return result;
  };

  // ═══ fixtures: A captures (the subject of ①–④), B captures (needed by ③b and ⑤) ═══
  const captureA1 = await captureAs(PRINCIPALS.A, "smoke-loop-a1");
  const captureB1 = await captureAs(PRINCIPALS.B, "smoke-loop-b1");
  const evidenceA1 = captureA1.body?.evidenceId;
  const evidenceB1 = captureB1.body?.evidenceId;
  state.capture = {
    a1: { status: captureA1.status, evidenceId: evidenceA1 },
    b1: { status: captureB1.status, evidenceId: evidenceB1 },
  };

  // ═══ ① capture → automatic pending job ═══════════════════════════════════════════
  const listA = await post("/v1/refinement/jobs/list", {}, PRINCIPALS.A);
  record({
    id: "01a-capture-opens-job",
    name: "capture returns evidenceId and opens exactly one pending job",
    expected: "capture 200 + evidenceId; jobs/list 200 with count=1 for the capturing identity",
    observed: { capture: { status: captureA1.status, evidenceId: evidenceA1 }, list: { status: listA.status, count: listA.body?.count } },
    ok: captureA1.status === 200 && /^conversation-[0-9a-f]{24}$/u.test(String(evidenceA1))
      && listA.status === 200 && listA.body?.count === 1,
    detail: `capture excerpt: ${excerpt(captureA1.body)} | list excerpt: ${excerpt(listA.body)}`,
  });

  const jobA1 = listA.body?.jobs?.[0];
  state.jobA1 = jobA1;
  const jobFieldNames = jobA1 && typeof jobA1 === "object" ? Object.keys(jobA1).sort() : [];
  const createdAtMs = Date.parse(String(jobA1?.created_at ?? ""));
  record({
    id: "01b-job-fields-complete",
    name: "the auto-created job carries every required field",
    expected: "job_id shape; evidence_ids=[captured evidence]; state=pending; principal.group_id=group-a; principal.user_id=user-a; created_at parseable; target_layer=project-state; project=<derived>; trigger_reason=conversation_capture",
    observed: {
      job_id: jobA1?.job_id,
      evidence_ids: jobA1?.evidence_ids,
      state_field: jobFieldNames.includes("state") ? "state" : jobFieldNames.includes("status") ? "status" : "<missing>",
      state: jobA1?.state,
      group_id: jobA1?.principal?.group_id,
      user_id: jobA1?.principal?.user_id,
      agent_id: jobA1?.principal?.agent_id,
      role_id: jobA1?.principal?.role_id,
      created_at: jobA1?.created_at,
      deadline: jobA1?.deadline,
      target_layer: jobA1?.target_layer,
      project: jobA1?.project,
      trigger_reason: jobA1?.trigger_reason,
      field_names: jobFieldNames,
    },
    ok: /^job-[0-9a-f]{24}$/u.test(String(jobA1?.job_id))
      && Array.isArray(jobA1?.evidence_ids) && jobA1.evidence_ids.length === 1 && jobA1.evidence_ids[0] === evidenceA1
      && jobA1?.state === "pending"
      && jobA1?.principal?.group_id === "group-a" && jobA1?.principal?.user_id === "user-a"
      && Number.isFinite(createdAtMs)
      && jobA1?.target_layer === "project-state" && jobA1?.project === PROJECT
      && jobA1?.trigger_reason === "conversation_capture",
    detail: "state is exposed as `state` (there is no `status` field on a refinement job)",
  });

  const getA1 = await post("/v1/refinement/jobs/get", { job_id: jobA1?.job_id }, PRINCIPALS.A);
  record({
    id: "01c-job-get-by-id",
    name: "jobs/get returns that very job",
    expected: "200 and the same job_id + same evidence",
    observed: { status: getA1.status, job_id: getA1.body?.job?.job_id, evidence_ids: getA1.body?.job?.evidence_ids, state: getA1.body?.job?.state },
    ok: getA1.status === 200 && getA1.body?.job?.job_id === jobA1?.job_id && getA1.body?.job?.evidence_ids?.[0] === evidenceA1,
    detail: `excerpt: ${excerpt(getA1.body)}`,
  });

  // POSITIVE CONTROL for "B's list does not contain A's job" (01e).
  record({
    id: "01d-positive-control-owner-sees-job",
    name: "POSITIVE CONTROL: the capturing identity's own list really contains the job",
    expected: "A's list contains exactly one job and it is the one whose evidence is A's capture",
    observed: { count: listA.body?.count, total_count: listA.body?.total_count, job_ids: (listA.body?.jobs ?? []).map((item) => item.job_id), evidence_ids: (listA.body?.jobs ?? []).map((item) => item.evidence_ids?.[0]) },
    ok: listA.body?.count === 1 && (listA.body?.jobs ?? []).some((item) => item.job_id === jobA1?.job_id && item.evidence_ids?.[0] === evidenceA1),
    detail: "without this control, 01e could pass simply because listing is broken for everyone",
  });

  const listB = await post("/v1/refinement/jobs/list", {}, PRINCIPALS.B);
  const bJobIds = (listB.body?.jobs ?? []).map((item) => item.job_id);
  state.jobB1 = (listB.body?.jobs ?? [])[0];
  record({
    id: "01e-negative-control-other-group-cannot-see",
    name: "NEGATIVE CONTROL: another group's list does not contain A's job",
    expected: "B's list is its own single job; A's job_id is absent",
    observed: { status: listB.status, count: listB.body?.count, job_ids: bJobIds, contains_a_job: bJobIds.includes(jobA1?.job_id), b_evidence_ids: (listB.body?.jobs ?? []).map((item) => item.evidence_ids?.[0]) },
    ok: listB.status === 200 && listB.body?.count === 1 && !bJobIds.includes(jobA1?.job_id) && (listB.body?.jobs ?? [])[0]?.evidence_ids?.[0] === evidenceB1,
    detail: `B list excerpt: ${excerpt(listB.body)}`,
  });

  // ═══ ② claim / re-claim / non-claimant / cross-group ═════════════════════════════
  const claimA = await post("/v1/refinement/jobs/claim", { job_id: jobA1?.job_id }, PRINCIPALS.A);
  record({
    id: "02a-claim",
    name: "A claims its pending job",
    expected: "200, already_claimed=false, state becomes claimed, claimed_by is A",
    observed: { status: claimA.status, already_claimed: claimA.body?.already_claimed, state: claimA.body?.job?.state, claimed_by: claimA.body?.job?.claimed_by },
    ok: claimA.status === 200 && claimA.body?.already_claimed === false && claimA.body?.job?.state === "claimed"
      && claimA.body?.job?.claimed_by?.group_id === "group-a" && claimA.body?.job?.claimed_by?.agent_id === "smoke-a-01",
    detail: `excerpt: ${excerpt(claimA.body)}`,
  });

  const claimAgainA = await post("/v1/refinement/jobs/claim", { job_id: jobA1?.job_id }, PRINCIPALS.A);
  const claimedAtStable = claimAgainA.body?.job?.claimed_at === claimA.body?.job?.claimed_at;
  record({
    id: "02b-reclaim-same-claimant-is-idempotent",
    name: "the SAME claimant claiming again is idempotent, not a conflict",
    expected: "200 with already_claimed=true and claimed_at unchanged (this is the shipped contract)",
    observed: { status: claimAgainA.status, already_claimed: claimAgainA.body?.already_claimed, claimed_at_unchanged: claimedAtStable, error: claimAgainA.body?.error ?? null },
    ok: claimAgainA.status === 200 && claimAgainA.body?.already_claimed === true && claimedAtStable,
    detail: "DIVERGENCE FROM THE ORDER SHEET, recorded instead of hidden: the sheet expected 409 ALREADY_CLAIMED for 'A claims again'. The shipped contract reserves 409 ALREADY_CLAIMED for a DIFFERENT claimant that can still see the job (see 02c) and treats the same claimant as an idempotent replay. No 409 is produced here.",
  });

  const claimA2 = await post("/v1/refinement/jobs/claim", { job_id: jobA1?.job_id }, PRINCIPALS.A2);
  record({
    id: "02c-claim-by-other-agent-same-group",
    name: "a different identity in the same tenant cannot take a claimed job",
    expected: "409 with error.code=CONFLICT and error.detail=ALREADY_CLAIMED",
    observed: { status: claimA2.status, error: claimA2.body?.error ?? null },
    ok: claimA2.status === 409 && claimA2.body?.error?.code === "CONFLICT" && claimA2.body?.error?.detail === "ALREADY_CLAIMED",
    detail: `excerpt: ${excerpt(claimA2.body)}`,
  });

  const claimB = await post("/v1/refinement/jobs/claim", { job_id: jobA1?.job_id }, PRINCIPALS.B);
  record({
    id: "02d-claim-by-other-group",
    name: "another group cannot claim A's job (indistinguishable from 'no such job')",
    expected: "404 NOT_FOUND (the 409 path is unreachable across tenants by design)",
    observed: { status: claimB.status, error: claimB.body?.error ?? null },
    ok: claimB.status === 404 && claimB.body?.error?.code === "NOT_FOUND",
    detail: `excerpt: ${excerpt(claimB.body)}`,
  });

  const submitBodyFor = (conclusionId, overrides = {}) => ({
    conclusions: [{
      id: conclusionId,
      layer: "project-state",
      project: PROJECT,
      body: "提炼结论：非领取者的提交必须被拒绝。",
      evidence_refs: [evidenceA1],
      ...overrides,
    }],
  });
  const submitA2 = await post("/v1/refinement/jobs/submit", { job_id: jobA1?.job_id, ...submitBodyFor("smoke-nonclaimant-same-group") }, PRINCIPALS.A2);
  record({
    id: "02e-submit-by-non-claimant-same-group",
    name: "a same-tenant non-claimant cannot submit A's claimed job",
    expected: "403 with error.code=NOT_CLAIMANT",
    observed: { status: submitA2.status, error: submitA2.body?.error ?? null },
    ok: submitA2.status === 403 && submitA2.body?.error?.code === "NOT_CLAIMANT",
    detail: `excerpt: ${excerpt(submitA2.body)}`,
  });

  const submitB = await post("/v1/refinement/jobs/submit", { job_id: jobA1?.job_id, ...submitBodyFor("smoke-nonclaimant-other-group") }, PRINCIPALS.B);
  record({
    id: "02f-submit-by-other-group",
    name: "another group cannot submit A's claimed job",
    expected: "404 NOT_FOUND (the job is not visible at all, so NOT_CLAIMANT is never reached)",
    observed: { status: submitB.status, error: submitB.body?.error ?? null },
    ok: submitB.status === 404 && submitB.body?.error?.code === "NOT_FOUND",
    detail: "cross-tenant submit is refused one gate earlier than the claimant check: existence is scoped, so 403 NOT_CLAIMANT would leak that the job exists",
  });

  // the refused attempts must not have changed the claim
  const afterRefusals = await post("/v1/refinement/jobs/get", { job_id: jobA1?.job_id }, PRINCIPALS.A);
  record({
    id: "02g-refusals-left-claim-intact",
    name: "POSITIVE CONTROL: after the four refusals the job is still claimed by A",
    expected: "state=claimed, claimed_by.agent_id=smoke-a-01",
    observed: { status: afterRefusals.status, state: afterRefusals.body?.job?.state, claimed_by: afterRefusals.body?.job?.claimed_by },
    ok: afterRefusals.status === 200 && afterRefusals.body?.job?.state === "claimed" && afterRefusals.body?.job?.claimed_by?.agent_id === "smoke-a-01",
    detail: "this is what makes 03c (the claimant succeeding later on the same job) a real positive control",
  });

  // ═══ ③ submit conclusions ════════════════════════════════════════════════════════
  const missingEvidence = await post("/v1/refinement/jobs/submit", {
    job_id: jobA1?.job_id,
    conclusions: [{ id: "smoke-missing-evidence", layer: "project-state", project: PROJECT, body: "证据不存在的测试结论。", evidence_refs: ["conversation-000000000000000000000000"] }],
  }, PRINCIPALS.A);
  record({
    id: "03a-evidence-not-found",
    name: "an evidence id that does not exist is refused",
    expected: "404 with error.code=EVIDENCE_NOT_FOUND",
    observed: { status: missingEvidence.status, error: missingEvidence.body?.error ?? null },
    ok: missingEvidence.status === 404 && missingEvidence.body?.error?.code === "EVIDENCE_NOT_FOUND",
    detail: `excerpt: ${excerpt(missingEvidence.body)}`,
  });

  const foreignEvidence = await post("/v1/refinement/jobs/submit", {
    job_id: jobA1?.job_id,
    conclusions: [{ id: "smoke-foreign-evidence", layer: "project-state", project: PROJECT, body: "证据属于别人组的测试结论。", evidence_refs: [evidenceB1] }],
  }, PRINCIPALS.A);
  const sameErrorBody = JSON.stringify(foreignEvidence.body?.error) === JSON.stringify(missingEvidence.body?.error);
  record({
    id: "03b-foreign-evidence-indistinguishable",
    name: "an existing evidence id owned by group B gives the SAME refusal shape as a missing one",
    expected: "404 EVIDENCE_NOT_FOUND and byte-identical error object to 03a (evidence ids must not become a probe)",
    observed: {
      status: foreignEvidence.status,
      error: foreignEvidence.body?.error ?? null,
      missing_error: missingEvidence.body?.error ?? null,
      identical: sameErrorBody,
      existing_but_foreign_evidence_id: evidenceB1,
    },
    ok: foreignEvidence.status === 404 && foreignEvidence.body?.error?.code === "EVIDENCE_NOT_FOUND" && sameErrorBody,
    detail: "the foreign evidence really exists (captured by B in this same run) — it is refused for ownership, and the caller cannot tell that from 'never existed'",
  });

  const properSubmit = await post("/v1/refinement/jobs/submit", {
    job_id: jobA1?.job_id,
    conclusions: [{
      id: "smoke-conclusion-a1",
      layer: "project-state",
      project: PROJECT,
      body: "提炼结论：领取者提交结论后待办才算完成，回执里的每个 id 都必须能立刻读回。",
      evidence_refs: [evidenceA1],
      tags: ["memory-loop-1-smoke"],
    }],
  }, PRINCIPALS.A);
  const writes = properSubmit.body?.receipt?.writes ?? [];
  const readBacks = [];
  for (const write of writes) {
    readBacks.push({ id: write.id, ...(await post("/v1/get", { id: write.id }, PRINCIPALS.A)) });
  }
  const allReadable = readBacks.length > 0 && readBacks.every((item) => item.status === 200);
  record({
    id: "03c-submit-accepted-and-receipt-readable",
    name: "POSITIVE CONTROL: the claimant submits its own evidence and every receipt id reads back",
    expected: "200 with receipt+writes; every writes[].id readable by POST /v1/get (200); job state becomes completed",
    observed: {
      status: properSubmit.status,
      job_state: properSubmit.body?.job?.state,
      receipt_outcome: properSubmit.body?.receipt?.outcome,
      writes: writes.map((write) => ({ id: write.id, layer: write.layer, path: relPath(write.path), created: write.created ?? null, updated: write.updated ?? null })),
      readbacks: readBacks.map((item) => ({ id: item.id, status: item.status, item_id: item.body?.item?.id ?? null, item_path: item.body?.item?.path ? relPath(item.body.item.path) : null })),
    },
    ok: properSubmit.status === 200
      && properSubmit.body?.job?.state === "completed"
      && properSubmit.body?.receipt?.outcome === "written"
      && writes.length === 1 && writes[0]?.id === "smoke-conclusion-a1"
      && relPath(writes[0]?.path) === `project-state/${PROJECT}/current-state.md`
      && allReadable,
    detail: `receipt excerpt: ${excerpt(properSubmit.body?.receipt)} | state value recorded exactly: ${properSubmit.body?.job?.state ?? "<none>"}`,
  });

  // ═══ ④ stable_key conflict and supersede ════════════════════════════════════════
  // TWO jobs, not one — and that is a contract fact, not a convenience:
  //   a job becomes `completed` on its first accepted submission, and a completed job refuses any
  //   *different* payload with 409 CONFLICT ("already completed with a different submission").
  //   So the conflict → supersede retry has to happen on a job that has not been completed yet
  //   (the same-job retry path is `needs_review`, which is what a SUPERSEDE_REQUIRED rejection
  //   leaves behind). Job A2 writes version 1; job A3 raises the conflict and then resolves it.
  const captureA2 = await captureAs(PRINCIPALS.A, "smoke-loop-a2");
  const evidenceA2 = captureA2.body?.evidenceId;
  const listA2 = await post("/v1/refinement/jobs/list", {}, PRINCIPALS.A);
  const jobA2 = (listA2.body?.jobs ?? []).find((item) => item.conversation_id === "smoke-loop-a2");
  const claimA2Job = await post("/v1/refinement/jobs/claim", { job_id: jobA2?.job_id }, PRINCIPALS.A);
  state.jobA2 = jobA2;

  const captureA3 = await captureAs(PRINCIPALS.A, "smoke-loop-a3");
  const evidenceA3 = captureA3.body?.evidenceId;
  const listA3 = await post("/v1/refinement/jobs/list", {}, PRINCIPALS.A);
  const jobA3 = (listA3.body?.jobs ?? []).find((item) => item.conversation_id === "smoke-loop-a3");
  const claimA3Job = await post("/v1/refinement/jobs/claim", { job_id: jobA3?.job_id }, PRINCIPALS.A);
  state.jobA3 = jobA3;

  const kvConclusion = (id, body, evidenceId, overrides = {}) => ({
    id,
    layer: "curated-shared",
    body,
    evidence_refs: [evidenceId],
    stable_key: STABLE_KEY,
    ...overrides,
  });

  const kvFirst = await post("/v1/refinement/jobs/submit", { job_id: jobA2?.job_id, conclusions: [kvConclusion("smoke-kv-1", BODY_OLD, evidenceA2)] }, PRINCIPALS.A);
  const id1 = "smoke-kv-1";
  record({
    id: "04a-first-stable-key-write",
    name: "a stable_key conclusion is written the first time",
    expected: "200, receipt.outcome=written, writes[0].id=smoke-kv-1 at curated/shared/smoke-kv-1.md",
    observed: {
      status: kvFirst.status,
      job_state: kvFirst.body?.job?.state,
      outcome: kvFirst.body?.receipt?.outcome,
      writes: (kvFirst.body?.receipt?.writes ?? []).map((write) => ({ id: write.id, path: relPath(write.path), created: write.created ?? null })),
      id1,
    },
    ok: captureA2.status === 200 && claimA2Job.status === 200
      && kvFirst.status === 200 && kvFirst.body?.receipt?.outcome === "written"
      && (kvFirst.body?.receipt?.writes ?? []).length === 1
      && kvFirst.body.receipt.writes[0].id === id1
      && relPath(kvFirst.body.receipt.writes[0].path) === `curated/shared/${id1}.md`,
    detail: `capture evidence: ${evidenceA2} | submit excerpt: ${excerpt(kvFirst.body)}`,
  });

  const kvConflict = await post("/v1/refinement/jobs/submit", { job_id: jobA3?.job_id, conclusions: [kvConclusion("smoke-kv-2", BODY_NEW, evidenceA3)] }, PRINCIPALS.A);
  const conflictEntry = kvConflict.body?.error?.conflicts?.[0] ?? null;
  const afterConflictJob = await post("/v1/refinement/jobs/get", { job_id: jobA3?.job_id }, PRINCIPALS.A);
  record({
    id: "04b-conflict-requires-supersede",
    name: "same stable_key + different body without supersedes is a structured conflict",
    expected: `409, error.code=SUPERSEDE_REQUIRED, error.conflicts[0].active_id=${id1}, conflicts[0].stable_key=${STABLE_KEY}, and the job left retryable (needs_review)`,
    observed: { status: kvConflict.status, error: kvConflict.body?.error ?? null, conflicts: kvConflict.body?.error?.conflicts ?? null, job_state_after: afterConflictJob.body?.job?.state ?? null, needs_review_reason: afterConflictJob.body?.job?.needs_review_reason ?? null },
    ok: kvConflict.status === 409 && kvConflict.body?.error?.code === "SUPERSEDE_REQUIRED"
      && conflictEntry?.active_id === id1 && conflictEntry?.stable_key === STABLE_KEY
      && afterConflictJob.body?.job?.state === "needs_review",
    detail: `excerpt: ${excerpt(kvConflict.body)}`,
  });

  const kvSupersede = await post("/v1/refinement/jobs/submit", { job_id: jobA3?.job_id, conclusions: [kvConclusion("smoke-kv-2", BODY_NEW, evidenceA3, { supersedes: [id1] })] }, PRINCIPALS.A);
  const id2 = "smoke-kv-2";
  const superWrite = (kvSupersede.body?.receipt?.writes ?? [])[0] ?? null;
  record({
    id: "04c-supersede-accepted",
    name: "naming the active id makes the replacement legitimate",
    expected: "200, writes[0].id=smoke-kv-2 (≠ id1), action=superseded, old_id=smoke-kv-1, job completed",
    observed: { status: kvSupersede.status, job_state: kvSupersede.body?.job?.state, outcome: kvSupersede.body?.receipt?.outcome, write: superWrite ? { id: superWrite.id, action: superWrite.action ?? null, old_id: superWrite.old_id ?? null, path: relPath(superWrite.path) } : null, id2 },
    ok: captureA3.status === 200 && claimA3Job.status === 200
      && kvSupersede.status === 200 && superWrite?.id === id2 && superWrite.id !== id1
      && superWrite?.old_id === id1 && kvSupersede.body?.job?.state === "completed",
    detail: `excerpt: ${excerpt(kvSupersede.body?.receipt)}`,
  });

  const getOld = await post("/v1/get", { id: id1 }, PRINCIPALS.A);
  record({
    id: "04d-old-version-still-readable",
    name: "the superseded version stays on disk and stays readable",
    expected: `POST /v1/get {id:${id1}} → 200, frontmatter.status=superseded, superseded_by=${id2}`,
    observed: {
      status: getOld.status,
      item_id: getOld.body?.item?.id ?? null,
      path: getOld.body?.item?.path ? relPath(getOld.body.item.path) : null,
      status_value: getOld.body?.item?.frontmatter ? plain(getOld.body.item.frontmatter.status) : null,
      superseded_by: getOld.body?.item?.frontmatter ? plain(getOld.body.item.frontmatter.superseded_by) : null,
      stable_key: getOld.body?.item?.frontmatter ? plain(getOld.body.item.frontmatter.stable_key) : null,
    },
    ok: getOld.status === 200 && plain(getOld.body?.item?.frontmatter?.status) === "superseded"
      && plain(getOld.body?.item?.frontmatter?.superseded_by) === id2
      && relPath(getOld.body?.item?.path) === `curated/shared/${id1}.md`,
    detail: `excerpt: ${excerpt(getOld.body?.item?.frontmatter)}`,
  });

  const getNew = await post("/v1/get", { id: id2 }, PRINCIPALS.A);
  record({
    id: "04e-new-version-readable",
    name: "the new version is readable and active",
    expected: `POST /v1/get {id:${id2}} → 200, frontmatter.status=active, supersedes=[${id1}]`,
    observed: {
      status: getNew.status,
      item_id: getNew.body?.item?.id ?? null,
      path: getNew.body?.item?.path ? relPath(getNew.body.item.path) : null,
      status_value: getNew.body?.item?.frontmatter ? plain(getNew.body.item.frontmatter.status) : null,
      supersedes: getNew.body?.item?.frontmatter ? plain(getNew.body.item.frontmatter.supersedes) : null,
    },
    ok: getNew.status === 200 && plain(getNew.body?.item?.frontmatter?.status) === "active"
      && relPath(getNew.body?.item?.path) === `curated/shared/${id2}.md`,
    detail: `excerpt: ${excerpt(getNew.body?.item?.frontmatter)}`,
  });

  const searchDefault = await post("/v1/search", { query: MARKER, searchMode: "memories", limit: 20 }, PRINCIPALS.A);
  const defaultPaths = (searchDefault.body?.results ?? []).map((item) => relPath(item.path));
  record({
    id: "04f-search-returns-only-current-version",
    name: "DISCRIMINATING: default search returns the current version and hides the superseded one",
    expected: `results contain curated/shared/${id2}.md and NOT curated/shared/${id1}.md, for a query present in BOTH bodies`,
    observed: { status: searchDefault.status, query: MARKER, paths: defaultPaths, contains_new: defaultPaths.includes(`curated/shared/${id2}.md`), contains_old: defaultPaths.includes(`curated/shared/${id1}.md`) },
    ok: searchDefault.status === 200 && defaultPaths.includes(`curated/shared/${id2}.md`) && !defaultPaths.includes(`curated/shared/${id1}.md`),
    detail: "the marker appears in both bodies, so the absence of the old path can only come from supersede filtering",
  });

  const searchWithSuperseded = await post("/v1/search", { query: MARKER, searchMode: "memories", limit: 20, include_superseded: true }, PRINCIPALS.A);
  const superPaths = (searchWithSuperseded.body?.results ?? []).map((item) => relPath(item.path));
  record({
    id: "04g-search-include-superseded-shows-both",
    name: "include_superseded:true reveals both versions (the switch is honoured, not ignored)",
    expected: `results contain BOTH curated/shared/${id1}.md and curated/shared/${id2}.md`,
    observed: { status: searchWithSuperseded.status, paths: superPaths, contains_new: superPaths.includes(`curated/shared/${id2}.md`), contains_old: superPaths.includes(`curated/shared/${id1}.md`) },
    ok: searchWithSuperseded.status === 200 && superPaths.includes(`curated/shared/${id1}.md`) && superPaths.includes(`curated/shared/${id2}.md`),
    detail: "observed: the flag is supported and effective",
  });

  // ═══ ⑤ metrics ══════════════════════════════════════════════════════════════════
  // The day is taken from the instant the server itself stamped on the first job (an independent
  // truth source that needs no clock re-implementation). Both captures happen inside one run, so
  // they share that UTC day.
  const DAY = new Date(createdAtMs).toISOString().slice(0, 10);
  const metricsA = await post("/v1/refinement/jobs/metrics", { day: DAY, timezone: "UTC" }, PRINCIPALS.A);
  const metricsB = await post("/v1/refinement/jobs/metrics", { day: DAY, timezone: "UTC" }, PRINCIPALS.B);
  state.metrics = { DAY, a: metricsA.body, b: metricsB.body };
  const expectCountsA = {
    captured_conversations: 3,
    captured_evidence_records: 3,
    conversations_with_jobs: 3,
    uncovered_conversations: 0,
    jobs_in_day: 3,
    completed_jobs: 3,
    completed_conversations: 3,
    written_jobs: 2,
    written_conversations: 2,
    no_durable_fact_jobs: 0,
    no_durable_fact_conversations: 0,
    open_jobs: 0,
    overdue_open_jobs: 0,
    overdue_open_conversations: 0,
    needs_review_jobs: 0,
    failed_jobs: 0,
    unclaimed_jobs: 0,
    unclaimed_conversations: 0,
    unclaimed_jobs_day: 0,
    overdue_open_jobs_all_days: 0,
    max_jobs_per_conversation: 1,
    conversations_with_multiple_jobs: 0,
  };
  const metricFieldNames = metricsA.body && typeof metricsA.body === "object" ? Object.keys(metricsA.body).sort() : [];
  const countFieldNames = metricsA.body?.counts && typeof metricsA.body.counts === "object" ? Object.keys(metricsA.body.counts).sort() : [];
  const rateKeys = metricsA.body?.rates && typeof metricsA.body.rates === "object" ? Object.keys(metricsA.body.rates).sort() : [];
  record({
    id: "05a-metrics-a",
    name: "A's metrics answer 200 with the six answers, explicit denominators and a markdown report",
    expected: `200, ok=true, scope=group-a/user-a, counts == hand-computed fixture table ${JSON.stringify(expectCountsA)}, rates present, report non-empty markdown`,
    observed: {
      status: metricsA.status,
      ok: metricsA.body?.ok,
      day: metricsA.body?.day,
      timezone: metricsA.body?.timezone,
      scope: metricsA.body?.scope ?? null,
      top_level_fields: metricFieldNames,
      rate_fields: rateKeys,
      counts: metricsA.body?.counts ?? null,
      rates: metricsA.body?.rates ?? null,
      report_lines: typeof metricsA.body?.report === "string" ? metricsA.body.report.trim().split("\n").length : 0,
      report_head: typeof metricsA.body?.report === "string" ? metricsA.body.report.split("\n")[0] : null,
    },
    ok: metricsA.status === 200 && metricsA.body?.ok === true
      && metricsA.body?.scope?.group_id === "group-a" && metricsA.body?.scope?.user_id === "user-a"
      && JSON.stringify(metricsA.body?.counts) === JSON.stringify(expectCountsA)
      && rateKeys.join(",") === "completion,job_coverage,no_durable_fact,overdue_open"
      && typeof metricsA.body?.report === "string" && metricsA.body.report.includes("| 指标 | 数值 | 分母 |"),
    detail: `count field names: ${countFieldNames.join(",")} | report excerpt: ${excerpt(metricsA.body?.report ?? "")}`,
  });

  const expectCountsB = {
    captured_conversations: 1,
    captured_evidence_records: 1,
    conversations_with_jobs: 1,
    uncovered_conversations: 0,
    jobs_in_day: 1,
    completed_jobs: 0,
    completed_conversations: 0,
    written_jobs: 0,
    written_conversations: 0,
    no_durable_fact_jobs: 0,
    no_durable_fact_conversations: 0,
    open_jobs: 1,
    overdue_open_jobs: 0,
    overdue_open_conversations: 0,
    needs_review_jobs: 0,
    failed_jobs: 0,
    unclaimed_jobs: 1,
    unclaimed_conversations: 1,
    unclaimed_jobs_day: 1,
    overdue_open_jobs_all_days: 0,
    max_jobs_per_conversation: 1,
    conversations_with_multiple_jobs: 0,
  };
  const reportA = String(metricsA.body?.report ?? "");
  const reportB = String(metricsB.body?.report ?? "");
  const A_CONVERSATIONS = ["smoke-loop-a1", "smoke-loop-a2", "smoke-loop-a3"];
  const bMentionsA = A_CONVERSATIONS.filter((id) => reportB.includes(id));
  const aMentionsA = A_CONVERSATIONS.filter((id) => reportA.includes(id));
  record({
    id: "05b-metrics-b",
    name: "B's metrics answer 200 with only B's own numbers",
    expected: `200, scope=group-b/user-b, counts == ${JSON.stringify(expectCountsB)}`,
    observed: { status: metricsB.status, scope: metricsB.body?.scope ?? null, counts: metricsB.body?.counts ?? null, rates: metricsB.body?.rates ?? null },
    ok: metricsB.status === 200 && metricsB.body?.ok === true
      && metricsB.body?.scope?.group_id === "group-b" && metricsB.body?.scope?.user_id === "user-b"
      && JSON.stringify(metricsB.body?.counts) === JSON.stringify(expectCountsB),
    detail: `report excerpt: ${excerpt(reportB)}`,
  });

  record({
    id: "05c-cross-group-isolation",
    name: "cross-group isolation: A's activity never appears in B's report, and vice versa",
    expected: "A's report names all three of A's conversations; B's report names none of them and only B's own",
    observed: {
      a_side_by_side: {
        captured_conversations: metricsA.body?.counts?.captured_conversations ?? null,
        jobs_in_day: metricsA.body?.counts?.jobs_in_day ?? null,
        completed_jobs: metricsA.body?.counts?.completed_jobs ?? null,
        unclaimed_jobs: metricsA.body?.counts?.unclaimed_jobs ?? null,
        scope: metricsA.body?.scope ?? null,
      },
      b_side_by_side: {
        captured_conversations: metricsB.body?.counts?.captured_conversations ?? null,
        jobs_in_day: metricsB.body?.counts?.jobs_in_day ?? null,
        completed_jobs: metricsB.body?.counts?.completed_jobs ?? null,
        unclaimed_jobs: metricsB.body?.counts?.unclaimed_jobs ?? null,
        scope: metricsB.body?.scope ?? null,
      },
      a_report_names_a_conversations: aMentionsA,
      b_report_names_a_conversations: bMentionsA,
    },
    ok: aMentionsA.length === 3 && bMentionsA.length === 0
      && metricsB.body?.counts?.jobs_in_day === 1 && metricsA.body?.counts?.jobs_in_day === 3,
    detail: `B report excerpt: ${excerpt(reportB, 200)}`,
  });

  record({
    id: "05d-positive-control-nonzero",
    name: "POSITIVE CONTROL: A shows a non-zero count that B shows as zero",
    expected: "A.completed_jobs=3 while B.completed_jobs=0 (the metric is live, not universally 0)",
    observed: { a_completed_jobs: metricsA.body?.counts?.completed_jobs ?? null, b_completed_jobs: metricsB.body?.counts?.completed_jobs ?? null, a_completion_rate: metricsA.body?.rates?.completion ?? null, b_completion_rate: metricsB.body?.rates?.completion ?? null },
    ok: (metricsA.body?.counts?.completed_jobs ?? 0) > 0 && (metricsB.body?.counts?.completed_jobs ?? -1) === 0,
    detail: "without this, a metrics endpoint that always returns zeros would pass 05b",
  });

  // ═══ ⑥ the read-only endpoints do not touch the tree ═════════════════════════════
  // Runs AFTER the writes of ①–④, so the tree is non-empty and the comparison means something.
  const beforeSnapshot = await snapshotTree(dataRoot);
  const readonlyMetrics = await post("/v1/refinement/jobs/metrics", { day: DAY, timezone: "UTC" }, PRINCIPALS.A);
  const readonlyList = await post("/v1/refinement/jobs/list", {}, PRINCIPALS.A);
  const afterSnapshot = await snapshotTree(dataRoot);
  // STRICT verdict: diffSnapshots compares path + size + mtimeMs + sha256 of every file. That, not
  // the digest below, is what decides PASS/FAIL — nothing is relaxed.
  const changes = diffSnapshots(beforeSnapshot, afterSnapshot);
  // The recorded digest is taken over the sorted relative path list only. Reason: the tree's
  // *contents* embed capture instants and the mtimes are wall-clock, so a content digest would
  // differ between two runs and the artifact could not be byte-identical. A path digest is stable
  // across runs AND must still match between the two snapshots of one run.
  const digestOf = (snapshot) => crypto.createHash("sha256").update(JSON.stringify(snapshot.map((item) => item.path))).digest("hex");
  const digestBefore = digestOf(beforeSnapshot);
  const digestAfter = digestOf(afterSnapshot);
  record({
    id: "06a-readonly-endpoints-leave-tree-identical",
    name: "metrics + list change nothing under dataRoot",
    expected: "strictly identical recursive snapshot (path + size + mtime + sha256 of every file) before and after the two read-only calls",
    observed: {
      file_count: beforeSnapshot.length,
      files_added: afterSnapshot.length - beforeSnapshot.length,
      digest_basis: "sha256 over the sorted relative path list",
      digest_before: digestBefore,
      digest_after: digestAfter,
      strict_changed_entries: changes.length,
      identical: changes.length === 0 && digestBefore === digestAfter,
      statuses: { metrics: readonlyMetrics.status, list: readonlyList.status },
    },
    ok: beforeSnapshot.length > 0 && changes.length === 0 && digestBefore === digestAfter
      && readonlyMetrics.status === 200 && readonlyList.status === 200,
    detail: `the tree is non-empty by construction (①–④ wrote evidence, jobs and memories): ${beforeSnapshot.length} files | first changed entry: ${changes.length ? scrub(JSON.stringify(changes[0]).slice(0, 200)) : "<none>"}`,
  });

  invariants.dataRootFileCount = beforeSnapshot.length;
  invariants.dataRootPathDigest = digestBefore;
} catch (error) {
  record({
    id: "00-run-completed",
    name: "the smoke run reached the end without an unexpected exception",
    expected: "no exception",
    observed: { error: String(error?.message ?? error), stack: String(error?.stack ?? "").split("\n").slice(0, 3).join(" | ") },
    ok: false,
    detail: "an exception here means the run is not evidence of anything — fix the cause and re-run",
  });
} finally {
  if (server) await server.close().catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

// ── tripwire verdict: zero model calls is an assertion, not a hope ──────────────────
record({
  id: "zz-tripwire-zero-model-calls",
  name: "no model call was attempted anywhere in the run",
  expected: "tripwire.chat() never invoked (modelCallsAttempted = 0)",
  observed: { modelCallsAttempted: tripwire.attempted, attempts: tripwire.attempts },
  ok: tripwire.attempted === 0,
  detail: "the injected llm throws on chat(); reaching it would have surfaced as a 5xx or an exception above",
});
invariants.modelCallsAttempted = tripwire.attempted;

const passed = checks.filter((item) => item.status === "PASS").length;
const failed = checks.length - passed;
const artifact = {
  generated_by: "memory-lib/scripts/smoke-memory-loop.mjs",
  checks,
  counts: { pass: passed, fail: failed },
  invariants,
  tripwire: { modelCallsAttempted: tripwire.attempted },
};
await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
await fs.writeFile(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(`\n${failed === 0 ? "SMOKE_MEMORY_LOOP_PASS" : "SMOKE_MEMORY_LOOP_FAIL"} pass=${passed} fail=${failed} → ${OUT_PATH}`);
if (failed > 0) process.exitCode = 1;
