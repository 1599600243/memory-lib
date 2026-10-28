// memory-lib D2.1 — 工具记忆 `tools-memory/<tool>.md`。
// 数据契约：frontmatter 10 字段 + 正文五段（用途/接入方式/关键参数/已知坑/验证方式）。
// 同 tool_name 合并更新（不新建文件）；verified_at 超 90 天自动降 needs-review（不删除）。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { containsSensitiveText } from "./extraction-quality.mjs";
import { parseFrontmatterTyped, renderFrontmatter, parseSections, slugify, unquote, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { requireEvidenceRefs } from "./write-validation.mjs";
import { principalAllowsContainer } from "./container-policy.mjs";
import { requirePrincipal } from "./identity-guard.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";
import { containerDefaultVisibility } from "./write-memory.mjs";

const KINDS = new Set(["tool", "service", "cli", "api"]);
export const TOOL_SECTIONS = ["用途", "接入方式", "关键参数", "已知坑", "验证方式"];
const REVIEW_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export function createToolsMemory({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("tools-memory: dataRoot is required");
  const root = path.join(dataRoot, "tools-memory");

  async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }

  function validateSections(sections) {
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      throw new Error("sections is required (an object mapping each of the five headings to text)");
    }
    for (const heading of TOOL_SECTIONS) {
      const content = String(sections[heading] ?? "").trim();
      if (!content) throw new Error(`section "${heading}" is required and must not be empty`);
      if (containsSensitiveText(content)) throw new Error(`section "${heading}" must not contain secrets/credentials`);
    }
  }

  function renderTool({ id, tool_name, kind, env, verified_at, status, superseded_by, confidence, evidence_refs, principal, sections }) {
    // WRITE-DENY-1-REJECT1（F1）：可见性只有一个真值源 —— 容器默认值（tool ⇒ platform）。
    // 旧实现写的是 `principal?.visibility ?? "platform"`，而认证 principal 根本没有 visibility 字段，
    // 于是"判权用 body.visibility、落盘用 platform"两者脱节：非 admin 自报 private 就能过门。
    // 现在无论调用方说什么，落盘的就是容器默认值；入口侧也按同一个值判权。
    const visibility = containerDefaultVisibility("tool");
    const frontmatter = renderFrontmatter([
      ["id", id],
      ["layer", "tool"],
      ["container", "tool"],
      ["tenant_id", principal?.tenant_id ?? "default"],
      ["visibility", visibility],
      ["tool_name", tool_name],
      ["kind", kind],
      ["env", env],
      ["verified_at", verified_at],
      ["status", status],
      ["superseded_by", superseded_by ?? null],
      ["confidence", confidence ?? "medium"],
      ["evidence_refs", Array.isArray(evidence_refs) ? evidence_refs : []],
      ...(principal ? [["framework_id", principal.framework_id], ["agent_id", principal.agent_id], ["role_id", principal.role_id]] : []),
    ]);
    const body = TOOL_SECTIONS.map((heading) => `## ${heading}\n\n${String(sections[heading] ?? "").trim()}\n`).join("\n");
    return frontmatter + body;
  }

  function itemFrom(text, filePath) {
    const { frontmatter, body } = parseFrontmatterTyped(text);
    return {
      id: unquote(frontmatter.id) || path.basename(filePath, path.extname(filePath)),
      layer: frontmatter.layer,
      tool_name: frontmatter.tool_name ?? "",
      kind: frontmatter.kind ?? "tool",
      env: frontmatter.env ?? "",
      verified_at: frontmatter.verified_at ?? null,
      status: frontmatter.status ?? "active",
      superseded_by: frontmatter.superseded_by ?? null,
      confidence: frontmatter.confidence ?? "medium",
      evidence_refs: Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs : [],
      container: frontmatter.container ?? "tool",
      visibility: frontmatter.visibility ?? "platform",
      framework_id: frontmatter.framework_id ?? null,
      group_id: frontmatter.group_id ?? null,
      user_id: frontmatter.user_id ?? null,
      agent_id: frontmatter.agent_id ?? null,
      role_id: frontmatter.role_id ?? null,
      sections: parseSections(body, TOOL_SECTIONS),
      path: filePath,
    };
  }

  async function putToolNote(payload = {}) {
    const tool_name = String(payload.tool_name ?? "").trim();
    if (!tool_name) throw new Error("tool_name is required");
    const kind = payload.kind ?? "tool";
    if (!KINDS.has(kind)) throw new Error(`kind must be one of ${[...KINDS].join("|")}`);
    const env = String(payload.env ?? "win-local").trim() || "win-local";
    const sections = payload.sections ?? payload;
    validateSections(sections);
    const evidence_refs = requireEvidenceRefs(payload.evidence_refs);
    // WRITE-DENY-1-REJECT2（裁决1）：**不许静默降级**。
    // 工具记忆的写入目标（container=tool）只有 platform —— 若调用方要求别的可见性，
    // 必须显式拒绝；旧实现（`principal?.visibility ?? "platform"`）会把 private 静默落成
    // platform，调用方以为"写成功且私有"，实际全组可读。静默降级比没关更危险。
    const honored = containerDefaultVisibility("tool");
    const requestedRaw = payload.visibility ?? payload.principal?.visibility ?? null;
    const requested = requestedRaw === null || requestedRaw === undefined ? null : String(requestedRaw).trim().replace(/^["']|["']$/g, "");
    if (requested !== null && requested !== "" && requested !== honored) {
      throw Object.assign(
        new Error(`VISIBILITY_NOT_HONORED: tools-memory can only store visibility "${honored}", but "${requested}" was requested — refusing instead of silently downgrading`),
        { status: 403, code: "WRITE_SCOPE_DENIED", detail: "WRITE_SPACE_UNSUPPORTED" },
      );
    }
    const verified_at = payload.verified_at ?? new Date().toISOString();
    const id = `tool-${slugify(tool_name)}`;
    const filePath = path.join(root, `${slugify(tool_name)}.md`);
    const content = renderTool({
      id,
      tool_name,
      kind,
      env,
      verified_at,
      status: payload.status ?? "active",
      superseded_by: payload.superseded_by ?? null,
      confidence: payload.confidence ?? "medium",
      evidence_refs,
      principal: payload.principal,
      sections,
    });
    await atomicWrite(filePath, content);
    return { id, tool_name, kind, env, verified_at, status: payload.status ?? "active", path: filePath, merged: true };
  }

  async function listTools({ env = null, principal = null } = {}) {
    // VISIBILITY-FIX-1：拿不到身份 ⇒ 拒绝（此前跳过判定 ⇒ 无身份时返回全部工具记忆）
    requirePrincipal(principal, "toolsMemory.listTools");
    const files = await walkFiles(root);
    const items = [];
    for (const filePath of files) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const item = itemFrom(text, filePath);
      if (env && item.env !== env) continue;
      if (!principalAllowsContainer(principal, { ...item, container: "tool", visibility: item.visibility ?? "platform" })) continue;
      items.push(item);
    }
    return items.sort((a, b) => String(a.tool_name).localeCompare(String(b.tool_name)));
  }

  async function getTool(tool_name, principal = null) {
    const slug = slugify(tool_name);
    const files = await walkFiles(root);
    for (const filePath of files) {
      if (path.basename(filePath, path.extname(filePath)) !== slug) continue;
      const text = await readTextFile(filePath);
      if (!text) return null;
      const item = itemFrom(text, filePath);
      return principal && !principalAllowsContainer(principal, { ...item, container: "tool", visibility: item.visibility ?? "platform" }) ? null : item;
    }
    return null;
  }

  // verified_at 超 90 天 -> status=needs-review（重写文件，不删除）。
  // WRITE-DENY-1-REJECT1（F3）：这是**平台级**写入（工具记忆一律 platform）。入口必须要求 admin；
  // 这里再做一层逐条兜底：给了 principal 时，按该记录真实的可见性复核，判不过就跳过不写。
  async function refreshStatus({ principal = null } = {}) {
    const files = await walkFiles(root);
    const changed = [];
    const skipped = [];
    for (const filePath of files) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const item = itemFrom(text, filePath);
      if (item.status !== "active" || !item.verified_at) continue;
      const ms = Date.parse(String(item.verified_at));
      if (!Number.isFinite(ms)) continue;
      if (Date.now() - ms <= REVIEW_AFTER_MS) continue;
      if (principal && !principalAllowsContainer(principal, { ...item, container: "tool", visibility: item.visibility ?? containerDefaultVisibility("tool") })) {
        skipped.push({ tool_name: item.tool_name, path: filePath, reason: "VISIBILITY_DENIED" });
        continue;
      }
      const { frontmatter, body } = parseFrontmatterTyped(text);
      const updates = {
        container: JSON.stringify(frontmatter.container ?? "tool"),
        tenant_id: JSON.stringify(frontmatter.tenant_id ?? "default"),
        status: JSON.stringify("needs-review"),
      };
      await atomicWrite(filePath, updateFrontmatterFields(text, updates));
      changed.push({ tool_name: item.tool_name, status: "needs-review", path: filePath });
    }
    return { refreshed: changed.length, items: changed, skipped };
  }

  return { putToolNote, listTools, getTool, refreshStatus, root };
}
