#!/usr/bin/env node
// 写一条计划记忆（plans/<topic>.md）。
// 用法：
//   node scripts/note-plan.mjs "控制台 v2 收尾" \
//     --goal "把 19 个页面的数据源和空态都对齐真实能力" \
//     --steps "- [x] 知识库接 evidence/documents
// - [x] 工具记忆生产者
// - [ ] 计划/画像生产者" \
//     --blocker "学习流程未启用，计划/画像只能手动写" \
//     --evidence conversation-xxx
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
const topic = args._[0];
if (!topic) { console.error("用法: node scripts/note-plan.mjs <topic> --goal ... --steps '- [ ] ...' --blocker ... --evidence id1,id2"); process.exit(2); }
const sections = { 目标: String(args.goal ?? "").trim(), 步骤: String(args.steps ?? "").trim(), 当前卡点: String(args.blocker ?? "").trim() };
for (const [heading, value] of Object.entries(sections)) {
  if (!value) { console.error(`缺少 --${heading === "目标" ? "goal" : heading === "步骤" ? "steps" : "blocker"}（正文段「${heading}」）`); process.exit(2); }
}
if (!/^-\s*\[[ xX]\]/mu.test(sections.步骤)) { console.error("--steps 里必须至少一行 '- [ ]' 或 '- [x]'"); process.exit(2); }
const evidence = String(args.evidence ?? "").split(",").map((item) => item.trim()).filter(Boolean);
if (!evidence.length) { console.error("缺少 --evidence（非空证据 id，逗号分隔）"); process.exit(2); }

const { ref, secret } = await loadCredentials();
if (!ref || !secret) { console.error("缺少凭证：设置 CREDENTIAL_REF / SECRET，或 DSH_PROFILE 指向 profile 目录"); process.exit(2); }
const url = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const payload = {
  credential_ref: ref, secret,
  principal: { agent_id: process.env.AGENT_ID ?? "admin-01", role_id: process.env.ROLE_ID ?? "librarian-admin" },
  topic, sections, status: args.status ?? "draft", evidence_refs: evidence,
};
const response = await fetch(`${url}/v1/plans/put`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const body = await response.text();
if (!response.ok) { console.error(`HTTP ${response.status}: ${body}`); process.exit(1); }
console.log(body);
