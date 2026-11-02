import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { indexPathFor, createIndexStore } from "./index-store.mjs";
import { memoryIndexSearch } from "./index-search.mjs";
import { resolveRootsForScopes, rootPaths } from "./scope-roots.mjs";
import { parseFrontmatterTyped } from "./frontmatter-util.mjs";
import { walkFiles } from "./read-only-core.mjs";
import { principalAllowsContainer } from "./container-policy.mjs";

export const GRAPH_PREDICATES = Object.freeze([
  "belongs_to_project", "owned_by_account", "runs_on_machine", "has_property",
  "mentions_entity", "derived_from", "related_to",
]);
const PREDICATE_SET = new Set(GRAPH_PREDICATES);
const EVENT_TYPES = new Set(["memory.created", "project.linked", "machine.property_set", "entity.linked", "edge.tombstoned"]);
const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_events (
  source_event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  tenant_id TEXT NOT NULL,
  src_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  confidence REAL NOT NULL,
  source_event_id TEXT NOT NULL,
  tombstoned_at TEXT,
  visibility TEXT,
  group_id TEXT,
  user_id TEXT,
  agent_id TEXT,
  role_id TEXT,
  container TEXT,
  project TEXT,
  PRIMARY KEY (tenant_id, src_id, predicate, dst_id),
  FOREIGN KEY (source_event_id) REFERENCES graph_events(source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_tenant_src ON edges(tenant_id, src_id, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_tenant_dst ON edges(tenant_id, dst_id, predicate);
CREATE INDEX IF NOT EXISTS idx_graph_events_tenant ON graph_events(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS project_state_events (
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  source_event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`;

function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 500) throw new Error(`${name} is required`);
  return text;
}
function iso(value, name) {
  const text = value == null ? new Date().toISOString() : String(value);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${name} is invalid`);
  return new Date(text).toISOString();
}
function safeConfidence(value) {
  const number = Number(value ?? 1);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error("confidence must be between 0 and 1");
  return number;
}
function eventId(value) { return requiredString(value, "event_id"); }
function eventLogPath(dataRoot) { return path.join(dataRoot, "runtime", "graph", "events.jsonl"); }
function graphDbPath(dataRoot) { return path.join(dataRoot, "indexes", "sqlite", "memory-graph-v2.sqlite"); }
function json(value) { return JSON.stringify(value); }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

async function findEvidence(dataRoot, evidenceId) {
  const roots = [path.join(dataRoot, "evidence"), path.join(dataRoot, "curated"), path.join(dataRoot, "project-state")];
  for (const root of roots) {
    for (const file of await walkFiles(root, [".md"])) {
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (!text) continue;
      const { frontmatter } = parseFrontmatterTyped(text);
      const refs = Array.isArray(frontmatter.evidence_refs) ? frontmatter.evidence_refs.map(String) : [];
      if (refs.includes(evidenceId) || String(frontmatter.id ?? "") === evidenceId || path.basename(file, ".md") === evidenceId) return file;
    }
  }
  return null;
}

function edgeFromEvent(event) {
  const payload = event.payload ?? {};
  const srcId = requiredString(payload.src_id, "payload.src_id");
  const dstId = requiredString(payload.dst_id, "payload.dst_id");
  const predicate = requiredString(payload.predicate, "payload.predicate");
  if (!PREDICATE_SET.has(predicate)) throw new Error(`predicate is not allowed: ${predicate}`);
  return {
    tenant_id: requiredString(event.tenant_id, "tenant_id"),
    src_id: srcId,
    predicate,
    dst_id: dstId,
    evidence_id: requiredString(event.evidence_id, "evidence_id"),
    created_at: iso(event.created_at, "created_at"),
    valid_from: payload.valid_from == null ? null : iso(payload.valid_from, "valid_from"),
    valid_to: payload.valid_to == null ? null : iso(payload.valid_to, "valid_to"),
    confidence: safeConfidence(payload.confidence),
    source_event_id: eventId(event.event_id),
    visibility: payload.visibility ?? null,
    group_id: payload.group_id ?? null,
    user_id: payload.user_id ?? null,
    agent_id: payload.agent_id ?? null,
    role_id: payload.role_id ?? null,
    container: payload.container ?? null,
    project: payload.project ?? null,
  };
}

function normalizeEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("event must be an object");
  const type = requiredString(input.type, "type");
  if (!EVENT_TYPES.has(type)) throw new Error(`event type is not allowed: ${type}`);
  const normalized = { ...input, type, event_id: eventId(input.event_id), tenant_id: requiredString(input.tenant_id, "tenant_id"), evidence_id: requiredString(input.evidence_id, "evidence_id"), created_at: iso(input.created_at, "created_at") };
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("payload must be an object");
  if (type !== "edge.tombstoned") edgeFromEvent(normalized);
  else {
    requiredString(input.payload.src_id, "payload.src_id");
    requiredString(input.payload.dst_id, "payload.dst_id");
    requiredString(input.payload.predicate, "payload.predicate");
    if (!PREDICATE_SET.has(input.payload.predicate)) throw new Error(`predicate is not allowed: ${input.payload.predicate}`);
  }
  return normalized;
}

async function appendEvent(dataRoot, event) {
  const file = eventLogPath(dataRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${json(event)}\n`, "utf8");
}

function openDb(dataRoot) {
  fsSync.mkdirSync(path.dirname(graphDbPath(dataRoot)), { recursive: true });
  const db = new DatabaseSync(graphDbPath(dataRoot));
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(GRAPH_SCHEMA);
  for (const column of ["visibility", "group_id", "user_id", "agent_id", "role_id", "container", "project"]) {
    try { db.exec(`ALTER TABLE edges ADD COLUMN ${column} TEXT`); } catch {}
  }
  return db;
}

function principalCanEdge(principal, edge) {
  if (!principal) return true;
  if (principal.tenant_id && String(principal.tenant_id) !== String(edge.tenant_id)) return false;
  // 旧边没有 container/visibility 列值时按"无额外限制"处理，避免历史数据被一律锁死
  if (!edge.container && !edge.visibility) return true;
  return principalAllowsContainer(principal, {
    container: edge.container ?? null,
    visibility: edge.visibility ?? null,
    group_id: edge.group_id ?? null,
    user_id: edge.user_id ?? null,
    agent_id: edge.agent_id ?? null,
    role_id: edge.role_id ?? null,
    project: edge.project ?? null,
  });
}

export function normalizeStructuredEvent(input) { return normalizeEvent(input); }

export function createGraphStore({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("graph store requires dataRoot");
  async function ingest(eventInput, { replay = false } = {}) {
    const event = normalizeEvent(eventInput);
    // replay 只用于重建：事件来自本地事件日志/本地 Markdown，不再要求证据文件仍存在
    if (!replay && !(await findEvidence(dataRoot, event.evidence_id))) throw new Error(`evidence not found: ${event.evidence_id}`);
    const db = openDb(dataRoot);
    try {
      db.exec("BEGIN IMMEDIATE");
      const prior = db.prepare("SELECT source_event_id FROM graph_events WHERE source_event_id=?").get(event.event_id);
      if (prior) { db.exec("COMMIT"); return { ok: true, duplicate: true, event_id: event.event_id, edges: 0 }; }
      db.prepare("INSERT INTO graph_events(source_event_id,tenant_id,event_type,event_json,evidence_id,created_at) VALUES(?,?,?,?,?,?)").run(event.event_id, event.tenant_id, event.type, json(event), event.evidence_id, event.created_at);
      if (event.payload.project_state) db.prepare("INSERT INTO project_state_events(tenant_id,project_id,state_json,source_event_id,created_at) VALUES(?,?,?,?,?)").run(event.tenant_id, requiredString(event.payload.project_id, "payload.project_id"), json(event.payload.project_state), event.event_id, event.created_at);
      let edges = 0;
      const edge = edgeFromEvent(event);
      if (event.type === "edge.tombstoned") {
        db.prepare("UPDATE edges SET valid_to=?, tombstoned_at=? WHERE tenant_id=? AND src_id=? AND predicate=? AND dst_id=? AND tombstoned_at IS NULL").run(event.created_at, event.created_at, edge.tenant_id, edge.src_id, edge.predicate, edge.dst_id);
      } else {
        db.prepare(`INSERT INTO edges(tenant_id,src_id,predicate,dst_id,evidence_id,created_at,valid_from,valid_to,confidence,source_event_id,tombstoned_at,visibility,group_id,user_id,agent_id,role_id,container,project)
          VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,src_id,predicate,dst_id) DO UPDATE SET evidence_id=excluded.evidence_id,created_at=excluded.created_at,valid_from=excluded.valid_from,valid_to=excluded.valid_to,confidence=excluded.confidence,source_event_id=excluded.source_event_id,tombstoned_at=NULL,visibility=excluded.visibility,group_id=excluded.group_id,user_id=excluded.user_id,agent_id=excluded.agent_id,role_id=excluded.role_id,container=excluded.container,project=excluded.project`)
          .run(edge.tenant_id, edge.src_id, edge.predicate, edge.dst_id, edge.evidence_id, edge.created_at, edge.valid_from, edge.valid_to, edge.confidence, edge.source_event_id, edge.visibility, edge.group_id, edge.user_id, edge.agent_id, edge.role_id, edge.container, edge.project);
        edges = 1;
      }
      db.exec("COMMIT");
      if (!replay) await appendEvent(dataRoot, event);
      return { ok: true, duplicate: false, event_id: event.event_id, edges };
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
  }
  async function ingestMany(eventInputs = []) {
    if (!Array.isArray(eventInputs)) throw new Error("events must be an array");
    const events = eventInputs.map(normalizeEvent);
    const evidence = new Set();
    for (const event of events) {
      if (!evidence.has(event.evidence_id)) {
        if (!(await findEvidence(dataRoot, event.evidence_id))) throw new Error(`evidence not found: ${event.evidence_id}`);
        evidence.add(event.evidence_id);
      }
    }
    const db = openDb(dataRoot); let applied = 0; let duplicates = 0; const appliedEvents = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      const insertEvent = db.prepare("INSERT INTO graph_events(source_event_id,tenant_id,event_type,event_json,evidence_id,created_at) VALUES(?,?,?,?,?,?)");
      const insertEdge = db.prepare(`INSERT INTO edges(tenant_id,src_id,predicate,dst_id,evidence_id,created_at,valid_from,valid_to,confidence,source_event_id,tombstoned_at,visibility,group_id,user_id,agent_id,role_id,container,project) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,src_id,predicate,dst_id) DO UPDATE SET evidence_id=excluded.evidence_id,created_at=excluded.created_at,valid_from=excluded.valid_from,valid_to=excluded.valid_to,confidence=excluded.confidence,source_event_id=excluded.source_event_id,tombstoned_at=NULL,visibility=excluded.visibility,group_id=excluded.group_id,user_id=excluded.user_id,agent_id=excluded.agent_id,role_id=excluded.role_id,container=excluded.container,project=excluded.project`);
      for (const event of events) {
        if (db.prepare("SELECT 1 FROM graph_events WHERE source_event_id=?").get(event.event_id)) { duplicates += 1; continue; }
        insertEvent.run(event.event_id, event.tenant_id, event.type, json(event), event.evidence_id, event.created_at);
        if (event.type !== "edge.tombstoned") { const edge = edgeFromEvent(event); insertEdge.run(edge.tenant_id, edge.src_id, edge.predicate, edge.dst_id, edge.evidence_id, edge.created_at, edge.valid_from, edge.valid_to, edge.confidence, edge.source_event_id, edge.visibility, edge.group_id, edge.user_id, edge.agent_id, edge.role_id, edge.container, edge.project); }
        applied += 1; appliedEvents.push(event);
      }
      db.exec("COMMIT");
      const file = eventLogPath(dataRoot); await fs.mkdir(path.dirname(file), { recursive: true });
      if (appliedEvents.length) await fs.appendFile(file, appliedEvents.map((event) => `${json(event)}\n`).join(""), "utf8");
      return { ok: true, applied, duplicates };
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
  }

  function edgeRows({ tenantId, srcId = null, dstId = null, predicate = null, includeTombstones = false } = {}) {
    const tenant = requiredString(tenantId, "tenant_id");
    const db = openDb(dataRoot);
    try {
      const clauses = ["tenant_id=?"]; const args = [tenant];
      if (srcId != null) { clauses.push("src_id=?"); args.push(requiredString(srcId, "src_id")); }
      if (dstId != null) { clauses.push("dst_id=?"); args.push(requiredString(dstId, "dst_id")); }
      if (predicate != null) { if (!PREDICATE_SET.has(predicate)) throw new Error(`predicate is not allowed: ${predicate}`); clauses.push("predicate=?"); args.push(predicate); }
      if (!includeTombstones) clauses.push("tombstoned_at IS NULL");
      return db.prepare(`SELECT tenant_id,src_id,predicate,dst_id,evidence_id,created_at,valid_from,valid_to,confidence,source_event_id,tombstoned_at,visibility,group_id,user_id,agent_id,role_id,container,project FROM edges WHERE ${clauses.join(" AND ")} ORDER BY created_at,src_id,dst_id`).all(...args);
    } finally { db.close(); }
  }
  function projectGraph({ tenantId, projectId, principal = null } = {}) {
    const tenant = requiredString(tenantId, "tenant_id");
    const projectName = requiredString(projectId, "project_id");
    const project = projectName.startsWith("project:") ? projectName : `project:${projectName}`;
    if (principal?.tenant_id && String(principal.tenant_id) !== tenant) return { tenant_id: tenant, project_id: project, memories: [], entities: [], edges: [] };
    const edges = [...edgeRows({ tenantId: tenant, srcId: project }), ...(projectName !== project ? edgeRows({ tenantId: tenant, srcId: projectName }) : [])];
    const visible = edges.filter((edge) => principalCanEdge(principal, edge));
    return { tenant_id: tenant, project_id: project, memories: visible.filter((e) => e.predicate === "belongs_to_project").map((e) => e.dst_id), entities: visible.filter((e) => e.predicate !== "belongs_to_project").map((e) => e.dst_id), edges: visible.map((e) => ({ ...e, graph_path: [e.src_id, e.predicate, e.dst_id], evidence_ids: [e.evidence_id] })) };
  }
  function stats() {
    const db = openDb(dataRoot);
    try { return { edges: Number(db.prepare("SELECT COUNT(*) n FROM edges WHERE tombstoned_at IS NULL").get().n), events: Number(db.prepare("SELECT COUNT(*) n FROM graph_events").get().n), tombstones: Number(db.prepare("SELECT COUNT(*) n FROM edges WHERE tombstoned_at IS NOT NULL").get().n), path: graphDbPath(dataRoot) }; } finally { db.close(); }
  }
  return { ingest, ingestMany, edgeRows, projectGraph, stats, dbPath: graphDbPath(dataRoot), eventPath: eventLogPath(dataRoot) };
}

export async function rebuildGraph({ dataRoot, index = false, ollama, fetchImpl } = {}) {
  const dbPath = graphDbPath(dataRoot);
  await fs.rm(dbPath, { force: true });
  const store = createGraphStore({ dataRoot });
  const events = String(await fs.readFile(eventLogPath(dataRoot), "utf8").catch(() => "")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  for (const event of events) await store.ingest(event, { replay: true });
  const markdownEvents = [];
  for (const file of await walkFiles(path.join(dataRoot, "project-state"), [".md"])) {
    const text = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatterTyped(text).frontmatter;
    const projectName = String(parsed.project ?? path.basename(path.dirname(file))).trim();
    const memoryId = String(parsed.id ?? path.basename(file, ".md")).trim();
    const refs = Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs.map(String).filter(Boolean) : [];
    if (!projectName || !memoryId || !refs[0]) continue;
    const principal = { tenant_id: parsed.tenant_id, group_id: parsed.group_id, user_id: parsed.user_id, agent_id: parsed.agent_id, role_id: parsed.role_id };
    const relationContainer = parsed.container === "tool" ? "tool" : parsed.container === "knowledge" ? "knowledge" : "project";
    const relationVisibility = parsed.visibility ?? (relationContainer === "tool" || relationContainer === "knowledge" ? "platform" : "project");
    markdownEvents.push({ event_id: `markdown:${sha(file)}`, type: "project.linked", tenant_id: principal.tenant_id ?? "default", evidence_id: refs[0], payload: { src_id: `project:${projectName}`, predicate: "belongs_to_project", dst_id: memoryId, visibility: relationVisibility, group_id: principal.group_id, user_id: principal.user_id, agent_id: principal.agent_id, role_id: principal.role_id, container: relationContainer, project: projectName } });
    for (const relation of [["owned_by_account", parsed.owned_by_account], ["runs_on_machine", parsed.runs_on_machine]]) if (relation[1]) markdownEvents.push({ event_id: `markdown:${sha(file)}:${relation[0]}`, type: "memory.created", tenant_id: principal.tenant_id ?? "default", evidence_id: refs[0], payload: { src_id: memoryId, predicate: relation[0], dst_id: String(relation[1]), visibility: relationVisibility, group_id: principal.group_id, user_id: principal.user_id, agent_id: principal.agent_id, role_id: principal.role_id, container: relationContainer, project: projectName } });
  }
  // 全局图：把 curated / plans / profile / tools-memory 里每条记忆的 evidence_refs、project、tags、supersedes 变成边。
  // 这样图谱才不是只有 project-state 里那几条。
  const memoryRoots = [
    path.join(dataRoot, "curated"),
    path.join(dataRoot, "plans"),
    path.join(dataRoot, "profile"),
    path.join(dataRoot, "tools-memory"),
  ];
  let linkedFiles = 0;
  for (const root of memoryRoots) {
    for (const file of await walkFiles(root, [".md"])) {
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (!text) continue;
      const parsed = parseFrontmatterTyped(text).frontmatter ?? {};
      const memoryId = String(parsed.id ?? path.basename(file, ".md")).trim();
      if (!memoryId) continue;
      const refs = Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs.map(String).filter(Boolean) : [];
      const projectName = typeof parsed.project === "string" ? parsed.project.trim() : "";
      const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean).slice(0, 3) : [];
      const supersedes = Array.isArray(parsed.supersedes) ? parsed.supersedes.map(String).filter(Boolean).slice(0, 3) : [];
      if (!refs.length && !projectName && !tags.length && !supersedes.length) continue;
      const tenant = String(parsed.tenant_id ?? "default");
      const evidenceForEvent = refs[0] ?? `memory:${memoryId}`;
      const basePayload = {
        visibility: parsed.visibility ?? null,
        group_id: parsed.group_id ?? null,
        user_id: parsed.user_id ?? null,
        agent_id: parsed.agent_id ?? null,
        role_id: parsed.role_id ?? null,
        container: parsed.container ?? null,
        project: projectName || null,
      };
      const push = (suffix, src, predicate, dst) => markdownEvents.push({
        event_id: `memorylink:${sha(file)}:${suffix}`,
        type: "memory.created",
        tenant_id: tenant,
        evidence_id: evidenceForEvent,
        payload: { src_id: src, predicate, dst_id: dst, ...basePayload },
      });
      for (const [i, ref] of refs.slice(0, 3).entries()) push(`ref:${i}`, memoryId, "derived_from", ref);
      if (projectName) push("project", `project:${projectName}`, "belongs_to_project", memoryId);
      for (const [i, tag] of tags.entries()) push(`tag:${i}`, memoryId, "related_to", `tag:${tag}`);
      for (const [i, oldId] of supersedes.entries()) push(`supersedes:${i}`, memoryId, "related_to", oldId);
      linkedFiles += 1;
    }
  }
  for (const event of markdownEvents) await store.ingest(event, { replay: true });
  let indexResult = null;
  if (index) indexResult = await createIndexStore({ dataRoot, ollama, fetchImpl }).index({ rebuild: true });
  return { graph: store.stats(), linkedFiles, index: indexResult };
}

// 节点可读标签：记忆取正文首行摘要，证据取短 id，标签取中文/原名
const TAG_LABELS = Object.freeze({
  refined: "精炼", decision: "决策", fact: "事实", preference: "偏好", lesson: "教训",
  migration: "迁移", soul: "灵魂", memory: "记忆", profile: "画像", plan: "计划",
  tool: "工具", knowledge: "知识", "repo-strategy": "仓库策略", infrastructure: "基础设施",
});
const GENERIC_TAGS = new Set(["refined", "decision", "fact"]);
const nodeMetaCache = new Map();

function firstMeaningfulLine(text) {
  const body = String(text).split(/^---\r?\n[\s\S]*?^---\r?\n/m).slice(-1)[0] ?? "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/u, "").replace(/[*_`>]/gu, "").trim();
    if (line.length >= 4) return line.slice(0, 60);
  }
  return "";
}

