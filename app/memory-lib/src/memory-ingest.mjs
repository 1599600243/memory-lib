import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { containsCredentialSensitiveText, redactSensitiveText } from "./extraction-quality.mjs";
import { atomicWriteFile } from "./atomic-write.mjs";

const SUPPORTED = new Set([".md", ".txt", ".json", ".jsonl", ".csv", ".html", ".htm"]);
export function createMemoryIngest({ dataRoot, workspaceRoot, conversationMemory = null } = {}) {
  if (!dataRoot || !workspaceRoot) throw new Error("memory ingest requires dataRoot and workspaceRoot");
  const importsRoot = path.resolve(workspaceRoot, "imports");
  const statePath = path.join(dataRoot, "runtime", "ingest", ".import-state.json");
  const previews = new Map();
  let runQueue = Promise.resolve();

  function run(input = {}) {
    const next = runQueue.then(() => runInner(input));
    runQueue = next.catch(() => {});
    return next;
  }

  async function runInner(input = {}) {
    const principal = input.principal ?? {};
    const paths = Array.isArray(input.paths) ? input.paths.map(String).map((item) => item.trim()).filter(Boolean) : [];
    if (!paths.length) throw ingestError("PATHS_REQUIRED", "paths must not be empty");
    const resolvedPaths = paths.map((item) => path.resolve(workspaceRoot, item));
    if (!input.unrestricted && resolvedPaths.some((item) => !within(item, importsRoot))) throw ingestError("PATH_DENIED", `paths must stay within ${importsRoot}`);
    const canonicalImportsRoot = await fs.realpath(importsRoot).catch(() => importsRoot);
    const canonicalPaths = await Promise.all(resolvedPaths.map((item) => fs.realpath(item).catch(() => item)));
    if (!input.unrestricted && canonicalPaths.some((item) => !within(item, canonicalImportsRoot))) throw ingestError("PATH_DENIED", `paths must stay within ${importsRoot}`);
    const request = { ...normalizeRequest(input, canonicalPaths), unrestricted: input.unrestricted === true, importsRoot: canonicalImportsRoot };
    authorizeScope(request.scope, input.scopes);
    const { dry_run: _dryRun, ...previewRequest } = request;
    const previewKey = hash(JSON.stringify({ request: previewRequest, principal: principalKey(principal) }));
    const state = await readState(statePath);
    const plan = await buildPlan(request, state);
    const planSignature = hash(JSON.stringify({ planned: plan.planned.map((item) => [item.path, item.content_hash, item.kind]), skipped: plan.skipped.map((item) => [item.path, item.reason, item.content_hash ?? null]) }));
    if (request.dry_run) {
      previews.set(previewKey, { at: Date.now(), planSignature });
      return responseFor(plan, [], request, importsRoot);
    }
    const preview = previews.get(previewKey);
    if (!preview || Date.now() - preview.at > 30 * 60_000 || preview.planSignature !== planSignature) {
      previews.delete(previewKey);
      throw ingestError("DRY_RUN_REQUIRED", "run dry_run first with the same parameters and current files");
    }
    previews.delete(previewKey);
    const imported = [];
    for (const item of plan.planned) {
      if (item.kind === "conversation") {
        if (!conversationMemory) { plan.skipped.push({ path: item.path, reason: "conversation-handler-unavailable" }); continue; }
        const parsed = parseConversation(item.text, item.extension);
        if (!parsed.length) { plan.skipped.push({ path: item.path, reason: "no-conversation-messages" }); continue; }
        const workspace = request.scope?.visibility === "project" ? request.scope.project : undefined;
        const result = await conversationMemory.capture({ messages: parsed, source: request.source, conversationId: `file:${item.path}`, eventId: item.content_hash, workspace, tags: request.tags, principal, scopes: input.scopes, extract: request.extract });
        imported.push({ path: item.path, kind: item.kind, content_hash: item.content_hash, evidence_id: result.evidenceId, candidates_created: result.candidateCount });
      } else {
        const sourceDir = safeSegment(request.source);
        const base = safeSegment(path.basename(item.path, item.extension));
        const target = path.join(dataRoot, "evidence", "documents", sourceDir, `${base}-${item.content_hash.slice(0, 8)}.md`);
        const previous = state.paths[item.path] ?? null;
        const document = renderDocument({ item, request, principal, previous });
        await atomicWrite(target, document);
        imported.push({ path: item.path, kind: item.kind, target, content_hash: item.content_hash, prev_hash: previous?.hash ?? null, supersedes: previous?.target ?? null });
        state.paths[item.path] = { hash: item.content_hash, target, imported_at: item.imported_at };
      }
      state.hashes[item.content_hash] = { path: item.path, target: imported.at(-1)?.target ?? imported.at(-1)?.evidence_id ?? null };
    }
    for (const item of plan.skipped.filter((entry) => entry.reason === "duplicate-content" && entry.content_hash)) {
      const duplicate = state.hashes[item.content_hash];
      if (duplicate) state.paths[item.path] = { hash: item.content_hash, target: duplicate.target ?? null, imported_at: new Date().toISOString() };
    }
    if (imported.length || plan.skipped.some((entry) => entry.reason === "duplicate-content" && entry.content_hash)) await atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n");
    return responseFor(plan, imported, request, importsRoot);
  }

  return { run, importsRoot, statePath };
}

