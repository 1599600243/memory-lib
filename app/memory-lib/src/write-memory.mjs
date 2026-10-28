import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { renderFrontmatter, parseFrontmatterTyped, updateFrontmatterFields } from "./frontmatter-util.mjs";
import { requireEvidenceRefs } from "./write-validation.mjs";
import { normalizeContainer, principalIdentity, safeTemporaryKey } from "./container-policy.mjs";
import { createGraphStore } from "./graph-retrieval.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export const WRITE_LAYERS = Object.freeze([
  "curated-shared", "agent", "project-state", "project-decision", "project-progress",
  "tool", "plan", "profile", "document",
]);
export const DEFAULT_PROGRESS_TOPICS = Object.freeze(["目标与范围", "进展", "关键决定", "未决与风险", "环境与运行", "踩坑与教训"]);

function safeSegment(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 180 || /[\\/\0\r\n]/u.test(text) || text === "." || text === "..") throw new Error(`${label} is invalid`);
  return text;
}
function safeId(value, fallback = "memory") {
  const text = String(value ?? "").trim();
  if (!text) return `${fallback}-${crypto.randomUUID()}`;
  if (text.length > 180 || /[\\/\0\r\n]/u.test(text) || text === "." || text === "..") throw new Error("id is invalid");
  return text;
}
function isoDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return new Date().toISOString().slice(0, 10);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("occurred_at is invalid");
  return date.toISOString().slice(0, 10);
}
async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }
async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
function cleanBody(body) {
  const text = String(body ?? "").trim();
  if (!text) throw new Error("body is required");
  return text.endsWith("\n") ? text : `${text}\n`;
}
// REFINE-LOOP-2：`calendarDate` 是"这条记忆讲的是哪一天的事"，由写入方按**事件日**给出
// （提炼侧从证据的 calendarDate 取）。只在给了合法 YYYY-MM-DD 时才写这一行；
// 既有调用方不传 ⇒ 文件字节完全不变（不新增 `calendarDate: null`）。
function calendarDateValue(value) {
  const day = String(value ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}
function jsonArray(value) { return Array.isArray(value) ? [...new Set(value.map(String).map((x) => x.trim()).filter(Boolean))] : []; }
function temporalTimestamp(value, fallback = new Date().toISOString()) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("valid_from/valid_to is invalid");
  return date.toISOString();
}
function temporalOptional(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("valid_from/valid_to is invalid");
  return date.toISOString();
}
// 可见性的**默认值**只由 container 决定 —— 全仓库只有这一条规则（写侧 baseFrontmatter 与
// 读侧的兜底都读它）。抽成导出函数是为了让"这条结论最终会写成什么"只有一个真值源：
// 提炼提交的写授权（localhost-server 的 conclusionWriteTarget）也读它，不另立一条口径。
export function containerDefaultVisibility(container) {
  return container === "project" ? "project" : container === "tool" || container === "knowledge" ? "platform" : container === "role" ? "role" : "private";
}

function baseFrontmatter(input, layer, type, id, extra = []) {
  const principal = principalIdentity(input.principal);
  const container = normalizeContainer(input.container ?? layer) ?? layer;
  const visibility = input.visibility ?? containerDefaultVisibility(container);
  return renderFrontmatter([
    ["id", id], ["layer", layer], ["container", container], ["visibility", visibility], ["type", type], ["status", input.status ?? "active"],
    ["occurred_at", input.occurred_at ?? new Date().toISOString()],
    ["valid_from", temporalTimestamp(input.valid_from)],
    ["valid_to", temporalOptional(input.valid_to)],
    ...(calendarDateValue(input.calendarDate) ? [["calendarDate", calendarDateValue(input.calendarDate)]] : []),
    ["superseded_by", input.superseded_by ?? null],
    ["supersedes", jsonArray(input.supersedes)],
    // MEMORY-LOOP-1 切片4：stable_key 是"这条记忆代表的是同一件事"的稳定标识（不是版本号，也不是 id）。
    // 它落在 frontmatter 里，写入侧据此做**确定性**的同键冲突判定（见 findActiveByStableKey）；
    // 没有键的记忆照旧写 `stable_key: null`，既有文件与既有调用方零影响。
    ["stable_key", stableKeyValue(input.stable_key)],
    ["updated_at", new Date().toISOString()],
    ["tags", jsonArray(input.tags)], ["evidence_refs", requireEvidenceRefs(input.evidence_refs)],
    ["tenant_id", principal.tenant_id ?? "default"], ["framework_id", principal.framework_id], ["group_id", principal.group_id], ["user_id", principal.user_id], ["agent_id", principal.agent_id], ["role_id", principal.role_id],
    ["owned_by_account", input.owned_by_account ?? null], ["runs_on_machine", input.runs_on_machine ?? null],
    ...extra,
  ]);
}

