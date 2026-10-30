// memory-lib — generic transcript directory importer.
// Sources only need to drop JSON/JSONL/Markdown/text exports; memory processing stays here.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { scopeAllows } from "./memory-lib.mjs";
import { workspaceKey } from "./conversation-memory.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

export function createTranscriptImporter({ importRoot, conversationMemory } = {}) {
  if (!importRoot || !conversationMemory) throw new Error("transcript importer requires importRoot and conversationMemory");
  const statePath = path.join(importRoot, ".import-state.json");

  async function scan({ source = "transcript-import", principal, scopes, extract = false } = {}) {
    await fs.mkdir(importRoot, { recursive: true });
    const state = await readState();
    const files = (await fs.readdir(importRoot, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".") && /\.(json|jsonl|md|txt)$/iu.test(e.name));
    const results = [];
    for (const entry of files) {
      const filePath = path.join(importRoot, entry.name);
      const hash = await fileHash(filePath);
      if (state.files[entry.name]?.hash === hash) continue;
      const parsed = await parseTranscript(filePath);
      const messages = parsed.messages;
      if (!messages.length) { state.files[entry.name] = { hash, status: "ignored", updatedAt: new Date().toISOString() }; continue; }
      if (parsed.workspace) {
        const requiredScope = { layer: "memory", visibility: "project", project: workspaceKey(parsed.workspace) };
        if (!Array.isArray(scopes) || !scopes.some((grant) => scopeAllows(grant, requiredScope))) throw new Error(`workspace scope not allowed: ${requiredScope.project}`);
      }
      const result = await conversationMemory.enqueue({ messages, source: parsed.source || source, conversationId: parsed.conversationId || `file:${entry.name}`, eventId: parsed.eventId || hash, sessionId: parsed.sessionId, workspace: parsed.workspace, tags: parsed.tags, principal, scopes, extract });
      state.files[entry.name] = { hash, status: "queued", fingerprint: result.fingerprint, updatedAt: new Date().toISOString() };
      results.push({ file: entry.name, messages: messages.length, ...result });
    }
    await atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n");
    return { scanned: files.length, queued: results.length, results, statePath };
  }

  async function status() { const state = await readState(); return { root: importRoot, files: Object.values(state.files), count: Object.keys(state.files).length }; }
  async function readState() { try { const value = JSON.parse(await fs.readFile(statePath, "utf8")); return value?.files ? value : { version: 1, files: {} }; } catch { return { version: 1, files: {} }; } }
  return { scan, status, importRoot, statePath };
}

async function parseTranscript(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  if (filePath.toLowerCase().endsWith(".jsonl")) return { messages: text.split(/\r?\n/).map((line) => safeJson(line)).filter(Boolean).flatMap(normalizeRecord) };
  if (filePath.toLowerCase().endsWith(".json")) { const value = safeJson(text); return { messages: normalizeRecord(value), ...normalizeEnvelope(value) }; }
  const blocks = text.split(/\n(?=#{1,3}\s*(?:user|assistant|用户|助手)\b)/iu);
  return { messages: blocks.map((block) => { const match = block.match(/^#{1,3}\s*(user|assistant|用户|助手)\s*\r?\n([\s\S]*)$/iu); return match ? { role: /assistant|助手/iu.test(match[1]) ? "assistant" : "user", content: match[2].trim() } : null; }).filter(Boolean) };
}
function normalizeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(["source", "conversation_id", "event_id", "session_id", "workspace", "tags", "messages"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`unsupported transcript fields: ${unknown.join(", ")}`);
  if (Array.isArray(value.messages) && value.messages.some((message) => !message || typeof message !== "object" || Array.isArray(message) || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || Object.keys(message).some((key) => !["role", "content"].includes(key)))) throw new Error("transcript messages require role=user|assistant and string content; no other fields are allowed");
  return { source: value.source, conversationId: value.conversation_id, eventId: value.event_id, sessionId: value.session_id, workspace: value.workspace, tags: value.tags };
}
function normalizeRecord(value) { if (Array.isArray(value)) return value.flatMap(normalizeRecord); if (value?.messages) return normalizeRecord(value.messages); if (value && typeof value === "object" && typeof value.content === "string") return [{ role: value.role === "assistant" ? "assistant" : "user", content: value.content }]; return []; }
function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }
async function fileHash(filePath) { const data = await fs.readFile(filePath); return crypto.createHash("sha256").update(data).digest("hex"); }
async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }
