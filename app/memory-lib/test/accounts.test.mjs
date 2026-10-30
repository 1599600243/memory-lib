import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAccount, accountPrincipal } from "../src/identity-registry.mjs";

test("account resolution uses an explicit normalized username mapping", () => {
  const registry = {
    version: 1,
    accounts: [{ username: "Admin@Example", framework_id: "fw", agent_id: "agent-1", role_id: "reader", status: "active" }],
    frameworks: [],
  };
  const account = resolveAccount(registry, " admin@example ");
  assert.equal(account.username, "admin@example");
  assert.deepEqual(accountPrincipal(account), { framework_id: "fw", agent_id: "agent-1", role_id: "reader" });
});

test("account resolution never falls back to a framework array position", () => {
  const registry = { version: 1, accounts: [], frameworks: [{ framework_id: "fw", agents: [{ agent_id: "a", roles: [{ role_id: "reader" }] }] }] };
  assert.equal(resolveAccount(registry, "fw"), null);
});

test("suspended and malformed accounts are returned for policy decisions, not silently activated", () => {
  const registry = {
    version: 1,
    accounts: [
      { username: "suspended@example", framework_id: "fw", agent_id: "a", role_id: "reader", status: "suspended" },
      { username: "broken@example", framework_id: "fw", agent_id: "a", status: "active" },
    ],
    frameworks: [],
  };
  assert.equal(resolveAccount(registry, "suspended@example").status, "suspended");
  assert.equal(accountPrincipal(resolveAccount(registry, "broken@example")), null);
});
