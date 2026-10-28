import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { indexPathFor, createIndexStore } from "./index-store.mjs";
import { memoryIndexSearch } from "./index-search.mjs";
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
  const visibility = edge.visibility ?? (edge.container === "tool" || edge.container === "knowledge" ? "platform" : "project");
  return principalAllowsContainer(principal, { container: edge.container ?? "project", visibility, group_id: edge.group_id, user_id: edge.user_id, agent_id: edge.agent_id, role_id: edge.role_id, project: edge.project ?? edge.src_id.replace(/^project:/u, "") });
}

export function normalizeStructuredEvent(input) { return normalizeEvent(input); }

export function createGraphStore({ dataRoot } = {}) {
  if (!dataRoot) throw new Error("graph store requires dataRoot");
  async function ingest(eventInput, { replay = false } = {}) {
    const event = normalizeEvent(eventInput);
    if (!(await findEvidence(dataRoot, event.evidence_id))) throw new Error(`evidence not found: ${event.evidence_id}`);
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
  for (const event of markdownEvents) await store.ingest(event, { replay: true });
  let indexResult = null;
  if (index) indexResult = await createIndexStore({ dataRoot, ollama, fetchImpl }).index({ rebuild: true });
  return { graph: store.stats(), index: indexResult };
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

export async function jointSearch({ dataRoot, tenantId, query, limit = 10, exact = null, principal = null, ollama, fetchImpl = globalThis.fetch } = {}) {
  const store = createGraphStore({ dataRoot });
  const tenant = requiredString(tenantId, "tenant_id");
  const graph = exact ? store.edgeRows({ tenantId: tenant, srcId: exact.src_id, predicate: exact.predicate, dstId: exact.dst_id }).filter((edge) => principalCanEdge(principal, edge)) : [];
  const graphList = graph.map((edge) => ({ id: edge.dst_id, matched_by: "graph", graph_path: [edge.src_id, edge.predicate, edge.dst_id], evidence_ids: [edge.evidence_id], edge }));
  const indexed = await memoryIndexSearch(dataRoot, query, Math.max(limit * 4, 20), null, ollama, fetchImpl).catch(() => null);
  const visiblePath = async (item) => {
    const text = await fs.readFile(item.path, "utf8").catch(() => null);
    if (!text) return false;
    const { frontmatter } = parseFrontmatterTyped(text);
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
  const merged = reciprocalRankFusion([graphList, fts, vector, lexical], limit);
  return merged.filter((item) => item.matched_by.includes("graph") ? item.evidence_ids.length > 0 : true).map((item) => ({ ...item, matched_by: item.matched_by.sort(), graph_path: item.graph_path ?? [], evidence_ids: item.evidence_ids ?? [] }));
}

export function graphPathFor(dataRoot) { return graphDbPath(dataRoot); }
export function openGraph(graphPath) { const db = new DatabaseSync(graphPath); db.exec("PRAGMA foreign_keys=ON;"); db.exec(GRAPH_SCHEMA); return db; }
export function dropGraph(graphPath) { return fs.rm(graphPath, { force: true }); }
export async function buildGraph(options = {}) { return rebuildGraph(options); }
export { eventLogPath, graphDbPath };
