#!/usr/bin/env node
// identity.mjs —— 渠道身份注册（按 QQ 号/任意渠道 UID 隔离记忆）
//
// 做两件事：
//   1) 在 data/runtime/identity.json 里为这个渠道用户注册一个**独立 agent**（qq-xxxx）；
//   2) 在 data/runtime/identities.json 里写 渠道UID → agent/user/显示名 的映射。
//
// 为什么用独立 agent：记忆的可见性判定里，container=long-term 时按 agent_id 匹配
// （container-policy.mjs "agent || long-term" 分支）；给每个渠道用户一个 agent，
// 就能让"他的记忆只有他的 agent 读得到"。
//
// 用法：
//   node scripts/identity.mjs add --channel napcat --uid 12345678 --name 主人 --role owner
//   node scripts/identity.mjs list
//   node scripts/identity.mjs resolve --channel napcat --uid 12345678
//   node scripts/identity.mjs remove --channel napcat --uid 12345678

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dataRoot = path.resolve(process.env.MEMORY_DATA_ROOT ?? "D:\\MemoryLib\\data");
const identityFile = path.join(dataRoot, "runtime", "identity.json");
const mappingFile = path.join(dataRoot, "runtime", "identities.json");
// 模板优先用运行时覆盖（data/runtime），否则用仓库里的 config/role-templates.json。
const templateFile = fs.existsSync(path.join(dataRoot, "runtime", "role-templates.json"))
  ? path.join(dataRoot, "runtime", "role-templates.json")
  : path.join(path.resolve(process.env.MEMORY_LIB_ROOT ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")), "config", "role-templates.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file); // Windows 上偶发 EPERM，重试一次
}
function writeJsonRetry(file, value) {
  try { writeJson(file, value); } catch (err) {
    if (!["EPERM", "EBUSY", "EACCES"].includes(err?.code)) throw err;
    const tmp = `${file}.tmp-${process.pid}-retry`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  }
}

/** 渠道 UID → 稳定、可读、无特殊字符的 agent_id（不暴露原始 QQ 号全文） */
export function agentIdFor(channel, uid) {
  const digest = crypto.createHash("sha256").update(`${channel}:${uid}`).digest("hex").slice(0, 10);
  return `qq-${digest}`;
}

export function normalizeUid(uid) {
  const raw = String(uid ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(raw)) throw new Error(`uid 不合法（只允许字母数字-_，3~64 位）: ${raw}`);
  return raw;
}

function loadTemplateDoc() {
  const doc = readJson(templateFile, null);
  if (!doc?.templates) {
    throw new Error(`模板文件缺失或为空: ${templateFile}`);
  }
  return doc;
}

/** 按模板生成角色（只做填充，不写死规则） */
function rolesFromTemplate(templateName, agentId, userId) {
  const doc = loadTemplateDoc();
  const tpl = doc.templates[templateName];
  if (!tpl) {
    throw new Error(`未知模板 "${templateName}"；可选: ${Object.keys(doc.templates).join(", ")}`);
  }
  return tpl.roles.map((r) => ({
    ...r,
    scopes: r.scopes.map((s) => ({ ...s })),
    actions: [...r.actions],
    user_id: userId,
  }));
}

/** 落盘前校验：动作必须在词表内；scope 含 memory/user 时 user_id 必填；role_id 不重复 */
function validateRoles(roles, userId) {
  const doc = loadTemplateDoc();
  const allowed = new Set(doc.actions ?? []);
  const seen = new Set();
  for (const r of roles) {
    if (seen.has(r.role_id)) throw new Error(`模板内 role_id 重复: ${r.role_id}`);
    seen.add(r.role_id);
    for (const a of r.actions) {
      if (!allowed.has(a)) throw new Error(`未知动作 "${a}"（role ${r.role_id}）；词表: ${[...allowed].join(", ")}`);
    }
    const needsUser = r.scopes.some((s) => s.layer === "memory" && s.visibility === "user");
    if (needsUser && !r.user_id) throw new Error(`role ${r.role_id} 含 memory/user scope 但缺少 user_id`);
  }
  return true;
}

function loadMappings() {
  const doc = readJson(mappingFile, { version: 1, identities: [] });
  if (!Array.isArray(doc.identities)) doc.identities = [];
  return doc;
}

function cmdAdd({ channel, uid, name, role, "user-id": userIdFlag, "allow-share": allowShare, template, "dry-run": dryRun }) {
  const clean = normalizeUid(uid);
  const ch = String(channel ?? "").trim();
  if (!/^[a-z][a-z0-9-]{1,24}$/.test(ch)) throw new Error(`channel 不合法: ${ch}`);
  const mapping = loadMappings();
  const agentId = agentIdFor(ch, clean);
  // 主人这种"同一个人跨渠道"的场景要复用既有 user_id（否则老记忆一条都看不到）；
  // 默认仍按 agent 派生，隔离不受影响。
  const userId = typeof userIdFlag === "string" && userIdFlag.trim() ? userIdFlag.trim() : `u_${agentId.slice(3)}`;

  // 2026-10-30 事故防线：不同 agent 共用 user_id = 共享记忆（米汐曾因此读到我全部开发会话）。
  // 默认拒绝；确实要共享（同一个人多入口）必须显式 --allow-share。
  if (!allowShare) {
    const others = (readJson(mappingFile, { identities: [] }).identities ?? []).filter((x) => x.user_id === userId && x.agent_id !== agentId);
    if (others.length) {
      console.error(JSON.stringify({
        ok: false,
        error: "USER_ID_SHARED",
        message: `user_id "${userId}" 已被 ${others.map((x) => x.agent_id).join(", ")} 使用；不同 agent 共用 user_id 等于共享全部记忆。确实要共享请加 --allow-share`,
      }, null, 2));
      process.exit(2);
    }
  }

  const identity = readJson(identityFile, null);
  if (!identity?.frameworks?.[0]) throw new Error(`身份文件不可用: ${identityFile}`);
  const framework = identity.frameworks[0];
  framework.agents = framework.agents ?? [];

  const templateName = typeof template === "string" && template.trim() ? template.trim() : "chat-guest";
  const roles = rolesFromTemplate(templateName, agentId, userId);
  validateRoles(roles, userId);

  const existing = framework.agents.find((a) => a.agent_id === agentId);
  if (existing) {
    existing.roles = roles;
  } else {
    framework.agents.push({ agent_id: agentId, roles });
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, agent_id: agentId, user_id: userId, template: templateName, roles }, null, 2));
    return;
  }
  writeJsonRetry(identityFile, identity);

  const entry = {
    channel: ch,
    channel_uid: clean,
    agent_id: agentId,
    user_id: userId,
    display_name: String(name ?? clean).slice(0, 40),
    role: role === "owner" ? "owner" : "guest",
    created_at: new Date().toISOString(),
  };
  const idx = mapping.identities.findIndex((x) => x.channel === ch && x.channel_uid === clean);
  if (idx >= 0) mapping.identities[idx] = { ...mapping.identities[idx], ...entry };
  else mapping.identities.push(entry);
  writeJsonRetry(mappingFile, mapping);

  console.log(JSON.stringify({ ok: true, ...entry }, null, 2));
}

function cmdList() {
  const mapping = loadMappings();
  if (!mapping.identities.length) { console.log("（还没有任何渠道身份）"); return; }
  for (const x of mapping.identities) {
    console.log(`${x.channel}/${x.channel_uid}  →  agent=${x.agent_id}  user=${x.user_id}  name=${x.display_name}  role=${x.role}`);
  }
}

function cmdResolve({ channel, uid }) {
  const mapping = loadMappings();
  const hit = mapping.identities.find((x) => x.channel === channel && x.channel_uid === normalizeUid(uid));
  if (!hit) { console.log(JSON.stringify({ ok: false, reason: "unknown-identity" })); process.exit(1); }
  console.log(JSON.stringify({ ok: true, ...hit }));
}

function cmdRemove({ channel, uid }) {
  const clean = normalizeUid(uid);
  const mapping = loadMappings();
  const idx = mapping.identities.findIndex((x) => x.channel === channel && x.channel_uid === clean);
  if (idx < 0) { console.log("没有这条映射"); return; }
  const [gone] = mapping.identities.splice(idx, 1);
  writeJsonRetry(mappingFile, mapping);
  const identity = readJson(identityFile, null);
  const framework = identity?.frameworks?.[0];
  if (framework?.agents) {
    framework.agents = framework.agents.filter((a) => a.agent_id !== gone.agent_id);
    writeJsonRetry(identityFile, identity);
  }
  console.log(`已移除 ${gone.channel}/${gone.channel_uid}（agent ${gone.agent_id}）`);
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
try {
  if (cmd === "add") cmdAdd(flags);
  else if (cmd === "list") cmdList();
  else if (cmd === "resolve") cmdResolve(flags);
  else if (cmd === "remove") cmdRemove(flags);
  else if (cmd === "templates") {
    const doc = loadTemplateDoc();
    console.log("可用角色模板：");
    for (const [name, tpl] of Object.entries(doc.templates)) {
      console.log(`  ${name.padEnd(14)} ${tpl.description ?? ""}`);
      for (const r of tpl.roles) console.log(`      - ${r.role_id.padEnd(18)} actions=[${r.actions.join(",")}]`);
    }
    console.log(`\n动作词表: ${(doc.actions ?? []).join(", ")}`);
  }
  else {
    console.log("用法: node scripts/identity.mjs <add|list|resolve|remove|templates> --channel <ch> --uid <uid> [--name 名字] [--role owner|guest] [--template <模板>] [--user-id u_xxx] [--allow-share] [--dry-run]");
    process.exit(2);
  }
} catch (err) {
  console.error(`失败: ${err.message}`);
  process.exit(1);
}


