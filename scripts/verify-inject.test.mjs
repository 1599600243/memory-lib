import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "verify-inject.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: path.resolve(here, ".."), encoding: "utf8", timeout: 30_000 });
}

test("verify-inject --dry is read-only and reports I3/I6 evidence", () => {
  const before = fs.existsSync(cli) ? fs.statSync(cli).mtimeMs : null;
  const result = run(["--dry", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "dry");
  assert.equal(payload.writes, 0);
  assert.equal(payload.overall, "PASS");
  assert.deepEqual(payload.checks.map((check) => check.id), ["I3", "I6"]);
  assert.equal(payload.checks[0].observed.runs, 20);
  assert.equal(typeof payload.checks[0].observed.maxChars, "number");
  assert.equal(typeof payload.checks[0].observed.completeSentences, "boolean");
  assert.equal(fs.existsSync(cli) ? fs.statSync(cli).mtimeMs : null, before);
});

test("verify-inject --agent dsh runs 20 real injections and proves budget/channel compatibility", () => {
  const result = run(["--agent", "dsh", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "agent:dsh");
  assert.equal(payload.writes, 9);
  assert.equal(payload.cleaned, true);
  assert.equal(payload.overall, "PASS");
  assert.equal(fs.existsSync(payload.temporaryRoot), false, "temporary fixture must be removed");
  const byId = Object.fromEntries(payload.checks.map((check) => [check.id, check]));
  assert.equal(byId.I3.pass, true);
  assert.equal(byId.I3.observed.runs, 20);
  assert.equal(byId.I3.observed.maxChars <= 600, true);
  assert.equal(byId.I3.observed.minChars > 0, true);
  assert.equal(byId.I3.observed.itemCountsMatch, true);
  assert.equal(byId.I3.observed.completeSentences, true);
  assert.equal(byId.I4.observed.grep.endsWith("0 occurrence(s)"), true);
  assert.equal(byId.I5.observed.injectedChars, 0);
  assert.equal(byId.I6.pass, true);
  assert.equal(byId.I6.observed.injectAudit.channel, "inject");
  assert.equal(byId.I6.observed.localhostControl.channel, "localhost");
  assert.equal(byId.I6.observed.agents.channels.some((entry) => entry.channel === "inject"), true);
});

test("verify-inject rejects unknown modes with usage", () => {
  const result = run(["--unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node scripts\/verify-inject\.mjs --agent dsh \| --dry/);
});
