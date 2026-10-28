// memory-lib D3.4 — 画像层 + 人工确认闸门。
// 落点 dataRoot/profile/，条目 kind ∈ {profile,preference,contract}，正文是指令式偏好/约定。
// 巩固器只能写 status=draft；升 active 必须人工确认（confirm）；未确认的 draft 检索不返回。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { parseFrontmatterTyped, renderFrontmatter, unquote, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { requireEvidenceRefs } from "./write-validation.mjs";
import { principalAllowsContainer } from "./container-policy.mjs";
import { requirePrincipal } from "./identity-guard.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export function createProfileMemory({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("profile-memory: dataRoot is required");
  const root = path.join(dataRoot, "profile");

  async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }

  function itemFrom(text, filePath) {
    const { frontmatter, body } = parseFrontmatterTyped(text);
    return {
      id: unquote(frontmatter.id) || path.basename(filePath, ".md"),
      kind: frontmatter.kind ?? "profile",
      container: frontmatter.container ?? "long-term",
      tenant_id: frontmatter.tenant_id ?? "default",
      visibility: frontmatter.visibility ?? "private",
      group_id: frontmatter.group_id ?? null,
      user_id: frontmatter.user_id ?? null,
      agent_id: frontmatter.agent_id ?? null,
      role_id: frontmatter.role_id ?? null,
      status: frontmatter.status ?? "draft",
      confidence: frontmatter.confidence ?? "medium",
      source_episodes: Array.isArray(frontmatter.source_episodes) ? frontmatter.source_episodes : [],
      evidence_refs: Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs : [],
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      occurred_at: frontmatter.occurred_at ?? "",
      updated_at: frontmatter.updated_at ?? "",
      body: body.trim(),
      path: filePath,
    };
  }

  async function listProfiles({ include_draft = true, principal = null } = {}) {
    // VISIBILITY-FIX-1：拿不到身份 ⇒ 拒绝（此前跳过判定 ⇒ 无身份时返回全部画像）
    requirePrincipal(principal, "profileMemory.listProfiles");
    const items = [];
    for (const filePath of await walkFiles(root)) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const item = itemFrom(text, filePath);
      if (item.status === "draft" && !include_draft) continue;
      if (!principalAllowsContainer(principal, { ...item, container: "long-term", visibility: item.visibility ?? "private" })) continue;
      items.push(item);
    }
    return items.sort((a, b) => String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? "")));
  }

  async function get(id, principal = null) {
    for (const filePath of await walkFiles(root)) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const item = itemFrom(text, filePath);
      if (unquote(item.id) === unquote(id) && (!principal || principalAllowsContainer(principal, { ...item, container: "long-term", visibility: item.visibility ?? "private" }))) return item;
    }
    return null;
  }

  async function confirm(id, { evidence_refs = [], principal = null } = {}) {
    const item = await get(id);
    if (!item) throw new Error(`profile not found: ${id}`);
    if (item.status !== "draft") throw new Error(`profile is not a draft (${item.status})`);
    const refs = requireEvidenceRefs(evidence_refs);
    if (!refs.every((ref) => (item.evidence_refs ?? []).includes(ref))) throw new Error("profile confirmation requires evidence_refs already attached to the draft");
    const text = await readTextFile(item.path);
    const { frontmatter, body } = parseFrontmatterTyped(text);
    const updates = {
      layer: JSON.stringify(frontmatter.layer ?? "long-term"),
      container: JSON.stringify(frontmatter.container ?? "long-term"),
      tenant_id: JSON.stringify(frontmatter.tenant_id ?? principal?.tenant_id ?? "default"),
      status: JSON.stringify("active"),
      updated_at: JSON.stringify(new Date().toISOString()),
      confirmed_at: JSON.stringify(new Date().toISOString()),
      confirmed_by: JSON.stringify(principal?.agent_id ?? ""),
    };
    await atomicWrite(item.path, updateFrontmatterFields(text, updates));
    return { id, status: "active", path: item.path };
  }

  return { listProfiles, get, confirm, root };
}