function nodeMetaFor(dataRoot) {
  const cached = nodeMetaCache.get(dataRoot);
  if (cached && Date.now() - cached.at < 120000) return cached.map;
  const map = new Map();
  const roots = ["curated", "plans", "profile", "tools-memory", "project-state", "evidence/documents"];
  const walk = (dir) => {
    let entries = [];
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      let text = "";
      try { text = fsSync.readFileSync(full, "utf8"); } catch { continue; }
      const fm = parseFrontmatterTyped(text).frontmatter ?? {};
      const id = String(fm.id ?? path.basename(full, ".md"));
      const title = firstMeaningfulLine(text) || String(fm.summary ?? fm.title ?? "").slice(0, 60) || id;
      map.set(id, { title, path: path.relative(dataRoot, full).replace(/\\/g, "/"), updated_at: fm.updated_at ?? null, tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [] });
    }
  };
  for (const root of roots) walk(path.join(dataRoot, root));
  nodeMetaCache.set(dataRoot, { at: Date.now(), map });
  return map;
}

function readableLabel(id, meta) {
  if (id.startsWith("project:")) return "项目：" + id.slice(8);
  if (id.startsWith("tag:")) {
    const tag = id.slice(4);
    return "标签：" + (TAG_LABELS[tag] ?? tag);
  }
  if (/^conversation-/u.test(id)) return "证据：" + id.slice(0, 22).replace("conversation-", "");
  if (/^(napcat|qq)[:-]/u.test(id)) return "证据：" + id.slice(0, 24);
  const found = meta.get(id);
  if (found?.title) return found.title;
  if (id.includes(":")) return "证据：" + id.split(":").slice(-1)[0].slice(0, 16);
  return id.replace(/^curated-shared-/u, "").slice(0, 24);
}

// 全局图快照（只读）：节点 + 边 + 总数，供控制台可视化
export function dumpGraph({ dataRoot, tenantId = "default", limit = 500, project = null, principal = null } = {}) {
  const db = openDb(dataRoot);
  try {
    const tenant = String(tenantId);
    const clauses = ["tenant_id=?", "tombstoned_at IS NULL"]; const args = [tenant];
    if (project) {
      const name = String(project).replace(/^project:/u, "");
      clauses.push("(project=? OR src_id=? OR dst_id=?)");
      args.push(name, `project:${name}`, `project:${name}`);
    }
    const totalEdgeRow = db.prepare(`SELECT COUNT(*) n FROM edges WHERE ${clauses.join(" AND ")}`).get(...args);
    // 先取全量（上限 20000）再按权限过滤，最后才截断 —— 反过来会因"前 N 条恰好都被过滤"而返回空图。
    const rows = db.prepare(`SELECT tenant_id,src_id,predicate,dst_id,evidence_id,created_at,confidence,project,visibility,container,group_id,user_id,agent_id,role_id FROM edges WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 20000`).all(...args);
    const permitted = principal ? rows.filter((edge) => principalCanEdge(principal, edge)) : rows;
    const capped = permitted.slice(0, Math.max(1, Math.min(2000, Number(limit) || 500)));
    const nodeMap = new Map();
    const metaForType = nodeMetaFor(dataRoot);
    const typeOf = (id) => {
      if (id.startsWith("project:")) return "project";
      if (id.startsWith("tag:")) return "tag";
      if (/^conversation-/u.test(id) || /^(napcat|qq)[:-]/u.test(id)) return "evidence";
      if (!metaForType.has(id) && id.includes(":")) return "evidence";
      return "memory";
    };
    const meta = nodeMetaFor(dataRoot);
    const addNode = (id) => {
      if (nodeMap.has(id)) return;
      const type = typeOf(id);
      const found = meta.get(id) ?? null;
      nodeMap.set(id, {
        id,
        type,
        label: readableLabel(id, meta),
        title: found?.title ?? null,
        path: found?.path ?? null,
        updated_at: found?.updated_at ?? null,
        generic: type === "tag" && GENERIC_TAGS.has(id.slice(4)),
      });
    };
    for (const edge of capped) { addNode(edge.src_id); addNode(edge.dst_id); }
    return {
      nodes: [...nodeMap.values()],
      edges: capped.map((edge) => ({ src_id: edge.src_id, predicate: edge.predicate, dst_id: edge.dst_id, evidence_id: edge.evidence_id, created_at: edge.created_at, confidence: edge.confidence })),
      totals: {
        nodes: nodeMap.size,
        edges: capped.length,
        visible_edges: permitted.length,
        all_edges: Number(totalEdgeRow?.n ?? 0),
        truncated: permitted.length > capped.length,
      },
    };
  } finally { db.close(); }
}