function normalizeRequest(input, resolvedPaths) {
  const kind = ["conversation", "document"].includes(input.kind) ? input.kind : null;
  return {
    paths: resolvedPaths,
    recursive: input.recursive === true,
    glob: typeof input.glob === "string" && input.glob.trim() ? input.glob.trim() : null,
    kind,
    source: String(input.source ?? "external:unknown").trim().slice(0, 160) || "external:unknown",
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 32) : [],
    scope: normalizeScope(input.scope),
    extract: input.extract === true,
    dry_run: input.dry_run !== false,
  };
}

async function buildPlan(request, state) {
  const candidates = [];
  const skipped = [];
  const seenHashes = new Set(Object.keys(state.hashes));
  for (const requested of request.paths) {
    const stat = await fs.stat(requested).catch(() => null);
    if (!stat) { skipped.push({ path: requested, reason: "not-found" }); continue; }
    if (stat.isFile()) candidates.push(requested);
    else if (stat.isDirectory()) candidates.push(...await collectFiles(requested, request.recursive));
    else skipped.push({ path: requested, reason: "unsupported-path-type" });
  }
  const planned = [];
  for (const candidatePath of [...new Set(candidates)].sort()) {
    const filePath = await fs.realpath(candidatePath).catch(() => null);
    if (!filePath) { skipped.push({ path: candidatePath, reason: "unreadable" }); continue; }
    if (!request.unrestricted && !within(filePath, request.importsRoot)) throw ingestError("PATH_DENIED", `resolved file escapes ${request.importsRoot}`);
    const extension = path.extname(filePath).toLowerCase();
    if (!SUPPORTED.has(extension)) { skipped.push({ path: filePath, reason: "unsupported-format" }); continue; }
    if (request.glob && !matchesGlob(filePath, request.glob, request.paths)) { skipped.push({ path: filePath, reason: "glob-mismatch" }); continue; }
    const raw = await fs.readFile(filePath, "utf8").catch(() => null);
    if (raw === null) { skipped.push({ path: filePath, reason: "unreadable" }); continue; }
    if (containsCredentialSensitiveText(raw)) { skipped.push({ path: filePath, reason: "credential-sensitive" }); continue; }
    const contentHash = hash(raw);
    if (seenHashes.has(contentHash)) { skipped.push({ path: filePath, reason: "duplicate-content", content_hash: contentHash }); continue; }
    seenHashes.add(contentHash);
    const text = extractText(raw, extension);
    if (!text.trim()) { skipped.push({ path: filePath, reason: "empty-content" }); continue; }
    if ((extension === ".json" && safeJson(raw) === null) || (extension === ".jsonl" && raw.split(/\r?\n/u).filter((line) => line.trim()).some((line) => safeJson(line) === null))) {
      skipped.push({ path: filePath, reason: "unparseable" });
      continue;
    }
    planned.push({ path: filePath, extension, kind: request.kind ?? inferKind(extension, text), content_hash: contentHash, text: redactSensitiveText(text), imported_at: new Date().toISOString() });
  }
  return { planned, skipped };
}

async function collectFiles(root, recursive) {
  const out = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isFile()) out.push(target);
    else if (recursive && entry.isDirectory()) out.push(...await collectFiles(target, true));
  }
  return out;
}

