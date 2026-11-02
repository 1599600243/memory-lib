#!/usr/bin/env node
// 写一条角色记忆（curated/agents/<agent>/role-*.md）：经验 / 适用场景 / 边界。
// 用法：
//   node scripts/note-role.mjs \
//     --experience "验收测试的 fixture 必须用真实接口返回的形状，否则对象被当数组迭代这类 bug 测不出来" \
//     --scope "验收控制台页面、写回归测试时" \
//     --boundary "不适用于一次性脚本；不替代原文证据" \
//     --kind lesson --confidence high --evidence conversation-xxx
// 身份由服务端从凭据解析（agent/role 不可自报）。
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
const sections = {
  经验: String(args.experience ?? "").trim(),
  适用场景: String(args.scope ?? "").trim(),
  边界: String(args.boundary ?? "").trim(),
};
for (const [heading, value] of Object.entries(sections)) {
  if (!value) { console.error(`缺少 --${{ 经验: "experience", 适用场景: "scope", 边界: "boundary" }[heading]}（正文段「${heading}」）`); process.exit(2); }
}
if ([...sections.经验.replace(/\s/gu, "")].length < 15) { console.error("--experience 至少 15 个字"); process.exit(2); }
const evidence = String(args.evidence ?? "").split(",").map((item) => item.trim()).filter(Boolean);
if (!evidence.length) { console.error("缺少 --evidence（非空证据 id，逗号分隔）"); process.exit(2); }

const { ref, secret } = await loadCredentials();
if (!ref || !secret) { console.error("缺少凭证：设置 CREDENTIAL_REF / SECRET，或 DSH_PROFILE 指向 profile 目录"); process.exit(2); }
const url = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const payload = {
  credential_ref: ref, secret,
  principal: { agent_id: process.env.AGENT_ID ?? "admin-01", role_id: process.env.ROLE_ID ?? "librarian-admin" },
  kind: args.kind ?? "lesson",
  confidence: args.confidence ?? "medium",
  sections,
  tags: String(args.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  evidence_refs: evidence,
};
const response = await fetch(`${url}/v1/roles/note`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const text = await response.text();
if (!response.ok) { console.error(`HTTP ${response.status}: ${text}`); process.exit(1); }
console.log(text);
