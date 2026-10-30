// memory-lib D2.2 — 项目记忆 `project-state/<project>/`。
// current-state.md（覆盖式，四段：目标/当前进展/下一步/阻塞）
// decisions/<YYYY-MM-DD>-<slug>.md（追加式，三段：决定/理由/影响）。
// 旧物（openclaw 347 条）不被触碰：本模块只读写带 layer: project 的 current-state/decision 文件。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readTextFile } from "./read-only-core.mjs";
import { parseFrontmatterTyped, renderFrontmatter, parseSections, slugify, unquote } from "./frontmatter-util.mjs";
import { requireEvidenceRefs } from "./write-validation.mjs";
import { principalAllowsContainer, principalIdentity } from "./container-policy.mjs";
import { requirePrincipal } from "./identity-guard.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const STATE_SECTIONS = ["目标", "当前进展", "下一步", "阻塞"];
export const DECISION_SECTIONS = ["决定", "理由", "影响"];
export const PROGRESS_TOPICS = ["目标与范围", "进展", "关键决定", "未决与风险", "环境与运行", "踩坑与教训"];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function createProjectMemory({ dataRoot, graphStore = null } = {}) {
  if (!dataRoot) throw new Error("project-memory: dataRoot is required");
  const projectRoot = path.join(dataRoot, "project-state");

  async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }

  function validateSections(sections, headings, label) {
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      throw new Error(`${label} sections are required (an object mapping each heading to text)`);
    }
    for (const heading of headings) {
      const content = String(sections[heading] ?? "").trim();
      if (!content) throw new Error(`${label} section "${heading}" is required and must not be empty`);
    }
  }

  function projectDir(project) {
    return path.join(projectRoot, slugify(project));
  }

  async function putCurrentState({ project, sections, updated_at = null, status = "active", evidence_refs = [], principal = null } = {}) {
    const name = String(project ?? "").trim();
    if (!name) throw new Error("project is required");
    validateSections(sections, STATE_SECTIONS, "current-state");
    evidence_refs = requireEvidenceRefs(evidence_refs);
    const updatedAt = updated_at ?? new Date().toISOString();
    const id = `project-${slugify(name)}-state`;
    const frontmatter = renderFrontmatter([
      ["id", id],
      ["layer", "project"],
      ["container", "project"],
      ["tenant_id", principal?.tenant_id ?? "default"],
      ["visibility", principal?.visibility ?? "project"],
      ["kind", "current-state"],
      ["project", name],
      ["updated_at", updatedAt],
      ["status", status ?? "active"],
      ["evidence_refs", Array.isArray(evidence_refs) ? evidence_refs : []],
      ...(principal ? [["framework_id", principal.framework_id], ["group_id", principal.group_id ?? null], ["user_id", principal.user_id ?? null], ["agent_id", principal.agent_id], ["role_id", principal.role_id]] : []),
    ]);
    const body = STATE_SECTIONS.map((heading) => `## ${heading}\n\n${String(sections[heading] ?? "").trim()}\n`).join("\n");
    const filePath = path.join(projectDir(name), "current-state.md");
    await atomicWrite(filePath, frontmatter + body);
    if (graphStore) {
      const p = principalIdentity(principal);
      try { await graphStore.ingest({ event_id: `project.state:${id}`, type: "project.linked", tenant_id: p.tenant_id ?? "default", evidence_id: evidence_refs[0], payload: { src_id: `project:${name}`, predicate: "belongs_to_project", dst_id: id, visibility: principal?.visibility ?? "project", group_id: p.group_id, user_id: p.user_id, agent_id: p.agent_id, role_id: p.role_id, container: "project", project: name } }); }
      catch (error) { if (!String(error.message).startsWith("evidence not found:")) throw error; }
    }
    return { id, project: name, kind: "current-state", updated_at: updatedAt, path: filePath };
  }

  async function appendDecision({ project, slug = null, sections, occurred_at = null, supersedes = null, evidence_refs = [], principal = null } = {}) {
    const name = String(project ?? "").trim();
    if (!name) throw new Error("project is required");
    validateSections(sections, DECISION_SECTIONS, "decision");
    evidence_refs = requireEvidenceRefs(evidence_refs);
    const occurredAt = occurred_at ?? new Date().toISOString();
    const day = String(occurredAt).slice(0, 10);
    const fileSlug = slug ? slugify(slug) : slugify(String(sections["决定"] ?? "").slice(0, 32));
    const filePath = path.join(projectDir(name), "decisions", `${day}-${fileSlug}.md`);
    // 追加式：同名 slug 追加序号，避免覆盖已有决策（不可变）。
    let finalPath = filePath;
    let n = 1;
    while (await fs.access(finalPath).then(() => true).catch(() => false)) {
      finalPath = path.join(projectDir(name), "decisions", `${day}-${fileSlug}-${n}.md`);
      n += 1;
    }
    const id = `decision-${slugify(name)}-${day}-${fileSlug}${n > 1 ? `-${n - 1}` : ""}`;
    const frontmatter = renderFrontmatter([
      ["id", id],
      ["layer", "project"],
      ["container", "project"],
      ["tenant_id", principal?.tenant_id ?? "default"],
      ["visibility", principal?.visibility ?? "project"],
      ["kind", "decision"],
      ["project", name],
      ["occurred_at", occurredAt],
      ["supersedes", supersedes ?? null],
      ["evidence_refs", Array.isArray(evidence_refs) ? evidence_refs : []],
      ...(principal ? [["framework_id", principal.framework_id], ["group_id", principal.group_id ?? null], ["user_id", principal.user_id ?? null], ["agent_id", principal.agent_id], ["role_id", principal.role_id]] : []),
    ]);
    const body = DECISION_SECTIONS.map((heading) => `## ${heading}\n\n${String(sections[heading] ?? "").trim()}\n`).join("\n");
    await atomicWrite(finalPath, frontmatter + body);
    if (graphStore) {
      const p = principalIdentity(principal);
      try { await graphStore.ingest({ event_id: `project.decision:${id}`, type: "project.linked", tenant_id: p.tenant_id ?? "default", evidence_id: evidence_refs[0], payload: { src_id: `project:${name}`, predicate: "belongs_to_project", dst_id: id, visibility: principal?.visibility ?? "project", group_id: p.group_id, user_id: p.user_id, agent_id: p.agent_id, role_id: p.role_id, container: "project", project: name } }); }
      catch (error) { if (!String(error.message).startsWith("evidence not found:")) throw error; }
    }
    return { id, project: name, kind: "decision", occurred_at: occurredAt, path: finalPath };
  }

  // 列出有 layer: project 的 current-state.md / decisions 的项目名。
  async function listProjects(principal = null) {
    // VISIBILITY-FIX-1：拿不到身份 ⇒ 拒绝（此前跳过判定 ⇒ 无身份时列出全部项目）
    requirePrincipal(principal, "projectMemory.listProjects");
    const files = await walkFiles(projectRoot);
    const byProject = new Map();
    for (const filePath of files) {
      const rel = path.relative(projectRoot, filePath);
      const parts = rel.split(path.sep);
      if (parts.length < 2) continue;
      if (parts[0].startsWith("_")) continue; // 冻结区
      const project = parts[0];
      const text = await readTextFile(filePath);
      if (!text) continue;
      const { frontmatter } = parseFrontmatterTyped(text);
      if (frontmatter.layer !== "project") continue; // 只认本层；旧物（无 layer 或其它）不纳入
      if (!principalAllowsContainer(principal, { ...frontmatter, container: "project", project })) continue;
      if (!byProject.has(project)) byProject.set(project, { project, current_state: null, decisions: [], progress: null });
      const entry = byProject.get(project);
      if (frontmatter.kind === "current-state" || path.basename(filePath) === "current-state.md") {
        entry.current_state = { path: filePath, updated_at: frontmatter.updated_at ?? null, status: frontmatter.status ?? "active" };
      } else if (frontmatter.kind === "decision") {
        entry.decisions.push({ path: filePath, occurred_at: frontmatter.occurred_at ?? null, supersedes: frontmatter.supersedes ?? null });
       } else if (path.basename(filePath) === "progress.md") {
         entry.progress = { path: filePath, updated_at: frontmatter.updated_at ?? null };
      }
    }
    const out = [...byProject.values()];
    for (const entry of out) entry.decisions.sort((a, b) => String(a.occurred_at ?? "").localeCompare(String(b.occurred_at ?? "")));
    return out.sort((a, b) => a.project.localeCompare(b.project));
  }

  async function getProject(project, principal = null) {
    // VISIBILITY-FIX-1：拿不到身份 ⇒ 拒绝
    requirePrincipal(principal, "projectMemory.getProject");
    const name = String(project ?? "").trim();
    const files = await walkFiles(projectDir(name));
    const result = { project: name, current_state: null, decisions: [], progress: null };
    for (const filePath of files) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const { frontmatter, body } = parseFrontmatterTyped(text);
      if (!principalAllowsContainer(principal, { ...frontmatter, container: "project", project: name })) continue;
             const base = path.basename(filePath);
      if (base === "current-state.md") {
        result.current_state = { frontmatter, sections: parseSections(body, STATE_SECTIONS), path: filePath };
       } else if (base === "progress.md") {
         const headings = Array.isArray(frontmatter.topics) && frontmatter.topics.length ? frontmatter.topics : PROGRESS_TOPICS;
         result.progress = { frontmatter, topics: [...new Set([...PROGRESS_TOPICS, ...headings])], body, path: filePath };
      } else if (path.dirname(filePath).endsWith(path.join("decisions"))) {
        result.decisions.push({ frontmatter, sections: parseSections(body, DECISION_SECTIONS), path: filePath });
      }
    }
    result.decisions.sort((a, b) => String(a.frontmatter.occurred_at ?? "").localeCompare(String(b.frontmatter.occurred_at ?? "")));
    return result;
  }

  return { putCurrentState, appendDecision, listProjects, getProject, root: projectRoot, today };
}