export function reciprocalRankFusion(lists, limit = 10, k = 60) {
  const entries = new Map(); const scores = new Map(); const matched = new Map();
  for (const list of lists ?? []) for (let i = 0; i < list.length; i += 1) {
    const item = list[i]; const key = item.id ?? item.path;
    const lane = item.matched_by ?? item.lane;
    const lanes = matched.get(key) ?? [];
    if (lane && !lanes.includes(lane)) lanes.push(lane);
    matched.set(key, lanes);
    const prior = entries.get(key) ?? {};
    entries.set(key, {
      ...prior,
      ...item,
      graph_path: item.graph_path?.length ? item.graph_path : (prior.graph_path ?? []),
      evidence_ids: item.evidence_ids?.length ? [...new Set([...(prior.evidence_ids ?? []), ...item.evidence_ids])] : (prior.evidence_ids ?? []),
      matched_by: lanes,
    });
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
  }
  return [...entries.entries()].map(([key, item]) => ({ ...item, score: scores.get(key), matched_by: matched.get(key) ?? [] })).sort((a, b) => b.score - a.score || String(a.id ?? a.path).localeCompare(String(b.id ?? b.path))).slice(0, Math.max(0, limit));
}

export async function jointSearch({ dataRoot, tenantId, query, limit = 10, exact = null, principal = null, scopes = null, depth = 2, ollama, fetchImpl = globalThis.fetch } = {}) {
  const store = createGraphStore({ dataRoot });
  const tenant = requiredString(tenantId, "tenant_id");
  const graph = exact ? store.edgeRows({ tenantId: tenant, srcId: exact.src_id, predicate: exact.predicate, dstId: exact.dst_id }).filter((edge) => principalCanEdge(principal, edge)) : [];
  const graphList = graph.map((edge) => ({ id: edge.dst_id, matched_by: "graph", graph_path: [edge.src_id, edge.predicate, edge.dst_id], evidence_ids: [edge.evidence_id], edge }));
  // 2026-11-02：检索前置过滤——把 principal/scopes 传下去，让 SQL 先按主体筛，避免全库 Top-N 后再过滤。
  // 2026-11-02：图检索的索引 lane 也按 scope 根前置（原来传 null = 全库取再过滤）。
  const authRoots = scopes === null || principal === null ? null : rootPaths(resolveRootsForScopes(scopes, dataRoot, dataRoot));
  const indexed = await memoryIndexSearch(dataRoot, query, Math.max(limit * 4, 20), authRoots, ollama, fetchImpl, { principal, scopes, tenantId: tenant }).catch(() => null);
  const fmCache = new Map();
  const visiblePath = async (item) => {
    const text = await fs.readFile(item.path, "utf8").catch(() => null);
    if (!text) return false;
    const { frontmatter } = parseFrontmatterTyped(text);
    fmCache.set(item.path, frontmatter);
    const itemTenant = frontmatter.tenant_id ?? frontmatter.tenantId ?? "default";
    if (String(itemTenant) !== tenant) return false;
    const hasPrincipal = principal && ["tenant_id", "group_id", "user_id", "agent_id", "role_id"].some((key) => principal[key] != null);
    if (!hasPrincipal) return true;
    const group = frontmatter.group_id ?? frontmatter.groupId;
    const user = frontmatter.user_id ?? frontmatter.userId;
    if (String(item.path).replaceAll("\\", "/").includes("/evidence/conversations/")) return Boolean(group && user && group !== "unknown" && user !== "unknown" && group === principal.group_id && user === principal.user_id);
    return principalAllowsContainer(principal, { ...frontmatter, tenant_id: itemTenant, group_id: group, user_id: user, agent_id: frontmatter.agent_id ?? frontmatter.agentId, role_id: frontmatter.role_id ?? frontmatter.roleId });
  };
  const ftsRows = indexed?.laneResults?.fts ?? [];
  const vectorRows = indexed?.laneResults?.vector ?? [];
  const fts = (await Promise.all(ftsRows.map(async (item) => (await visiblePath(item)) ? ({ id: item.path, path: item.path, excerpt: item.excerpt, matched_by: "fts", evidence_ids: [], graph_path: [] }) : null))).filter(Boolean);
  const vector = (await Promise.all(vectorRows.map(async (item) => (await visiblePath(item)) ? ({ id: item.path, path: item.path, excerpt: item.excerpt, matched_by: "vector", evidence_ids: [], graph_path: [] }) : null))).filter(Boolean);
  const rawRoot = path.join(dataRoot, "evidence", "conversations");
  const rawFiles = await walkFiles(rawRoot, [".md"]);
  const lexical = [];
  for (const filePath of rawFiles) {
    if (!(await visiblePath({ path: filePath }))) continue;
    const text = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!text || !text.toLocaleLowerCase().includes(String(query).toLocaleLowerCase())) continue;
    lexical.push({ id: filePath, path: filePath, excerpt: text.slice(Math.max(0, text.toLocaleLowerCase().indexOf(String(query).toLocaleLowerCase()) - 160),  Math.min(text.length, text.toLocaleLowerCase().indexOf(String(query).toLocaleLowerCase()) + String(query).length + 240)), matched_by: "fts", evidence_ids: [], graph_path: [] });
  }
  // 多跳扩展：从命中项（及精确边的端点）出发，沿边 BFS 最多 depth 跳。
  // 只走 principalCanEdge 放行的边；节点上限 200，避免大图爆掉。
  if (graphList.length || fts.length || vector.length) {
    const seeds = new Set();
    for (const item of [...fts, ...vector]) {
      const id = fmCache.get(item.path)?.id;
      if (id) seeds.add(String(id));
    }
    for (const item of graphList) for (const node of [item.edge?.src_id, item.edge?.dst_id]) if (node) seeds.add(String(node));
    const hopLimit = Math.max(1, Math.min(3, Number.isInteger(depth) ? depth : 2));
    const allEdges = store.edgeRows({ tenantId: tenant });
    const bySrc = new Map(); const byDst = new Map();
    for (const edge of allEdges) {
      if (!bySrc.has(edge.src_id)) bySrc.set(edge.src_id, []);
      bySrc.get(edge.src_id).push(edge);
      if (!byDst.has(edge.dst_id)) byDst.set(edge.dst_id, []);
      byDst.get(edge.dst_id).push(edge);
    }
    const seen = new Set(seeds);
    let frontier = [...seeds];
    const hopItems = [];
    for (let hop = 1; hop <= hopLimit && frontier.length; hop += 1) {
      const next = [];
      for (const node of frontier) {
        const candidates = [...(bySrc.get(node) ?? []), ...(byDst.get(node) ?? [])];
        for (const edge of candidates) {
          if (!principalCanEdge(principal, edge)) continue;
          const other = edge.src_id === node ? edge.dst_id : edge.src_id;
          if (!other || seen.has(other)) continue;
          seen.add(other);
          // 中间节点（project:/tag:/memory:/evidence:）**可以继续走**，但不作为结果返回；
          // 否则「记忆 → tag:xx → 同 tag 的另一条记忆」这种两跳永远走不通。
          // 证据/灵魂/标签/项目节点只作为"桥"，不作为检索结果返回（结果必须是可读的记忆）。
          if (/^(project|tag|memory|evidence|conversation-|session-|soul:|napcat:|qq:|being:|capture:)/u.test(other) || other.includes("#")) { next.push(other); continue; }
          next.push(other);
          hopItems.push({ id: other, matched_by: `graph:hop${hop}`, graph_path: [edge.src_id, edge.predicate, edge.dst_id], evidence_ids: [edge.evidence_id], edge });
          if (hopItems.length >= 200) break;
        }
        if (hopItems.length >= 200) break;
      }
      frontier = next;
      if (hopItems.length >= 200) break;
    }
    graphList.push(...hopItems);
  }
  const merged = reciprocalRankFusion([graphList, fts, vector, lexical], limit);
  return merged.filter((item) => item.matched_by.includes("graph") ? item.evidence_ids.length > 0 : true).map((item) => ({ ...item, matched_by: item.matched_by.sort(), graph_path: item.graph_path ?? [], evidence_ids: item.evidence_ids ?? [] }));
}

export function graphPathFor(dataRoot) { return graphDbPath(dataRoot); }
export function openGraph(graphPath) { const db = new DatabaseSync(graphPath); db.exec("PRAGMA foreign_keys=ON;"); db.exec(GRAPH_SCHEMA); return db; }
export function dropGraph(graphPath) { return fs.rm(graphPath, { force: true }); }
export async function buildGraph(options = {}) { return rebuildGraph(options); }
export { eventLogPath, graphDbPath };
