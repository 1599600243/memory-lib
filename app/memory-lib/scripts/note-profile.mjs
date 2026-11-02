#!/usr/bin/env node
// 写一条画像记忆（profile/<id>.md）：偏好 / 习惯 / 忌讳 / 已知事实。
// 用法：
//   node scripts/note-profile.mjs user-prefers-chinese \
//     --body "主人要求所有解释用中文，先给结论再给证据。" \
//     --tags preference,language --evidence conversation-xxx
// 环境变量：MEMORY_LIB_URL / CREDENTIAL_REF / SECRET / AGENT_ID / ROLE_ID
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
    else out._.push(arg);
  }
  return out;
}

async function loadCredentials() {
  let ref = process.env.CREDENTIAL_REF;
  let secret = process.env.SECRET;
  if ((!ref || !secret) && process.env.DSH_PROFILE) {
    const text = await fs.readFile(path.join(process.env.DSH_PROFILE, "cordis.patch.yml"), "utf8").catch(() => "");
    ref = ref ?? /X-MCP-Credential-Ref:\s*'([^']+)'/u.exec(text)?.[1];
    secret = secret ?? /X-MCP-Secret:\s*'([^']+)'/u.exec(text)?.[1];
  }
  return { ref, secret };
}

const args = parseArgs(process.argv.slice(2));
const id = args._[0];
const body = String(args.body ?? "").trim();
if (!id || !body) { console.error("用法: node scripts/note-profile.mjs <id> --body '...' [--tags a,b] --evidence id1,id2"); process.exit(2); }
const evidence = String(args.evidence ?? "").split(",").map((item) => item.trim()).filter(Boolean);
if (!evidence.length) { console.error("缺少 --evidence（非空证据 id，逗号分隔）"); process.exit(2); }
const tags = String(args.tags ?? "").split(",").map((item) => item.trim()).filter(Boolean);

const { ref, secret } = await loadCredentials();
if (!ref || !secret) { console.error("缺少凭证：设置 CREDENTIAL_REF / SECRET，或 DSH_PROFILE 指向 profile 目录"); process.exit(2); }
const url = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const payload = {
  credential_ref: ref, secret,
  principal: { agent_id: process.env.AGENT_ID ?? "admin-01", role_id: process.env.ROLE_ID ?? "librarian-admin" },
  layer: "profile", id, body, tags, evidence_refs: evidence,
};
const response = await fetch(`${url}/v1/write`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const text = await response.text();
if (!response.ok) { console.error(`HTTP ${response.status}: ${text}`); process.exit(1); }
console.log(text);
