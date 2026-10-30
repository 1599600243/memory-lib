// memory-lib D4.1 — 角色记忆（curated/agents/<agent_id>/）。
// 记录「这个 agent/角色做事学到过什么」：经验 / 适用场景 / 边界 三段。
// 写入者 agent 自写；agent_id/role_id 由连接身份带入（不信任自报）。
// 拒绝：凭证/密钥、用户偏好类内容（属画像层）、缺段。
// 合并：同 agent + 同 kind 近重复（Dice ≥0.72）→ 合并 evidence_refs；结论推翻 → 取代。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { renderFrontmatter, parseFrontmatterTyped, parseSections, slugify, unquote, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { containsSensitiveText, redactSensitiveText, candidateSimilarity, CANDIDATE_DEDUP_THRESHOLD } from "./extraction-quality.mjs";
import { requireEvidenceRefs } from "./write-validation.mjs";
import { principalAllowsContainer } from "./container-policy.mjs";
import { requirePrincipal } from "./identity-guard.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const ROLE_KINDS = new Set(["lesson", "capability", "boundary", "preference"]);
const ROLE_CONFIDENCE = new Set(["low", "medium", "high"]);
const ROLE_SECTIONS = ["经验", "适用场景", "边界"];
const PREFERENCE_RE = /用户偏好|用户要求|用户喜欢|用户希望|用户想|用户的偏好/u;

function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function normalizeKey(text) { return String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase(); }
function nowIso() { return new Date().toISOString(); }

