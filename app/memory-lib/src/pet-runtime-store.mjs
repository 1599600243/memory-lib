// memory-lib pet-runtime stores: drafts and role personas.
// File-first only; these files are deliberately outside curated/search roots.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteFile } from "./atomic-write.mjs";

const DEFAULT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[a-zA-Z0-9._-]{1,160}$/u;

export function createPetRuntimeStore({ dataRoot, workspaceRoot, draftTtlMs = DEFAULT_DRAFT_TTL_MS } = {}) {
  if (!dataRoot) throw new Error("pet runtime store requires dataRoot");
  const draftsRoot = path.join(dataRoot, "drafts");
  const personasRoot = path.join(workspaceRoot ?? path.dirname(dataRoot), "personas");
  const ttl = Number.isFinite(Number(draftTtlMs)) && Number(draftTtlMs) >= 0 ? Number(draftTtlMs) : DEFAULT_DRAFT_TTL_MS;

  async function cleanupDrafts({ now = Date.now(), ttlMs = ttl } = {}) {
    const removed = [];
    for (const file of await listFiles(draftsRoot)) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const value = await readJson(file);
      const createdAt = Date.parse(String(value?.createdAt ?? value?.updatedAt ?? ""));
      const baseTime = Number.isFinite(createdAt) ? createdAt : stat.mtimeMs;
      if (now - baseTime < ttlMs) continue;
      await fs.unlink(file).catch(() => {});
      removed.push(file);
    }
    return { removed, count: removed.length };
  }

  async function putDraft({ content, kind = "conversation", source = "pet", roleId = "companion", petMode = null, sessionId = null, id = null, createdAt = null } = {}) {
    if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
    await cleanupDrafts();
    await fs.mkdir(draftsRoot, { recursive: true });
    const safeId = id && SAFE_ID.test(id) ? id : `draft-${crypto.randomUUID().slice(0, 12)}`;
    const filePath = path.join(draftsRoot, `${safeId}.json`);
    const timestamp = createdAt ?? new Date().toISOString();
    const value = {
      id: safeId,
      kind: String(kind).slice(0, 80),
      source: String(source).slice(0, 80),
      // VISIBILITY-FIX-1-REJECT2：`role_id` 是**作用域**（认证身份的 role_id）；
      // `pet_mode` 只是**交互模式标签**（companion/assistant/…），**不参与可见性判定**。
      role_id: String(roleId).slice(0, 80),
      pet_mode: petMode ? String(petMode).slice(0, 80) : null,
      session_id: sessionId ? String(sessionId).slice(0, 256) : null,
      createdAt: timestamp,
      updatedAt: new Date().toISOString(),
      content,
    };
    await atomicWrite(filePath, JSON.stringify(value, null, 2) + "\n");
    return { ...value, path: filePath, status: "draft" };
  }

  // VISIBILITY-FIX-1：清单必须带**显式作用域**，否则拒绝 —— 不许"没给 scope 就列全部"。
  // 草稿按 role_id 归属，所以作用域就是 role_id（由服务端从连接身份绑定，不接受自报）。
  async function listDrafts({ limit = 100, includeExpired = false, roleId = null } = {}) {
    const scope = String(roleId ?? "").trim();
    if (!scope) throw Object.assign(new Error("petRuntime.listDrafts requires an explicit role scope; refusing to list every role's drafts"), { code: "MISSING_SCOPE", status: 403 });
    if (!includeExpired) await cleanupDrafts();
    const files = (await listFiles(draftsRoot)).sort().reverse().slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    const out = [];
    for (const file of files) {
      const value = await readJson(file);
      if (value && String(value.role_id ?? "") === scope) out.push({ ...value, path: file });
    }
    return out;
  }

  async function getDraft(id) {
    if (!SAFE_ID.test(String(id ?? ""))) return null;
    await cleanupDrafts();
    const file = path.join(draftsRoot, `${id}.json`);
    const value = await readJson(file);
    return value ? { ...value, path: file } : null;
  }

  // VISIBILITY-FIX-1：清理也必须有**显式作用域**（role_id），且只清该角色的草稿。
  // 此前 `all:true` 会删掉**所有角色**的草稿 —— 一个无身份的"全清"是最危险的一种"没身份就跳过"。
  async function clearDrafts({ id = null, all = false, roleId = null } = {}) {
    const scope = String(roleId ?? "").trim();
    if (!scope) throw Object.assign(new Error("petRuntime.clearDrafts requires an explicit role scope; refusing to clear every role's drafts"), { code: "MISSING_SCOPE", status: 403 });
    if (id !== null && !SAFE_ID.test(String(id))) throw new Error("invalid draft id");
    if (!id && !all) all = true;
    const files = id ? [path.join(draftsRoot, `${id}.json`)] : await listFiles(draftsRoot);
    const removed = [];
    for (const file of files) {
      if (!all && !id) continue;
      // 只动属于该作用域的草稿
      const value = id ? await readJson(file) : await readJson(file);
      if (value && String(value.role_id ?? "") !== scope) continue;
      if (await fs.unlink(file).then(() => true).catch(() => false)) removed.push(file);
    }
    return { removed, count: removed.length };
  }

  async function loadPersona(roleId = "companion") {
    const safeRole = String(roleId).replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "companion";
    const file = path.join(personasRoot, `${safeRole}.json`);
    const value = await readJson(file);
    return value ?? defaultPersona(safeRole);
  }

  // VISIBILITY-FIX-1：persona 清单同样必须带**显式作用域**（role_id），不许列全部角色的 persona。
  async function listPersonas({ roleId = null } = {}) {
    const scope = String(roleId ?? "").trim();
    if (!scope) throw Object.assign(new Error("petRuntime.listPersonas requires an explicit role scope; refusing to list every role's persona"), { code: "MISSING_SCOPE", status: 403 });
    const safeRole = scope.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80);
    const files = (await listFiles(personasRoot)).filter((file) => file.endsWith(".json"));
    const out = [];
    for (const file of files) {
      const value = await readJson(file);
      if (value && String(value.role_id ?? "") === safeRole) out.push(value);
    }
    return out;
  }

  async function putPersonaConfig(roleId, persona) {
    const safeRole = String(roleId).replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "companion";
    await fs.mkdir(personasRoot, { recursive: true });
    const value = {
      role_id: safeRole,
      name: String(persona?.name ?? safeRole).slice(0, 120),
      tone: String(persona?.tone ?? "友好、简洁、诚实").slice(0, 1000),
      background: String(persona?.background ?? "").slice(0, 2000),
      memoryRules: Array.isArray(persona?.memoryRules) ? persona.memoryRules.slice(0, 20).map((x) => String(x).slice(0, 200)) : ["只引用服务端授权检索到的记忆"],
      updatedAt: new Date().toISOString(),
    };
    const filePath = path.join(personasRoot, `${safeRole}.json`);
    await atomicWrite(filePath, JSON.stringify(value, null, 2) + "\n");
    return { ...value, path: filePath };
  }

  return { draftsRoot, personasRoot, cleanupDrafts, putDraft, listDrafts, getDraft, clearDrafts, loadPersona, listPersonas, putPersonaConfig };
}

export const DEFAULT_PET_DRAFT_TTL_MS = DEFAULT_DRAFT_TTL_MS;

function defaultPersona(roleId) {
  const presets = {
    companion: { name: "陪伴", tone: "温和、自然、简洁，关注用户感受", background: "共同回忆的聊天伙伴" },
    assistant: { name: "普通", tone: "清晰、务实、主动但不越权", background: "帮助整理和记录的助手" },
    steward: { name: "管家", tone: "条理、审慎、用清单说明待确认事项", background: "只做巡检和提议的管家" },
    learner: { name: "学习", tone: "耐心、准确、鼓励理解和复习", background: "与学习层协作的私教" },
    governance: { name: "治理", tone: "克制、可审计、逐项说明依据", background: "只在明确授权下执行治理" },
  };
  return { role_id: roleId, ...presets[roleId] ?? presets.companion, memoryRules: ["只引用服务端授权检索到的记忆"] };
}

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(root, entry.name));
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }
