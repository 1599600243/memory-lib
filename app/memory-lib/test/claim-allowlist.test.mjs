import assert from "node:assert/strict";
import test from "node:test";
import { claimAllowed, resolveClaimedPrincipal } from "../src/identity-registry.mjs";

const framework = (claim_allowlist, credentialStatus = "active") => ({
  framework_id: "fixture",
  credential: { status: credentialStatus },
  ...(claim_allowlist === undefined ? {} : { claim_allowlist }),
  agents: [
    { agent_id: "admin-01", roles: [{ role_id: "librarian-admin" }] },
    { agent_id: "pilot-01", roles: [{ role_id: "reader" }] },
    { agent_id: "qq-abc123", roles: [{ role_id: "chat-reader" }, { role_id: "chat-writer" }] },
    { agent_id: "home-circle", roles: [{ role_id: "home-owner-agent" }] },
    { agent_id: "other", roles: [{ role_id: "chat-reader" }, { role_id: "chat-writer" }] },
  ],
});
const resolve = (f, agent_id, role_id) => resolveClaimedPrincipal(f, { agent_id, role_id });
const allowed = (f, agent_id, role_id) => assert.equal(resolve(f, agent_id, role_id).ok, true);
const denied = (f, agent_id, role_id, reason = "CLAIM_NOT_ALLOWED") =>
  assert.deepEqual(resolve(f, agent_id, role_id), { ok: false, reason });

test("missing allowlist preserves legacy behavior", () => {
  allowed(framework(), "admin-01", "librarian-admin");
  allowed(framework(), "pilot-01", "reader");
  allowed(framework([]), "pilot-01", "reader");
  allowed(framework("not-an-array"), "pilot-01", "reader");
});

test("exact agent/role rule allows only that claim", () => {
  const f = framework(["admin-01/librarian-admin"]);
  allowed(f, "admin-01", "librarian-admin");
  denied(f, "pilot-01", "reader");
});

test("agent glob patterns match the requested qq-* rules", () => {
  const f = framework(["qq-*/chat-reader", "qq-*/chat-writer"]);
  allowed(f, "qq-abc123", "chat-reader");
  denied(f, "home-circle", "home-owner-agent");
});

test("wildcard agent segment allows one role across agents", () => {
  const f = framework(["*/chat-reader"]);
  allowed(f, "qq-abc123", "chat-reader");
  allowed(f, "other", "chat-reader");
  denied(f, "other", "chat-writer");
});

test("malformed rules are ignored and do not authorize claims", () => {
  const f = framework(["a/b/c", "", "/"]);
  denied(f, "admin-01", "librarian-admin");
});

test("revocation takes precedence over a matching allowlist", () => {
  denied(framework(["admin-01/librarian-admin"], "revoked"), "admin-01", "librarian-admin", "REVOKED");
});

test("unknown agent and role retain their existing reasons", () => {
  const f = framework(["*"]);
  denied(f, "missing-agent", "reader", "UNKNOWN_AGENT");
  denied(f, "pilot-01", "missing-role", "UNKNOWN_ROLE");
});

test("coverage helper: the production allowlist covers every registered pair", () => {
  const allowlist = ["admin-01/librarian-admin", "pilot-01/*", "home-circle/*", "work-circle/*", "qq-*/chat-*"];
  const pairs = [
    ["admin-01", "librarian-admin"],
    ["pilot-01", "reader"], ["pilot-01", "researcher"], ["pilot-01", "steward"], ["pilot-01", "capture-ingest"],
    ["home-circle", "home-owner-agent"], ["work-circle", "ops-agent"],
    ["qq-bot", "chat-reader"], ["qq-bot", "chat-writer"],
    ["qq-brand-new-guest", "chat-reader"], ["qq-brand-new-guest", "chat-writer"],
  ];
  for (const [agent, role] of pairs) assert.equal(claimAllowed(allowlist, agent, role), true, `should allow ${agent}/${role}`);
  assert.equal(claimAllowed(allowlist, "ghost-01", "reader"), false);
  assert.equal(claimAllowed(allowlist, "qq-bot", "steward"), false);
});