export function createRoleMemory({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("role-memory: dataRoot is required");
  const root = path.join(dataRoot, "curated", "agents");

  async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }

  function renderBody(sections) {
    return ROLE_SECTIONS.map((h) => `## ${h}\n\n${String(sections[h] ?? "").trim()}\n`).join("\n");
  }

  function renderNote(id, note, status, supersededBy) {
    const frontmatter = renderFrontmatter([
      ["id", id],
      ["layer", "role"],
      ["container", "role"],
      ["tenant_id", note.tenant_id ?? "default"],
      ["visibility", "role"],
      ["group_id", note.group_id ?? null],
      ["user_id", note.user_id ?? null],
      ["agent_id", note.agent_id],
      ["role_id", note.role_id],
      ["kind", note.kind],
      ["confidence", note.confidence],
      ["status", status],
      ["superseded_by", supersededBy ?? null],
      ["occurred_at", note.occurred_at ?? ""],
      ["updated_at", note.updated_at ?? nowIso()],
      ["tags", note.tags ?? []],
      ["evidence_refs", note.evidence_refs ?? []],
    ]);
    return frontmatter + renderBody(note.sections);
  }

  function noteFrom(text, filePath) {
    const { frontmatter, body } = parseFrontmatterTyped(text);
    return {
      id: unquote(frontmatter.id) || path.basename(filePath, ".md"),
      agent_id: frontmatter.agent_id ?? "",
      role_id: frontmatter.role_id ?? "",
      kind: frontmatter.kind ?? "lesson",
      confidence: frontmatter.confidence ?? "medium",
      status: frontmatter.status ?? "active",
      superseded_by: frontmatter.superseded_by ?? null,
      occurred_at: frontmatter.occurred_at ?? "",
      updated_at: frontmatter.updated_at ?? "",
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      evidence_refs: Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs : [],
      sections: parseSections(body, ROLE_SECTIONS),
      body: body.trim(),
      path: filePath,
    };
  }

  async function listRoleNotes({ agent_id = null, role_id = null, principal = null } = {}) {
    // VISIBILITY-FIX-1：拿不到身份 ⇒ 拒绝。
    // 此前 trustedAgent/trustedRole 可能双双为 null ⇒ 两条过滤全跳过；
    // `if (principal && …)` 也不执行 ⇒ 无身份时**返回全部角色记忆**（跨 agent/跨角色）。
    // `agent_id`/`role_id` 形参**只允许作为已授权范围内的进一步过滤**，不能替代 principal。
    requirePrincipal(principal, "roleMemory.listRoleNotes");
    const trustedAgent = agent_id;
    const trustedRole = role_id;
    const items = [];
    for (const filePath of await walkFiles(root)) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const note = noteFrom(text, filePath);
      if (trustedAgent && note.agent_id !== trustedAgent) continue;
      if (trustedRole && note.role_id !== trustedRole) continue;
      if (!principalAllowsContainer(principal, { ...note, container: "role", visibility: "role" })) continue;
      items.push(note);
    }
    return items.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  }

  async function getRoleNote(id, principal = null) {
    for (const filePath of await walkFiles(root)) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const note = noteFrom(text, filePath);
      if (unquote(note.id) === unquote(id) && (!principal || (note.agent_id === principal.agent_id && note.role_id === principal.role_id)) && (!principal || principalAllowsContainer(principal, { ...note, container: "role", visibility: "role" }))) return note;
    }
    return null;
  }

  async function mergeEvidenceRefs(existingPath, newRefs) {
    const text = await readTextFile(existingPath);
    if (!text) return;
    const { frontmatter, body } = parseFrontmatterTyped(text);
    const merged = [...new Set([...(frontmatter.evidence_refs ?? []), ...newRefs])];
    const updates = {
      tenant_id: JSON.stringify(frontmatter.tenant_id ?? "default"),
      container: JSON.stringify(frontmatter.container ?? "role"),
      visibility: JSON.stringify(frontmatter.visibility ?? "role"),
      evidence_refs: JSON.stringify(merged),
      status: JSON.stringify("active"),
      updated_at: JSON.stringify(nowIso()),
      superseded_by: "null",
    };
    await atomicWrite(existingPath, updateFrontmatterFields(text, updates));
  }

  async function setSuperseded(filePath, supersededBy) {
    const text = await readTextFile(filePath);
    if (!text) return;
    const { frontmatter, body } = parseFrontmatterTyped(text);
    const updates = {
      tenant_id: JSON.stringify(frontmatter.tenant_id ?? "default"),
      container: JSON.stringify(frontmatter.container ?? "role"),
      visibility: JSON.stringify(frontmatter.visibility ?? "role"),
      status: JSON.stringify("superseded"),
      superseded_by: JSON.stringify(supersededBy),
      updated_at: JSON.stringify(nowIso()),
    };
    await atomicWrite(filePath, updateFrontmatterFields(text, updates));
  }

  async function putRoleNote({ agent_id, role_id, group_id = null, user_id = null, tenant_id = "default", kind = "lesson", confidence = "medium", sections = {}, occurred_at = "", tags = [], evidence_refs = [], supersedes = null } = {}) {
    if (typeof agent_id !== "string" || !agent_id.trim()) throw new Error("role note requires agent_id (from connection identity)");
    if (typeof role_id !== "string" || !role_id.trim()) throw new Error("role note requires role_id (from connection identity)");
    if (!ROLE_KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`);
    const conf = ROLE_CONFIDENCE.has(confidence) ? confidence : "medium";

    const cleanSections = {};
    for (const h of ROLE_SECTIONS) {
      const raw = String(sections?.[h] ?? "").trim();
      if (containsSensitiveText(raw)) throw new Error("role note must not contain secrets/credentials");
      const value = redactSensitiveText(raw).trim();
      if (!value) throw new Error(`role note requires non-empty section: ## ${h}`);
      cleanSections[h] = value;
    }
    if (String(cleanSections["经验"]).replace(/\s/g, "").length < 15) throw new Error("role note 经验 must be >= 15 chars");
    if (PREFERENCE_RE.test(`${cleanSections["经验"]} ${cleanSections["适用场景"]} ${cleanSections["边界"]}`)) {
      throw new Error("this is a user-preference statement; write it to the profile layer instead");
    }
    evidence_refs = requireEvidenceRefs(evidence_refs);

    const safeAgent = slugify(agent_id);
    const note = {
      agent_id, role_id, group_id, user_id, tenant_id, kind, confidence: conf,
      occurred_at: String(occurred_at ?? "").slice(0, 10) || "",
      updated_at: nowIso(),
      tags: (Array.isArray(tags) ? tags : []).map(String).slice(0, 20),
      evidence_refs: (Array.isArray(evidence_refs) ? evidence_refs : []).map(String).slice(0, 50),
      sections: cleanSections,
    };

    // 取代：结论被推翻
    if (supersedes) {
      const old = await getRoleNote(supersedes);
      if (old && old.status === "active") await setSuperseded(old.path, null);
    }

    // 合并：同 agent + 同 kind 近重复
    // VISIBILITY-FIX-1：这里必须自带 principal —— 去重的比对范围就是**这条记忆自己的归属**
    // （agent_id/role_id 在函数入口已校验、由连接身份带入），不是调用方自报的任意身份。
    const existing = (await listRoleNotes({
      agent_id,
      role_id,
      principal: { framework_id: "internal-write-dedup", agent_id, role_id, tenant_id, group_id, user_id },
    })).filter((n) => n.status === "active" && n.kind === kind);
    const dup = existing.find((n) => candidateSimilarity(n.sections?.["经验"] ?? "", cleanSections["经验"]) >= CANDIDATE_DEDUP_THRESHOLD);
    if (dup) {
      await mergeEvidenceRefs(dup.path, note.evidence_refs);
      return { id: dup.id, path: dup.path, status: "active", merged: true };
    }

    const id = `role-${hash(`${safeAgent}:${kind}:${normalizeKey(cleanSections["经验"])}`).slice(0, 16)}`;
    const filePath = path.join(root, safeAgent, `${id}.md`);
    await atomicWrite(filePath, renderNote(id, note, "active", null));
    return { id, path: filePath, status: "active", merged: false };
  }

  return { putRoleNote, listRoleNotes, getRoleNote, root };
}
