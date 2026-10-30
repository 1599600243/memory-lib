#!/usr/bin/env node
// Issue a role key through the real localhost admin API. Dry-run performs no network or file write.
function value(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}
function required(args, name) {
  const result = value(args, name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}
function writeOutput(args, output) {
  const target = value(args, "--output-file");
  if (!target) return process.stdout.write(`${JSON.stringify(output)}\n`);
  return import("node:fs/promises").then(({ writeFile }) => writeFile(target, `${JSON.stringify(output)}\n`, "utf8"));
}

const args = process.argv.slice(2);
try {
  const base = required(args, "--url").replace(/\/$/u, "");
  const role = required(args, "--role");
  const token = required(args, "--token");
  const group = required(args, "--group");
  const user = required(args, "--user");
  const body = { role_id: role, group_id: group, user_id: user };
  const dryRun = args.includes("--dry-run");
  if (dryRun) {
    await writeOutput(args, { dry_run: true, method: "POST", url: `${base}/v1/admin/roles/key`, body: { ...body, token: "[redacted]" } });
    process.exit(0);
  }
  const response = await fetch(`${base}/v1/admin/roles/key`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `admin API returned ${response.status}`);
  if (!payload?.key?.secret) throw new Error("admin API did not return a key secret");
  await writeOutput(args, { ok: true, key: payload.key });
} catch (error) {
  process.stderr.write(`issue-api-key: ${error.message}\n`);
  process.exitCode = 2;
}
