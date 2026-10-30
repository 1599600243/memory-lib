// memory-lib D2.3 — 计划记忆 `plans/<topic>.md`。
// 数据契约：frontmatter 9 字段 + 正文三段（目标/步骤/当前卡点）。
// 步骤用编号列表，每步以 `- [ ]` / `- [x]` 开头（可勾选）。
// 闸门：draft 由 agent 写；升 active 必须人工确认（confirm 才允许）；done 后默认视图隐藏但可检索。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { parseFrontmatterTyped, renderFrontmatter, parseSections, slugify, unquote, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { requireEvidenceRefs } from "./write-validation.mjs";
import { principalAllowsContainer } from "./container-policy.mjs";
import { requirePrincipal } from "./identity-guard.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const PLAN_SECTIONS = ["目标", "步骤", "当前卡点"];
const STATUSES = new Set(["draft", "active", "done", "abandoned"]);

export function createPlansMemory({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("plans-memory: dataRoot is required");
  const root = path.join(dataRoot, "plans");

  async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }

  function validateSections(sections) {
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      throw new Error("sections is required (an object mapping each of the three headings to text)");
    }
    for (const heading of PLAN_SECTIONS) {
      const content = String(sections[heading] ?? "").trim();
      if (!content) throw new Error(`section "${heading}" is required and must not be empty`);
    }
    const steps = String(sections["步骤"] ?? "");
    // 步骤段至少一条可勾选项 `- [ ]` 或 `- [x]`
    if (!/^\s*- \[[ xX]\]/m.test(steps)) {
      throw new Error(`section "步骤" must contain at least one checkbox line starting with "- [ ]" or "- [x]"`);
    }
  }

  function renderPlan({ id, topic, status, owner, created_at, updated_at, supersedes, evidence_refs, principal, sections }) {
    const frontmatter = renderFrontmatter([
      ["id", id],
      ["layer", "plan"],
      ["container", "plan"],
      ["tenant_id", principal?.tenant_id ?? "default"],
      ["visibility", principal?.visibility ?? "private"],
      ["topic", topic],
      ["status", status],
      ["owner", owner ?? null],
      ["created_at", created_at],
      ["updated_at", updated_at],
      ["supersedes", supersedes ?? null],
      ["evidence_refs", Array.isArray(evidence_refs) ? evidence_refs : []],
      ...(principal ? [["framework_id", principal.framework_id], ["group_id", principal.group_id ?? null], ["user_id", principal.user_id ?? null], ["agent_id", principal.agent_id], ["role_id", principal.role_id]] : []),
    ]);
    const body = PLAN_SECTIONS.map((heading) => `## ${heading}\n\n${String(sections[heading] ?? "").trim()}\n`).join("\n");
    return frontmatter + body;
  }

  function itemFrom(text, filePath) {
    const { frontmatter, body } = parseFrontmatterTyped(text);
    return {
      id: unquote(frontmatter.id) || path.basename(filePath, path.extname(filePath)),
      topic: frontmatter.topic ?? "",
      status: frontmatter.status ?? "draft",
      owner: frontmatter.owner ?? null,
      created_at: frontmatter.created_at ?? null,
      updated_at: frontmatter.updated_at ?? null,
      supersedes: frontmatter.supersedes ?? null,
      evidence_refs: Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs : [],
      framework_id: frontmatter.framework_id ?? null,
      agent_id: frontmatter.agent_id ?? null,
      role_id: frontmatter.role_id ?? null,
       group_id: frontmatter.group_id ?? null,
       user_id: frontmatter.user_id ?? null,
       visibility: frontmatter.visibility ?? "private",
       container: frontmatter.container ?? "plan",
      sections: parseSections(body, PLAN_SECTIONS),
      path: filePath,
    };
  }

  async function writePlan({ topic, sections, status = "draft", owner = null, supersedes = null, evidence_refs = [], created_at = null, principal = null } = {}) {
    const name = String(topic ?? "").trim();
    if (!name) throw new Error("topic is required");
    if (!STATUSES.has(status)) throw new Error(`status must be one of ${[...STATUSES].join("|")}`);
    validateSections(sections);
    evidence_refs = requireEvidenceRefs(evidence_refs);
    const now = new Date().toISOString();
    const filePath = path.join(root, `${slugify(name)}.md`);
    // 合并更新：若已存在，保留 created_at（计划首次创建时间），updated_at 刷新。
    let createdAt = created_at ?? now;
    const existing = await readTextFile(filePath);
    if (existing) {
      const prev = itemFrom(existing, filePath);
      createdAt = prev.created_at ?? createdAt;
      // 闸门：agent 只能写 draft；不允许直接写 active（必须走 confirm）。
      if (status === "active" && prev.status !== "active") {
        throw new Error("plan cannot be promoted to active directly; human confirmation is required");
      }
    } else if (status !== "draft") {
      throw new Error("a new plan must start as draft");
    }
    const id = `plan-${slugify(name)}`;
    const content = renderPlan({ id, topic: name, status, owner, created_at: createdAt, updated_at: now, supersedes, evidence_refs, principal, sections });
    await atomicWrite(filePath, content);
    return { id, topic: name, status, path: filePath, updated_at: now };
  }

  // WRITE-DENY-1-REJECT1（F4）：计划的状态迁移是一次**写入**，必须按记录真实的可见性
  // 匹配服务端身份（读侧唯一真值源 principalAllowsContainer，这里不另立判据）。
  // 旧实现只按 topic 改文件 —— 任何能 propose 的角色都能确认/关闭别人的计划。
  async function confirm(topic, { principal = null } = {}) {
    return transition(topic, "active", "draft", "plan is not a draft to confirm", { principal });
  }
  async function markDone(topic, { principal = null } = {}) {
    return transition(topic, "done", "active", "plan is not active to mark done", { principal });
  }
  async function abandon(topic, { principal = null } = {}) {
    return transition(topic, "abandoned", null, null, { principal });
  }

  async function transition(topic, nextStatus, fromStatus, errorMessage, { principal = null } = {}) {
    const name = String(topic ?? "").trim();
    const filePath = path.join(root, `${slugify(name)}.md`);
    const text = await readTextFile(filePath);
    if (!text) throw new Error(`plan not found: ${name}`);
    const item = itemFrom(text, filePath);
    if (principal && !principalAllowsContainer(principal, { ...item, container: "plan", visibility: item.visibility ?? "private" })) {
      throw Object.assign(new Error("PLAN_NOT_AUTHORIZED: this plan is not writable by the authenticated principal"), { status: 403, code: "WRITE_SCOPE_DENIED", detail: "IDENTITY_MISMATCH" });
    }
    if (fromStatus && item.status !== fromStatus) throw new Error(errorMessage || `plan is in status ${item.status}, expected ${fromStatus}`);
    if (!STATUSES.has(nextStatus)) throw new Error(`invalid status: ${nextStatus}`);
    const now = new Date().toISOString();
    const { frontmatter, body } = parseFrontmatterTyped(text);
    const updates = {
      container: JSON.stringify(frontmatter.container ?? "plan"),
      tenant_id: JSON.stringify(frontmatter.tenant_id ?? "default"),
      status: JSON.stringify(nextStatus),
      updated_at: JSON.stringify(now),
    };
    await atomicWrite(filePath, updateFrontmatterFields(text, updates));
    return { id: unquote(frontmatter.id) || item.id, topic: name, status: nextStatus, path: filePath, updated_at: now };
  }

  async function listPlans({ include_done = false, principal = null } = {}) {
    // VISIBILITY-FIX-1：拿不到身份 ⇒ 拒绝（此前是"跳过判定"⇒ 无身份时返回全部计划）
    requirePrincipal(principal, "plansMemory.listPlans");
    const files = await walkFiles(root);
    const items = [];
    for (const filePath of files) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const item = itemFrom(text, filePath);
      if (item.status === "done" && !include_done) continue; // done 后默认视图隐藏
      if (!principalAllowsContainer(principal, { ...item, container: "plan", visibility: item.visibility ?? "private" })) continue;
      if (item.agent_id && item.agent_id !== principal.agent_id) continue;
      if (item.group_id && principal.group_id && item.group_id !== principal.group_id) continue;
      items.push(item);
    }
    return items.sort((a, b) => String(a.topic).localeCompare(String(b.topic)));
  }

  async function getPlan(topic, principal = null) {
    const name = String(topic ?? "").trim();
    const filePath = path.join(root, `${slugify(name)}.md`);
    const text = await readTextFile(filePath);
    if (!text) return null;
    const item = itemFrom(text, filePath);
    return principal && !principalAllowsContainer(principal, { ...item, container: "plan", visibility: item.visibility ?? "private" }) ? null : item;
  }

  return { writePlan, confirm, markDone, abandon, listPlans, getPlan, root };
}