// stable_key 的规范化：只接受非空字符串；值一律 JSON 编码（换行/引号会被转义，不会破坏 frontmatter）。
function stableKeyValue(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

// 每一层的记忆都住在一个**固定目录**里（按 layer + 项目/角色作用域决定）。写路径与
// "按 stable_key 找同键记忆"共用这一处，避免两套路径规则各自漂移。
function layerDirectory(dataRoot, input, layer) {
  if (layer === "curated-shared") return path.join(dataRoot, "curated", "shared");
  if (layer === "agent") return path.join(dataRoot, "curated", "agents", safeSegment(principalIdentity(input.principal).agent_id, "principal.agent_id"));
  if (layer === "project-state") return path.join(dataRoot, "project-state", safeSegment(input.project, "project"));
  if (layer === "project-decision") return path.join(dataRoot, "project-state", safeSegment(input.project, "project"), "decisions");
  if (layer === "tool") return path.join(dataRoot, "tools-memory");
  if (layer === "plan") return path.join(dataRoot, "plans");
  if (layer === "profile") return path.join(dataRoot, "profile");
  if (layer === "document") return path.join(dataRoot, "evidence", "documents");
  return null;
}

// 一层的文件目标路径：project-state 是"一个项目一份 current-state.md"（既有语义），其余是一条一文件。
function layerFilePath(dataRoot, input, layer, id) {
  const directory = layerDirectory(dataRoot, input, layer);
  if (!directory) return null;
  return layer === "project-state" ? path.join(directory, "current-state.md") : path.join(directory, `${id}.md`);
}

function frontmatterFor(input, layer, id) {
  if (layer === "curated-shared") return baseFrontmatter(input, "long-term", "memory", id, [["kind", input.kind ?? "fact"]]);
  if (layer === "agent") return baseFrontmatter(input, "role", "memory", id);
  if (layer === "project-state") return baseFrontmatter(input, "project", "state", id, [["project", safeSegment(input.project, "project")]]);
  if (layer === "project-decision") return baseFrontmatter(input, "project", "decision", id, [["project", safeSegment(input.project, "project")]]);
  if (layer === "tool") return baseFrontmatter(input, "tool", "memory", id);
  if (layer === "plan") return baseFrontmatter(input, "plan", "memory", id);
  if (layer === "profile") return baseFrontmatter(input, "profile", "memory", id);
  if (layer === "document") return baseFrontmatter(input, "document", "document", id);
  return null;
}

function parseProgress(text) {
  const parsed = parseFrontmatterTyped(text);
  const topics = [...DEFAULT_PROGRESS_TOPICS];
  if (Array.isArray(parsed.frontmatter.topics)) {
    for (const topic of parsed.frontmatter.topics.map(String)) if (!topics.includes(topic)) topics.push(topic);
  }
  const sections = new Map(topics.map((topic) => [topic, []]));
  let current = null;
  for (const line of parsed.body.split(/\r?\n/u)) {
    const heading = line.match(/^##\s+(.+)$/u);
    if (heading) { current = heading[1].trim(); if (!sections.has(current)) sections.set(current, []); continue; }
    const match = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+?)(?:\s+\[refs:\s*([^\]]*)\])?\s*$/u);
    if (current && match) sections.get(current).push({ date: match[1], text: match[2].trim(), refs: jsonArray(match[3] ? match[3].split(",") : []) });
  }
  return { topics, sections };
}
function renderProgress(project, topics, sections, priorText = "", principal = null) {
  const identity = principalIdentity(principal);
  const tenantId = identity.tenant_id ?? "default";
  const updated = { layer: "project", type: "progress", project: JSON.stringify(project), updated_at: JSON.stringify(new Date().toISOString()), topics: JSON.stringify(topics), container: "project", tenant_id: JSON.stringify(tenantId), visibility: JSON.stringify("project"), group_id: JSON.stringify(identity.group_id), user_id: JSON.stringify(identity.user_id), agent_id: JSON.stringify(identity.agent_id), role_id: JSON.stringify(identity.role_id) };
  const parsed = parseFrontmatterTyped(priorText);
  const header = parsed.frontmatter && Object.keys(parsed.frontmatter).length
    ? (updateFrontmatterFields(priorText, updated).match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u)?.[0] ?? "")
    : `---\nlayer: project\ncontainer: project\ntenant_id: ${updated.tenant_id}\nvisibility: ${updated.visibility}\ngroup_id: ${updated.group_id}\nuser_id: ${updated.user_id}\nagent_id: ${updated.agent_id}\nrole_id: ${updated.role_id}\ntype: progress\nproject: ${updated.project}\nupdated_at: ${updated.updated_at}\ntopics: ${updated.topics}\n---\n`;
  const lines = [header.trimEnd(), "", `# 项目进度 · ${project}`, ""];
  for (const topic of topics) {
    lines.push(`## ${topic}`, "");
    const entries = [...(sections.get(topic) ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text));
    for (const entry of entries) lines.push(`- ${entry.date} · ${entry.text}${entry.refs.length ? ` [refs: ${entry.refs.join(", ")}]` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
function entryKey(entry) { return `${entry.date}\0${entry.text}`; }

export function createMemoryWriter({ dataRoot, onIndexed = null, graphStore = null } = {}) {
  if (!dataRoot) throw new Error("memory writer requires dataRoot");
  graphStore ??= createGraphStore({ dataRoot });
  const progressLocks = new Map();
  const temporary = new Map();
  async function putTemporary({ key, body, ttlMs = 15 * 60_000, principal = null, container = "temporary" } = {}) {
    if (normalizeContainer(container) !== "temporary") throw new Error("temporary writes require the temporary container");
    const safeKey = safeTemporaryKey(key);
    const text = cleanBody(body);
    const ttl = Math.max(1, Math.min(24 * 60 * 60_000, Number(ttlMs) || 15 * 60_000));
    temporary.set(safeKey, { key: safeKey, body: text, principal: principalIdentity(principal), expiresAt: Date.now() + ttl });
    return { ok: true, key: safeKey, container: "temporary", expires_at: new Date(Date.now() + ttl).toISOString(), searchable: false, durable: false };
  }
  function purgeTemporary(now = Date.now()) {
    let removed = 0;
    for (const [key, item] of temporary) if (item.expiresAt <= now) { temporary.delete(key); removed += 1; }
    return { removed, remaining: temporary.size };
  }
  async function getTemporary(key, principal = null) {
    purgeTemporary();
    const item = temporary.get(safeTemporaryKey(key));
    if (!item) return null;
    const p = principalIdentity(principal);
    if (item.principal.role_id && item.principal.role_id !== p.role_id) return null;
    return { ...item, expiresAt: new Date(item.expiresAt).toISOString() };
  }
  async function clearTemporary(key) { temporary.delete(safeTemporaryKey(key)); return { ok: true }; }
  async function promoteTemporary(key, target, input = {}) {
    const item = await getTemporary(key, input.principal);
    if (!item) throw new Error("temporary item not found or not authorized");
    if (normalizeContainer(target) === "temporary") throw new Error("temporary promotion target must be durable");
    const result = await write({ ...input, layer: target, body: item.body, principal: input.principal });
    await clearTemporary(key);
    return { ...result, promoted_from: item.key };
  }
  async function withProgressLock(filePath, fn) {
    const previous = progressLocks.get(filePath) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    progressLocks.set(filePath, current);
    await previous;
    try { return await fn(); } finally { release(); if (progressLocks.get(filePath) === current) progressLocks.delete(filePath); }
  }
  async function write(input = {}) {
    const layer = String(input.layer ?? "");
    input = { ...input, evidence_refs: requireEvidenceRefs(input.evidence_refs) };
    if (!WRITE_LAYERS.includes(layer)) throw new Error(`layer must be one of: ${WRITE_LAYERS.join(", ")}`);
    if (layer === "project-progress") return writeProgress(input);
    const body = cleanBody(input.body);
    const id = safeId(input.id, layer);
    let filePath = layerFilePath(dataRoot, input, layer, id);
    const fm = frontmatterFor(input, layer, id);
    if (layer === "project-decision" && await exists(filePath)) {
      const parsed = path.parse(filePath); let n = 1;
      while (await exists(filePath)) filePath = path.join(parsed.dir, `${parsed.name}-${n++}${parsed.ext}`);
    }
    const updated = layer !== "project-decision" && await exists(filePath);
    await atomicWrite(filePath, fm + "\n" + body);
    if (graphStore && (layer === "project-state" || layer === "project-decision" || layer === "project-progress" || input.owned_by_account || input.runs_on_machine)) {
      const principal = principalIdentity(input.principal);
      const refs = requireEvidenceRefs(input.evidence_refs);
      const project = input.project ? `project:${input.project}` : null;
      const events = [];
      if (project) events.push({ event_id: `memory.created:${layer}:${id}`, type: "project.linked", tenant_id: principal.tenant_id ?? "default", evidence_id: refs[0], payload: { src_id: project, predicate: "belongs_to_project", dst_id: id, visibility: input.visibility ?? "project", group_id: principal.group_id, user_id: principal.user_id, agent_id: principal.agent_id, role_id: principal.role_id, container: "project", project: input.project } });
      for (const relation of [["owned_by_account", input.owned_by_account], ["runs_on_machine", input.runs_on_machine]]) if (relation[1]) {
        const relationContainer = layer === "tool" ? "tool" : layer === "document" ? "knowledge" : "project";
        const relationVisibility = input.visibility ?? (relationContainer === "tool" || relationContainer === "knowledge" ? "platform" : "project");
        events.push({ event_id: `memory.created:${layer}:${id}:${relation[0]}`, type: "memory.created", tenant_id: principal.tenant_id ?? "default", evidence_id: refs[0], payload: { src_id: id, predicate: relation[0], dst_id: String(relation[1]), visibility: relationVisibility, group_id: principal.group_id, user_id: principal.user_id, agent_id: principal.agent_id, role_id: principal.role_id, container: relationContainer, project: input.project ?? null } });
      }
      if (events.length) {
        try { await graphStore.ingestMany(events); }
        catch (error) { if (!String(error.message).startsWith("evidence not found:")) throw error; }
      }
    }
    const indexed = input._deferIndex ? null : await onIndexed?.(filePath, { layer, id });
    return { ok: true, id, layer, path: filePath, [updated ? "updated" : "created"]: true, chars: body.length, indexed_pending: indexed?.pendingChanges ?? indexed?.pending ?? 0 };
  }
  async function findById(id) {
    const target = String(id ?? "").trim();
    if (!target) return null;
    const roots = ["curated/shared", "curated/agents", "project-state", "tools-memory", "plans", "profile", "evidence/documents"];
    for (const relative of roots) {
      const stack = [path.join(dataRoot, relative)];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
          const filePath = path.join(current, entry.name);
          if (entry.isDirectory()) { stack.push(filePath); continue; }
          if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
          const text = await fs.readFile(filePath, "utf8").catch(() => null);
          if (text && String(parseFrontmatterTyped(text).frontmatter.id ?? "") === target) return { path: filePath, text };
        }
      }
    }
    return null;
  }
  async function supersede({ oldId, ...input } = {}) {
    const old = await findById(oldId);
    if (!old) throw new Error("superseded memory not found");
    const oldFrontmatter = parseFrontmatterTyped(old.text).frontmatter;
    const oldLayer = oldFrontmatter.layer === "long-term" ? "curated-shared" : oldFrontmatter.layer === "role" ? "agent" : oldFrontmatter.layer;
    const inheritedLayer = input.layer ?? oldLayer;
    const inheritedVisibility = input.visibility ?? oldFrontmatter.visibility;
    const newInputDefaults = { layer: inheritedLayer, visibility: inheritedVisibility };
    const validFrom = temporalTimestamp(input.valid_from);
    if (oldFrontmatter.valid_to && new Date(String(oldFrontmatter.valid_to)).getTime() <= new Date(validFrom).getTime()) throw new Error("old memory is already closed");
    const newInput = { ...newInputDefaults, ...input, supersedes: [oldId, ...(Array.isArray(input.supersedes) ? input.supersedes : [])], valid_from: validFrom };
    if (await findById(newInput.id)) throw new Error("new superseding memory id already exists");
    let created;
    try {
      created = await write({ ...newInput, _deferIndex: true });
      // MEMORY-LOOP-1 切片4：project-state 是"一个项目一份 current-state.md"（既有语义），
      // 新旧两版**物理上住同一个文件**。那种层上做取代只会把两份内容互相覆盖（旧版会把新版盖掉），
      // 所以这里按"什么都没变"拒绝 —— 抛出后由下面的 catch 还原旧文件，绝不留下半份内容。
      if (created.path === old.path) throw new Error("SUPERSEDE_SAME_FILE: this layer keeps one file per project, so the old and the new memory cannot coexist; nothing was changed");
      const updatedOld = updateFrontmatterFields(old.text, {
        valid_to: JSON.stringify(validFrom),
        superseded_by: JSON.stringify(created.id ?? input.id),
        status: JSON.stringify("superseded"),
        updated_at: JSON.stringify(new Date().toISOString()),
      });
      await atomicWrite(old.path, updatedOld);
      await onIndexed?.(created.path, { layer: "supersede", id: created.id ?? input.id });
      await onIndexed?.(old.path, { layer: "supersede", id: oldId });
      return { ok: true, old: { id: oldId, path: old.path }, new: { ...created, id: created.id ?? input.id } };
    } catch (error) {
      if (created?.path) await fs.rm(created.path, { force: true }).catch(() => {});
      await atomicWrite(old.path, old.text).catch(() => {});
      throw error;
    }
  }
  // ---------------------------------------------------------------------------
  // MEMORY-LOOP-1 切片4：stable_key 冲突与取代的写入侧原语（供提炼提交入口复用）。
  //
  // findActiveByStableKey —— 在**写入作用域**内确定性地找一个 active、同键的记忆：
  //   作用域 = (layer, project, tenant_id, group_id, user_id)。刻意**不含** agent_id/role_id：
  //   同一个用户的不同角色看到的是同一件事，应该照样合并/要求取代，而不是各写一条 active 版本。
  //   跨组/跨用户/跨项目/跨层 ⇒ 找不到（多租户要求：同键不许跨作用域互撞）。
  //   只扫该层自己的那个目录（非递归），所以 project-state 与 project-decision 不会互相误判。
  //   排序确定：updated_at 降序、再按路径升序取第一条（正常情况下只可能有一条）。
  //   这里**不做可见性判断**（那是检索侧唯一一份判据，本模块不复制、不改）——
  //   调用方拿到 id 后要自己用请求作用域的库实例确认"当前 principal 读得到它"。
  async function findActiveByStableKey({ stable_key = null, layer = null, project = null, principal = null } = {}) {
    const key = String(stable_key ?? "").trim();
    if (!key) return { found: false, reason: "NO_STABLE_KEY" };
    const directory = layerDirectory(dataRoot, { project, principal }, layer);
    if (!directory) return { found: false, reason: "UNSUPPORTED_LAYER" };
    const identity = principalIdentity(principal);
    const expected = {
      tenant_id: String(identity.tenant_id ?? "default"),
      group_id: String(identity.group_id ?? ""),
      user_id: String(identity.user_id ?? ""),
    };
    const candidates = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      const filePath = path.join(directory, entry.name);
      const fileText = await fs.readFile(filePath, "utf8").catch(() => null);
      if (!fileText) continue;
      const parsed = parseFrontmatterTyped(fileText);
      const frontmatter = parsed.frontmatter;
      if (String(frontmatter.stable_key ?? "").trim() !== key) continue;
      if (String(frontmatter.status ?? "active").trim().toLowerCase() !== "active") continue;
      if (String(frontmatter.tenant_id ?? "default") !== expected.tenant_id) continue;
      if (String(frontmatter.group_id ?? "") !== expected.group_id) continue;
      if (String(frontmatter.user_id ?? "") !== expected.user_id) continue;
      if (project !== null && project !== undefined && String(frontmatter.project ?? "") !== String(project)) continue;
      candidates.push({ id: String(frontmatter.id ?? path.basename(filePath, path.extname(filePath))), path: filePath, frontmatter, body: parsed.body });
    }
    if (!candidates.length) return { found: false };
    candidates.sort((a, b) => (Date.parse(String(b.frontmatter.updated_at ?? "")) || 0) - (Date.parse(String(a.frontmatter.updated_at ?? "")) || 0) || a.path.localeCompare(b.path));
    return { found: true, ...candidates[0] };
  }

  // mergeEvidenceRefs —— 同键同体时"只刷新证据、不产生第二个文件/版本"：
  //   保留 id、正文、stable_key、occurred_at、valid_from；evidence_refs 取并集（先有后加，去重）；
  //   刷新 updated_at。原子重写同一个文件，写完立刻刷新派生索引（与 write 同一套）。
  async function mergeEvidenceRefs({ filePath = null, evidence_refs = [] } = {}) {
    const target = String(filePath ?? "").trim();
    if (!target) throw new Error("merge requires the existing memory file path");
    const refs = requireEvidenceRefs(evidence_refs);
    const before = await fs.readFile(target, "utf8");
    const parsed = parseFrontmatterTyped(before);
    const existing = Array.isArray(parsed.frontmatter.evidence_refs) ? parsed.frontmatter.evidence_refs.map(String) : [];
    const mergedRefs = [...new Set([...existing, ...refs])];
    const updatedAt = new Date().toISOString();
    const next = updateFrontmatterFields(before, { evidence_refs: JSON.stringify(mergedRefs), updated_at: JSON.stringify(updatedAt) });
    await atomicWrite(target, next);
    const id = String(parsed.frontmatter.id ?? path.basename(target, path.extname(target)));
    await onIndexed?.(target, { layer: "merge", id });
    return { ok: true, id, path: target, evidence_refs: mergedRefs, updated_at: updatedAt };
  }

  // "这一层、这个 id 会写到哪个文件" —— 给上游做"同文件取代"的**写前**判定用（不落盘）。
  function targetPathFor({ layer = null, id = null, project = null, principal = null } = {}) {
    const safeLayer = String(layer ?? "");
    if (!WRITE_LAYERS.includes(safeLayer) || safeLayer === "project-progress") return null;
    return layerFilePath(dataRoot, { project, principal }, safeLayer, safeId(id, safeLayer));
  }

  async function writeProgress(input = {}) {
    input = { ...input, evidence_refs: requireEvidenceRefs(input.evidence_refs) };
    const project = safeSegment(input.project, "project");
    if (!Array.isArray(input.entries) || !input.entries.length) throw new Error("entries are required");
    const filePath = path.join(dataRoot, "project-state", project, "progress.md");
    return withProgressLock(filePath, async () => {
      const old = await fs.readFile(filePath, "utf8").catch(() => "");
      const parsed = parseProgress(old); const byTopic = new Map();
      for (const topic of parsed.topics) { byTopic.set(topic, new Map((parsed.sections.get(topic) ?? []).map((entry) => [entryKey(entry), entry]))); }
      let added = 0; let deduped = 0; const perTopic = Object.fromEntries(parsed.topics.map((topic) => [topic, 0]));
      for (const entry of input.entries) {
        const topic = String(entry?.topic ?? "").trim();
        if (!parsed.topics.includes(topic)) throw new Error(`unknown progress topic: ${topic}`);
        const date = isoDate(entry?.at); const text = String(entry?.text ?? "").trim().replace(/[\r\n]+/gu, " ");
        if (!text) throw new Error("progress entry text is required");
        const refs = jsonArray([...(Array.isArray(input.evidence_refs) ? input.evidence_refs : []), ...(Array.isArray(entry?.refs) ? entry.refs : [])]);
        const key = `${date}\0${text}`; const bucket = byTopic.get(topic); const prior = bucket.get(key);
        if (prior) { prior.refs = jsonArray([...(prior.refs ?? []), ...refs]); deduped += 1; }
        else { bucket.set(key, { date, text, refs }); perTopic[topic] += 1; added += 1; }
      }
      const sections = new Map(parsed.topics.map((topic) => [topic, [...byTopic.get(topic).values()]]));
      await atomicWrite(filePath, renderProgress(project, parsed.topics, sections, old, input.principal));
      const principal = principalIdentity(input.principal);
      try {
        await graphStore.ingest({ event_id: `memory.created:project-progress:${project}`, type: "project.linked", tenant_id: principal.tenant_id ?? "default", evidence_id: input.evidence_refs[0], payload: { src_id: `project:${project}`, predicate: "belongs_to_project", dst_id: `progress:${project}`, visibility: "project", group_id: principal.group_id, user_id: principal.user_id, agent_id: principal.agent_id, role_id: principal.role_id, container: "project", project } });
      } catch (error) { if (!String(error.message).startsWith("evidence not found:")) throw error; }
      const indexed = await onIndexed?.(filePath, { layer: "project-progress", project });
      return { ok: true, layer: "project-progress", path: filePath, added, deduped, per_topic: perTopic, indexed_pending: indexed?.pendingChanges ?? indexed?.pending ?? 0 };
    });
  }
  return { write, writeProgress, supersede, findActiveByStableKey, mergeEvidenceRefs, targetPathFor, putTemporary, getTemporary, clearTemporary, purgeTemporary, promoteTemporary };
}
