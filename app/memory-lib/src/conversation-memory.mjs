// memory-lib — automatic conversation evidence capture.
// Raw conversations stay in evidence, with sensitive values redacted before anything is persisted.
// The deprecated extract input is accepted for deployed-client compatibility but never creates candidates.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { redactSensitiveText } from "./extraction-quality.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 12000;
const QUEUE_EVENT_FIELDS = Object.freeze(["conversationId", "source", "eventId", "sessionId", "principal", "scopes", "extract", "partial", "suppressRefinement"]);
const FINGERPRINT_RE = /^[0-9a-f]{24}$/;

function redactMessages(messages) {
  return messages.map((message) => ({ role: message.role, content: redactSensitiveText(message.content) }));
}

function pickQueueEventFields(event) {
  const picked = {};
  for (const key of QUEUE_EVENT_FIELDS) {
    if (event?.[key] === undefined) continue;
    if (key === "principal") {
      const principal = event.principal;
      picked.principal = {};
      for (const claim of ["framework_id", "agent_id", "role_id", "group_id", "user_id"]) {
        if (typeof principal?.[claim] === "string") picked.principal[claim] = principal[claim];
      }
    } else {
      picked[key] = event[key];
    }
  }
  return picked;
}

export function createConversationMemory({ dataRoot, onCaptured = null, calendarTimezone = "UTC" } = {}) {
  if (!dataRoot) throw new Error("conversation memory requires dataRoot");
  const root = path.join(dataRoot, "evidence", "conversations");
  const indexPath = path.join(root, "capture-index.json");
  const queueRoot = path.join(root, "queue");
  const quarantineRoot = path.join(dataRoot, "quarantine", "unattributed-captures");
  let draining = false;
  let activeDrain = null;
  let captureChain = Promise.resolve();

  async function capture({ messages, conversationId = null, source = "http", eventId = null, sessionId = null, workspace = null, tags = [], principal, scopes, extract = false, partial = false, suppressRefinement = false, fingerprint: queuedFingerprint = null }) {
    const run = captureChain.then(() => captureNow({ messages, conversationId, source, eventId, sessionId, workspace, tags, principal, scopes, extract, partial, suppressRefinement, fingerprint: queuedFingerprint }));
    captureChain = run.catch(() => {});
    return run;
  }

  async function captureNow({ messages, conversationId = null, source = "http", eventId = null, sessionId = null, workspace = null, tags = [], principal, scopes, extract = false, partial = false, suppressRefinement = false, fingerprint: queuedFingerprint = null }) {
    const normalized = normalizeMessages(messages);
    if (!normalized.length) throw new Error("messages are required");
    const normalizedWorkspace = normalizeWorkspace(workspace);
    const normalizedTags = normalizeTags(tags);
    const fingerprint = FINGERPRINT_RE.test(String(queuedFingerprint ?? ""))
      ? queuedFingerprint
      : eventFingerprint({ conversationId, source, eventId, sessionId, workspace: normalizedWorkspace, tags: normalizedTags, messages: normalized });
    await quarantineUnattributed({ fingerprint, messages: snapshotMessages(messages), conversationId, source, eventId, sessionId, workspace: normalizedWorkspace, tags: normalizedTags, principal, partial });
    requireCaptureOwnership(principal);
    const legacyFingerprint = hash(JSON.stringify({ conversationId, source, eventId, sessionId, messages: normalized }));
    const index = await readIndex();
    const previous = index.events[fingerprint] ?? index.events[legacyFingerprint];
    const completingPartial = Boolean(previous?.partial) && partial !== true;
    if (previous && !completingPartial) return { ...previous, duplicate: true, deduped: true };

    const capturedAt = new Date().toISOString();
    const evidenceId = `conversation-${fingerprint}`;
    const evidencePath = path.join(root, `${evidenceId}.md`);
    // F1 redaction happens before evidence is written and before the model sees anything: a raw
    // credential / private key / connection string / local absolute path / e-mail must reach
    // neither the evidence file nor a candidate. The fingerprint above still hashes the raw
    // messages, so event idempotency is unchanged.
    const safeMessages = redactMessages(normalized);
    const calendar = calendarFields(capturedAt, calendarTimezone);
    const evidence = renderEvidence({ evidenceId, capturedAt, calendar, conversationId, source, eventId, sessionId, workspace: normalizedWorkspace, tags: normalizedTags, principal, partial, messages: safeMessages });
    await atomicWrite(evidencePath, evidence);

    await writeFastRoute({ dataRoot, evidenceId, evidencePath, capturedAt, conversationId, source, eventId, sessionId, workspace: normalizedWorkspace, tags: normalizedTags, messages: safeMessages });
    const result = { fingerprint, evidenceId, evidencePath, candidateCount: 0, candidates: [], capturedAt, calendarDate: calendar.calendarDate, calendarTimezone: calendar.calendarTimezone, createdAt: capturedAt, source, conversationId, workspace: normalizedWorkspace, tags: normalizedTags, partial: Boolean(partial), extracted: false, deduped: false, status: "stored", searchStatus: "stored", lifecycle: ["accepted", "stored"] };
    index.events[fingerprint] = result;
    await atomicWrite(indexPath, JSON.stringify(index, null, 2) + "\n");
    // MEMORY-LOOP-1：`conversationId` / `capturedAt` / `partial` 是**新增**给 onCaptured 的字段
    // （原来只有 evidenceId/principal/workspace/source/suppressRefinement）。提炼待办要做"一段**完成**的
    // 对话"这件事的问责记录，就必须能拿到这三样；对既有消费者是纯增量（老字段一字未动）。
    const indexing = await onCaptured?.({ evidenceId, messages: safeMessages, principal, workspace: normalizedWorkspace, source, conversationId: conversationId ?? null, capturedAt, partial: Boolean(partial), suppressRefinement });
    if (indexing?.status) result.searchStatus = indexing.status;
    if (indexing?.status === "indexed" || indexing?.status === "searchable") { result.status = indexing.status; result.lifecycle = ["accepted", "stored", "indexed", ...(indexing.status === "searchable" ? ["searchable"] : [])]; }
    if (indexing?.indexError) { result.indexError = indexing.indexError; result.status = "failed"; result.lifecycle = ["accepted", "stored", "failed"]; result.failure = { stage: "indexed", message: indexing.indexError }; }
    index.events[fingerprint] = result;
    await atomicWrite(indexPath, JSON.stringify(index, null, 2) + "\n");
    return result;
  }

  async function writeFastRoute({ dataRoot, evidenceId, evidencePath, capturedAt, conversationId, source, eventId, sessionId, workspace, tags, messages }) {
    // D29: conversation capture is storage-only evidence. Project progress, state,
    // and decisions are written explicitly through their target-layer APIs.
    return { episodePaths: [], projectPaths: [] };
  }

  async function readIndex() {
    try {
      const value = JSON.parse(await fs.readFile(indexPath, "utf8"));
      return value && value.events ? value : { version: 1, events: {} };
    } catch { return { version: 1, events: {} }; }
  }

  async function enqueue(event) {
    const normalized = normalizeMessages(event?.messages);
    if (!normalized.length) throw new Error("messages are required");
    const workspace = normalizeWorkspace(event?.workspace);
    const tags = normalizeTags(event?.tags);
    const fingerprint = eventFingerprint({ conversationId: event?.conversationId ?? null, source: event?.source ?? "http", eventId: event?.eventId ?? null, sessionId: event?.sessionId ?? null, workspace, tags, messages: normalized });
    await quarantineUnattributed({ fingerprint, messages: snapshotMessages(event?.messages), conversationId: event?.conversationId ?? null, source: event?.source ?? "http", eventId: event?.eventId ?? null, sessionId: event?.sessionId ?? null, workspace, tags, principal: event?.principal, partial: event?.partial === true });
    requireCaptureOwnership(event?.principal);
    const filePath = path.join(queueRoot, `${fingerprint}.json`);
    const existing = await readJson(filePath);
    if (!existing || (existing.partial === true && event?.partial !== true)) {
      const record = {
        version: 1, status: "pending", attempts: 0,
        queuedAt: existing?.queuedAt ?? new Date().toISOString(), nextAttemptAt: new Date().toISOString(),
        fingerprint, ...pickQueueEventFields(event), workspace, tags, partial: Boolean(event?.partial),
        messages: redactMessages(normalized),
      };
      await atomicWrite(filePath, JSON.stringify(record, null, 2) + "\n");
    }
    void drain().catch(() => {});
    return { status: "queued", fingerprint, path: filePath };
  }

  function drain({ limit = 4 } = {}) {
    if (activeDrain) return activeDrain;
    activeDrain = (async () => {
      draining = true; let processed = 0; let quarantined = 0;
      try {
        const files = (await fs.readdir(queueRoot).catch(() => [])).filter((name) => name.endsWith(".json")).slice(0, Math.max(1, Math.min(20, Number(limit) || 4)));
        for (const name of files) {
          const filePath = path.join(queueRoot, name); const item = await readJson(filePath);
          if (!item || Date.parse(item.nextAttemptAt ?? "") > Date.now()) continue;
          try { await capture(item); await fs.unlink(filePath).catch(() => {}); processed += 1; }
          catch (error) {
            if (error?.captureReason === "unattributed") { await fs.unlink(filePath).catch(() => {}); quarantined += 1; continue; }
            const attempts = Number(item.attempts || 0) + 1;
            await atomicWrite(filePath, JSON.stringify({ ...item, status: "retry", attempts, lastError: String(error?.message ?? error).slice(0, 300), nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 1000 * (2 ** Math.min(attempts, 10)))).toISOString() }, null, 2) + "\n");
          }
        }
        return { processed, quarantined, busy: false };
      } finally { draining = false; activeDrain = null; }
    })();
    return activeDrain;
  }

  async function quarantineUnattributed({ fingerprint, messages, conversationId, source, eventId, sessionId, workspace, tags, principal, partial }) {
    if (hasCaptureOwnership(principal)) return null;
    const filePath = path.join(quarantineRoot, `${fingerprint}.json`);
    if (await readJson(filePath)) return filePath;
    const record = {
      version: 1,
      reason: "unattributed-capture",
      capturedAt: new Date().toISOString(),
      conversation_id: conversationId ?? null,
      event_id: eventId ?? null,
      session_id: sessionId ?? null,
      source: String(source ?? "http").slice(0, 120),
      workspace,
      tags,
      partial: Boolean(partial),
      principal: Object.fromEntries(["framework_id", "agent_id", "role_id", "group_id", "user_id"].map((claim) => [claim, typeof principal?.[claim] === "string" ? principal[claim] : null])),
      messages,
    };
    await atomicWrite(filePath, JSON.stringify(record, null, 2) + "\n");
    return filePath;
  }

  async function queueStatus() { return { pending: (await fs.readdir(queueRoot).catch(() => [])).filter((name) => name.endsWith(".json")).length, root: queueRoot }; }

  async function quarantineStatus() {
    const files = (await fs.readdir(quarantineRoot).catch(() => [])).filter((name) => FINGERPRINT_RE.test(name.replace(/\.json$/u, "")) && name.endsWith(".json"));
    return { unattributed_captures: files.length };
  }

  async function listQuarantine({ limit = 100 } = {}) {
    const files = (await fs.readdir(quarantineRoot).catch(() => [])).filter((name) => name.endsWith(".json")).sort().slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)));
    const records = [];
    for (const name of files) {
      const record = await readJson(path.join(quarantineRoot, name));
      if (!record) continue;
      records.push({ id: name.replace(/\.json$/u, ""), reason: record.reason, capturedAt: record.capturedAt, conversation_id: record.conversation_id, event_id: record.event_id, source: record.source, principal: record.principal });
    }
    return records;
  }

  async function readQuarantine(id) {
    if (!FINGERPRINT_RE.test(String(id ?? ""))) return null;
    return readJson(path.join(quarantineRoot, `${id}.json`));
  }

  return { capture, enqueue, drain, queueStatus, quarantineStatus, listQuarantine, readQuarantine, root, queueRoot, quarantineRoot, readIndex };
}