function matchesGlob(filePath, glob, roots) {
  const base = roots.find((root) => within(filePath, root) && root !== filePath) ?? path.dirname(filePath);
  const relative = path.relative(base, filePath).replaceAll("\\", "/");
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") { index += 1; pattern += "(?:.*/)?"; }
      else pattern += ".*";
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${pattern}$`, "iu").test(relative);
}

function extractText(raw, extension) {
  if (extension === ".html" || extension === ".htm") return raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/[ \t]+/gu, " ").replace(/\n\s*\n\s*\n/gu, "\n\n").trim();
  return raw;
}

function inferKind(extension, text) {
  if ([".json", ".jsonl"].includes(extension) && /"(?:messages|role|content)"/u.test(text)) return "conversation";
  if (/^#{1,3}\s*(?:user|assistant|用户|助手)\b/imu.test(text)) return "conversation";
  return "document";
}

function parseConversation(text, extension) {
  if (extension === ".jsonl") return text.split(/\r?\n/u).flatMap((line) => normalizeJson(safeJson(line)));
  if (extension === ".json") return normalizeJson(safeJson(text));
  return text.split(/\n(?=#{1,3}\s*(?:user|assistant|用户|助手)\b)/iu).map((block) => {
    const match = block.match(/^#{1,3}\s*(user|assistant|用户|助手)\s*\r?\n([\s\S]*)$/iu);
    return match ? { role: /assistant|助手/iu.test(match[1]) ? "assistant" : "user", content: match[2].trim() } : null;
  }).filter(Boolean);
}
function normalizeJson(value) { if (Array.isArray(value)) return value.flatMap(normalizeJson); if (value?.messages) return normalizeJson(value.messages); if (value && typeof value.content === "string") return [{ role: value.role === "assistant" ? "assistant" : "user", content: value.content }]; return []; }
function safeJson(value) { try { return JSON.parse(value); } catch { return null; } }

function renderDocument({ item, request, principal, previous }) {
  const id = `external-document-${item.content_hash.slice(0, 24)}`;
  return ["---", `id: ${id}`, "layer: evidence", "kind: document", "status: active", `source: ${JSON.stringify(request.source)}`, `original_path: ${JSON.stringify(item.path)}`, `content_hash: ${item.content_hash}`, `imported_at: ${item.imported_at}`, `principal: ${JSON.stringify(principalKey(principal))}`, `tags: ${JSON.stringify(request.tags)}`, ...(request.scope ? [`scope: ${JSON.stringify(request.scope)}`] : []), ...(previous ? [`prev_hash: ${previous.hash}`, `supersedes: ${JSON.stringify(previous.target)}`] : []), "---", "", item.text, ""].join("\n");
}

function responseFor(plan, imported, request, importsRoot) {
  return { planned: plan.planned.map(({ text, ...item }) => item), skipped: plan.skipped, imported, counts: { planned: plan.planned.length, skipped: plan.skipped.length, imported: imported.length }, impact: { directories: [...new Set(plan.planned.map((item) => item.kind === "document" ? path.join("evidence", "documents", safeSegment(request.source)) : path.join("evidence", "conversations")))], imports_root: importsRoot }, dry_run: request.dry_run };
}
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return { layer: "memory", visibility: "shared" };
  if (scope?.layer === "memory" && scope?.visibility === "shared" && scope.project === undefined) return { layer: "memory", visibility: "shared" };
  if (scope?.layer === "memory" && scope?.visibility === "project" && typeof scope.project === "string" && scope.project.trim()) return { layer: "memory", visibility: "project", project: safeSegment(scope.project) };
  throw ingestError("SCOPE_INVALID", "scope must be memory/shared or memory/project with a project");
}
function authorizeScope(scope, grants) {
  if (!Array.isArray(grants)) return;
  const allowed = grants.some((grant) => grant?.layer === scope.layer && grant?.visibility === scope.visibility && (scope.visibility !== "project" || grant?.project === "*" || grant?.project === scope.project));
  if (!allowed) throw ingestError("SCOPE_DENIED", "requested ingest scope is not allowed");
}
function principalKey(principal) { return { framework_id: principal?.framework_id ?? null, agent_id: principal?.agent_id ?? null, role_id: principal?.role_id ?? null }; }
function within(target, root) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function safeSegment(value) { return String(value ?? "external").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "external"; }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function ingestError(code, message) { const error = new Error(message); error.code = code; return error; }
async function readState(filePath) { try { const parsed = JSON.parse(await fs.readFile(filePath, "utf8")); return { version: 1, hashes: parsed.hashes ?? {}, paths: parsed.paths ?? {} }; } catch { return { version: 1, hashes: {}, paths: {} }; } }
async function atomicWrite(filePath, content) { return atomicWriteFile(filePath, content); }
