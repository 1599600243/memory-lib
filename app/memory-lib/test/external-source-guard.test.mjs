import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRefinementJobs } from "../src/refinement-jobs.mjs";
import { externalAgentVisibilityDenial, externalSourcesOf, externalVisibilityDenial, isExternalAgent, isExternalSource } from "../src/external-source-guard.mjs";

const PRINCIPAL = { tenant_id: "default", framework_id: "test", group_id: "g1", user_id: "u1", agent_id: "a1", role_id: "r1" };

test("external source names are recognized case-insensitively", () => {
  for (const source of ["napcat-group", "napcat:c2c:1", "qq-group", "QQ-GROUP"]) assert.equal(isExternalSource(source), true);
  for (const source of ["dsh-session", "capture-proxy", "", null]) assert.equal(isExternalSource(source), false);
});

test("external evidence with shared visibility is denied with source detail", () => {
  const denial = externalVisibilityDenial({ evidenceRefs: ["napcat:group:1000000#1843280159"], visibility: "shared" });
  assert.equal(denial.code, "EXTERNAL_SOURCE_VISIBILITY_DENIED");
  assert.deepEqual(denial.sources, ["napcat:group"]);
});

test("external evidence with platform visibility is denied", () => {
  assert.equal(externalVisibilityDenial({ evidenceRefs: ["qq-group:abc"], visibility: "platform" }).code, "EXTERNAL_SOURCE_VISIBILITY_DENIED");
});

test("user, agent, and private visibility are not restricted", () => {
  for (const visibility of ["user", "agent", "private"]) assert.equal(externalVisibilityDenial({ evidenceRefs: ["napcat-group:abc"], visibility }), null);
});

test("internal dsh-session evidence remains allowed at shared visibility", () => {
  assert.equal(externalVisibilityDenial({ evidenceRefs: ["dsh-session:abc"], visibility: "shared" }), null);
});

test("mixed internal and external evidence is denied", () => {
  const denial = externalVisibilityDenial({ evidenceRefs: ["dsh-session:abc", "napcat:group:123"], visibility: "shared" });
  assert.deepEqual(denial.sources, ["napcat:group"]);
});

test("unparseable references are ignored", () => {
  assert.equal(externalVisibilityDenial({ evidenceRefs: ["weird-ref", "", 42], visibility: "shared" }), null);
});

test("empty and missing evidence references do not trigger denial", () => {
  assert.equal(externalVisibilityDenial({ evidenceRefs: [], visibility: "shared" }), null);
  assert.equal(externalVisibilityDenial({ visibility: "shared" }), null);
});

test("external sources are deduplicated and malformed refs ignored", () => {
  assert.deepEqual([...externalSourcesOf(["napcat:group:1", "NAPCAT:group:2", "qq-chat:3", null, "plain"])], ["napcat:group", "qq-chat"]);
});

test("refinement submission rejects external evidence before any write", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-external-guard-"));
  try {
    const jobs = createRefinementJobs({ dataRoot });
    const evidenceId = "napcat:group:1000000#1843280159";
    const job = await jobs.recordCapture({ evidenceId, conversationId: "c1", principal: PRINCIPAL });
    await jobs.claim({ job_id: job.job_id, principal: PRINCIPAL });
    let writes = 0;
    await assert.rejects(jobs.submit({
      job_id: job.job_id,
      principal: PRINCIPAL,
      body: { conclusions: [{ layer: "document", body: "external fact", evidence_refs: [evidenceId] }] },
      assertion: () => {},
      verifyEvidence: async () => ({
        id: evidenceId,
        path: path.join(dataRoot, "evidence", "conversations", "evidence.md"),
        frontmatter: { type: "conversation", groupId: JSON.stringify("g1"), userId: JSON.stringify("u1") },
      }),
      writeMemory: async () => { writes += 1; return { layer: "document", path: "unused" }; },
    }), (error) => error.code === "EXTERNAL_SOURCE_VISIBILITY_DENIED");
    assert.equal(writes, 0);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

test("external channel agents may only write their own layers", async () => {
  const { isExternalAgent, externalAgentVisibilityDenial } = await import("../src/external-source-guard.mjs");
  assert.equal(isExternalAgent("qq-bot"), true);
  assert.equal(isExternalAgent("napcat-bridge"), true);
  assert.equal(isExternalAgent("admin-01"), false);
  // 自己的层：放行
  for (const visibility of ["user", "private", "agent", "role"]) {
    assert.equal(externalAgentVisibilityDenial({ agentId: "qq-bot", visibility }), null, visibility);
  }
  // 会放大到组/全员：拒绝
  for (const visibility of ["shared", "platform"]) {
    const denial = externalAgentVisibilityDenial({ agentId: "qq-bot", visibility });
    assert.equal(denial?.code, "EXTERNAL_AGENT_VISIBILITY_DENIED", visibility);
  }
  // 非外部 agent 不受影响
  assert.equal(externalAgentVisibilityDenial({ agentId: "admin-01", visibility: "shared" }), null);
});

test("missingEvidenceRefs distinguishes real evidence from synthetic ids", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { missingEvidenceRefs } = await import("../src/evidence-ref-check.mjs");
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ev-check-"));
  await fs.mkdir(path.join(dataRoot, "evidence", "conversations"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "evidence", "conversations", "conversation-abcdef1234567890.md"), "---\nid: x\n---\n");
  assert.deepEqual(await missingEvidenceRefs({ dataRoot, refs: ["conversation-abcdef1234567890"] }), []);
  assert.deepEqual(await missingEvidenceRefs({ dataRoot, refs: ["being:self-time:2026-10-31T16:55:01.234Z"] }), ["being:self-time:2026-10-31T16:55:01.234Z"]);
});