function hasCaptureOwnership(principal) {
  return ["group_id", "user_id"].every((claim) => {
    const value = typeof principal?.[claim] === "string" ? principal[claim].trim() : "";
    return value && value !== "unknown";
  });
}

function requireCaptureOwnership(principal) {
  if (!hasCaptureOwnership(principal)) throw Object.assign(new Error("conversation capture requires principal group_id and user_id"), { captureReason: "unattributed" });
}

function snapshotMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({ role: message?.role, content: message?.content }));
}

function normalizeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.slice(-MAX_MESSAGES).map((m) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: String(m?.content ?? "").trim().slice(0, MAX_MESSAGE_CHARS),
  })).filter((m) => m.content);
}

function sanitizePathSegment(value) { return String(value ?? "session").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "session"; }
function renderFastProject({ id, workspace, capturedAt, source, evidenceId, tags, body }) {
  return [`---`, `id: ${id}`, `layer: project`, `kind: capture`, `workspace: ${JSON.stringify(workspace)}`, `captured_at: ${capturedAt}`, `source: ${JSON.stringify(source)}`, `evidence_refs: [${JSON.stringify(evidenceId)}]`, `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`, `status: active`, `---`, "", "# 对话项目记录", "", body, ""].join("\n");
}

export function calendarFields(capturedAt, timezone) {
  const value = new Date(capturedAt);
  if (!Number.isFinite(value.getTime())) throw new Error("capturedAt must be a valid ISO timestamp");
  const resolved = typeof timezone === "string" && timezone.trim() ? timezone.trim() : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: resolved, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { calendarDate: `${values.year}-${values.month}-${values.day}`, calendarTimezone: resolved };
}

function renderEvidence({ evidenceId, capturedAt, calendar, conversationId, source, eventId, sessionId, workspace, tags, principal, partial = false, messages }) {
  const header = ["---", `id: ${evidenceId}`, "type: conversation", `capturedAt: ${capturedAt}`, `calendarDate: ${calendar.calendarDate}`, `calendarTimezone: ${JSON.stringify(calendar.calendarTimezone)}`,  `source: ${JSON.stringify(String(source).slice(0, 120))}`, `conversationId: ${JSON.stringify(conversationId ?? "")}`, `eventId: ${JSON.stringify(eventId ?? "")}`, `sessionId: ${JSON.stringify(sessionId ?? "")}`, ...(workspace ? [`workspace: ${JSON.stringify(workspace)}`] : []), ...(tags.length ? [`tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`] : []), `frameworkId: ${JSON.stringify(principal?.framework_id ?? "")}`, `agentId: ${JSON.stringify(principal?.agent_id ?? "")}`, `roleId: ${JSON.stringify(principal?.role_id ?? "")}`, `groupId: ${JSON.stringify(principal?.group_id ?? "unknown")}`, `userId: ${JSON.stringify(principal?.user_id ?? "unknown")}`, `partial: ${Boolean(partial)}`,  "---", "# 原始对话记录", ""];
  return header.concat(messages.map((m) => `## ${m.role === "user" ? "用户" : "助手"}\n\n${m.content}\n`)).join("\n");
}
async function readJson(filePath) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; } }
export function extractJson(raw) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "").trim();
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd >= arrayStart) return text.slice(arrayStart, arrayEnd + 1);
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  return objectStart >= 0 && objectEnd >= objectStart ? text.slice(objectStart, objectEnd + 1) : text;
}

export function extractJsonValues(raw) {
  const text = String(raw ?? "");
  const values = [];
  for (const match of text.matchAll(/[\[{][\s\S]*?[\]}]/g)) values.push(match[0]);
  return values;
}
function safeTag(value) { return String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40) || "unknown"; }
export function normalizeWorkspace(value) { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string") throw new Error("workspace must be a string"); const text = value.trim().replace(/\\/g, "/").replace(/\/+$/g, ""); if (!text || text.length > 512 || /[\r\n\0]/u.test(text)) throw new Error("workspace is invalid"); return text; }
export function workspaceKey(value) { const normalized = normalizeWorkspace(value); return normalized ? normalized.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || `workspace-${hash(normalized)}` : null; }
export function normalizeTags(value) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new Error("tags must be a string array"); const tags = value.map((tag) => { if (typeof tag !== "string") throw new Error("tags must be a string array"); const text = tag.trim(); if (!text || text.length > 80 || /[\r\n\0]/u.test(text)) throw new Error("tag is invalid"); return safeTag(text); }); return [...new Set(tags)].slice(0, 20); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24); }
function eventFingerprint({ conversationId, source, eventId, sessionId, workspace, tags, messages }) { return hash(eventId ? JSON.stringify({ source, conversationId, eventId }) : JSON.stringify({ conversationId, source, sessionId, workspace, tags, messages })); }
// ATOMICWRITE-1：收敛到统一助手（rename 遇 EPERM/EACCES/EBUSY 会短退避重试）。
// 保留本函数名与签名，调用点零改动。
async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }
