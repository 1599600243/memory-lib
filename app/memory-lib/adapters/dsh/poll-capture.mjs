// DSH -> memory-lib external conversation capture poller.
// Repository source of truth; deploy with scripts/sync-capture-deployment.mjs.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
let createSessionSnapshot;

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const SESSIONS_ROOT = path.join(HOME, "sessions");
const WORK_DIR = path.join(HOME, "memory-capture");
const STATE_FILE = path.join(WORK_DIR, "state.json");
const HEARTBEAT_FILE = path.join(WORK_DIR, "heartbeat.json");
const LOG_FILE = path.join(WORK_DIR, "capture.log");
const WORKSPACE_MAP_FILE = path.join(WORK_DIR, "workspace-map.json");
const SEVEN_ZIP = ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"].find((file) => fs.existsSync(file));
const API_BASE = process.env.MEMORY_LIB_URL ?? "http://127.0.0.1:8787";
const MAX_TEXT = 8000;
const MAX_DAYS = Math.max(1, Number(process.env.MEMORY_LIB_CAPTURE_MAX_DAYS) || 7);
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const BACKFILL = process.argv.includes("--backfill");
const SESSION_ID_FILTER = process.env.MEMORY_LIB_CAPTURE_SESSION_ID?.trim() || null;
const SESSION_DIR_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const snapshotAndExtract = (zipPath, tmpDir, sessionId) => createSessionSnapshot(zipPath, tmpDir, sessionId, { sevenZip: SEVEN_ZIP });

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const rotated = path.join(WORK_DIR, `capture.${stamp}.log`);
    if (fs.statSync(LOG_FILE).size > 0 && !fs.existsSync(rotated)) fs.renameSync(LOG_FILE, rotated);
    for (const entry of fs.readdirSync(WORK_DIR)) {
      if (!entry.startsWith("capture.") || !entry.endsWith(".log")) continue;
      const full = path.join(WORK_DIR, entry);
      if (Date.now() - fs.statSync(full).mtimeMs > 14 * 86400_000) fs.rmSync(full, { force: true });
    }
  } catch { /* best effort */ }
}
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  if (VERBOSE) console.log(line);
  try { fs.mkdirSync(WORK_DIR, { recursive: true }); rotateLog(); fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* best effort */ }
}

function loadAuth() {
  let ref = process.env.MEMORY_LIB_CRED_REF;
  let secret = process.env.MEMORY_LIB_SECRET;
  let agent = process.env.MEMORY_LIB_AGENT ?? "pilot-01";
  const role = process.env.MEMORY_LIB_CAPTURE_ROLE ?? "capture-ingest";
  if (!ref || !secret) {
    const patch = path.join(HOME, "profiles", "web", "cordis.patch.yml");
    try {
      const yml = fs.readFileSync(patch, "utf8");
      ref ||= yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/u)?.[1]?.trim();
      secret ||= yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/u)?.[1]?.trim();
    } catch { /* environment may supply credentials */ }
  }
  if (!ref || !secret) throw new Error("missing memory-lib credentials");
  return { credential_ref: ref, secret, principal: { agent_id: agent, role_id: process.env.MEMORY_LIB_CAPTURE_ROLE ?? role ?? "capture-ingest" } };
}

function loadWorkspaceMap() {
  try { return JSON.parse(process.env.MEMORY_LIB_WORKSPACE_MAP || fs.readFileSync(WORKSPACE_MAP_FILE, "utf8")); } catch { return {}; }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { sessions: {}, unmappedWorkspaceWarnings: {} }; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}
function writeState(state) { writeJsonAtomic(STATE_FILE, state); }
function readHeartbeat() {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8")); } catch { return {}; }
}
function writeHeartbeat(fields) {
  const previous = readHeartbeat();
  const now = new Date().toISOString();
  const ok = fields.ok === true;
  const failed = fields.status === "failed";
  writeJsonAtomic(HEARTBEAT_FILE, {
    ...previous,
    ...fields,
    pid: process.pid,
    lastRunAt: fields.lastRunAt ?? previous.lastRunAt ?? now,
    lastSuccessAt: ok ? now : previous.lastSuccessAt ?? null,
    lastError: ok ? null : failed ? String(fields.error ?? "capture failed") : previous.lastError ?? null,
    consecutiveFailures: ok ? 0 : failed ? Number(previous.consecutiveFailures ?? 0) + 1 : Number(previous.consecutiveFailures ?? 0),
    finishedAt: now,
  });
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
}
function parseTurns(jsonlPath) {
  const turns = new Map();
  let current = null;
  for (const line of fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/u)) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "turn/start") {
      current = row.data?.turn ?? current;
      if (current != null && !turns.has(current)) turns.set(current, { messages: [] });
      continue;
    }
    if (current == null) continue;
    const bucket = turns.get(current) ?? (turns.set(current, { messages: [] }), turns.get(current));
    if (row.type === "user/message") {
      if (row.data?.source?.kind !== "user") continue;
      const text = textOfContent(row.data?.content);
      if (!text || text.startsWith("Current runtime context")) continue;
      bucket.messages.push({ role: "user", content: text.slice(0, MAX_TEXT) });
    } else if (row.type === "assistant/message") {
      const text = textOfContent(row.data?.message?.content);
      if (text) bucket.messages.push({ role: "assistant", content: text.slice(0, MAX_TEXT) });
    }
  }
  return turns;
}

async function post(pathname, body) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const capture = (auth, event) => post("/v1/conversations/capture", { ...auth, ...event });

function listSessionFiles(workspaceMap, cutoff) {
  return fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((profile) => {
    const profilePath = path.join(SESSIONS_ROOT, profile.name);
    return fs.readdirSync(profilePath, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SESSION_DIR_PATTERN.test(entry.name) && (!SESSION_ID_FILTER || entry.name === SESSION_ID_FILTER)).map((entry) => {
      const zip = path.join(profilePath, entry.name, "session.jsonl.zstd");
      return fs.existsSync(zip) ? { sessionId: entry.name, workspace: typeof workspaceMap[profile.name] === "string" ? workspaceMap[profile.name] : null, profileDir: profile.name, zip, stat: fs.statSync(zip) } : null;
    }).filter(Boolean);
  }).filter((file) => file.stat.mtimeMs >= cutoff);
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeHeartbeat({ status: "running", lastRunAt: new Date().toISOString() });
  ({ snapshotAndExtract: createSessionSnapshot } = await import("./session-snapshot.mjs"));
  if (!SEVEN_ZIP) {
    writeHeartbeat({ ok: false, status: "failed", error: "7z.exe was not found" });
    log("SKIP: 7z.exe was not found");
    process.exitCode = 1;
    return;
  }
  const auth = loadAuth();
  const workspaceMap = loadWorkspaceMap();
  const state = readState();
  const files = listSessionFiles(workspaceMap, Date.now() - MAX_DAYS * 86400_000);
  const tmpDir = path.join(WORK_DIR, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  let evidenceWritten = 0;
  let candidatesCreated = 0;
  let skipped = 0;
  let failed = 0;
  let baselined = 0;

  for (const file of files) {
    const previous = state.sessions[file.sessionId];
    if (!file.workspace && !state.unmappedWorkspaceWarnings?.[file.profileDir]) {
      state.unmappedWorkspaceWarnings = { ...(state.unmappedWorkspaceWarnings ?? {}), [file.profileDir]: new Date().toISOString() };
      log(`WARN ${file.profileDir}: workspace is unmapped; retaining shared behavior`);
    }
    if (previous && previous.size === file.stat.size && previous.mtimeMs === file.stat.mtimeMs) { skipped++; continue; }
    let runDir = null;
    try {
      const snapshot = await snapshotAndExtract(file.zip, tmpDir, file.sessionId);
      runDir = snapshot.runDir;
      const turns = parseTurns(snapshot.jsonl);
      const maxAvailableTurn = turns.size ? Math.max(...turns.keys()) : 0;
      if (!previous && !BACKFILL) {
        state.sessions[file.sessionId] = { maxTurn: maxAvailableTurn, size: file.stat.size, mtimeMs: file.stat.mtimeMs, baselineAt: new Date().toISOString() };
        if (!DRY_RUN) writeState(state);
        baselined++;
        log(`BASELINE ${file.sessionId} maxTurn=${maxAvailableTurn}`);
        fs.rmSync(runDir, { recursive: true, force: true });
        continue;
      }
      let maxTurn = previous?.maxTurn ?? 0;
      for (const [turn, bucket] of [...turns.entries()].sort((a, b) => a[0] - b[0])) {
        if (turn <= (previous?.maxTurn ?? 0) || !bucket.messages.length) continue;
        const event = { source: "dsh-session", conversation_id: file.sessionId, event_id: `${file.sessionId}#turn-${turn}`, ...(file.workspace ? { workspace: file.workspace } : {}), messages: bucket.messages };
        if (DRY_RUN) { console.log(`[dry-run] ${event.event_id} messages=${bucket.messages.length}`); maxTurn = Math.max(maxTurn, turn); continue; }
        try {
          const result = await capture(auth, event);
          evidenceWritten++;
          candidatesCreated += Number(result.candidateCount ?? 0);
          maxTurn = Math.max(maxTurn, turn);
          log(`OK ${event.event_id} evidence=${result.evidenceId} evidence_written=1 candidates_created=${Number(result.candidateCount ?? 0)}`);
        } catch (error) {
          failed++;
          log(`FAIL ${event.event_id}: ${error.message} (retry next run)`);
          break;
        }
      }
      state.sessions[file.sessionId] = { ...previous, maxTurn, size: file.stat.size, mtimeMs: file.stat.mtimeMs, updatedAt: new Date().toISOString() };
      if (!DRY_RUN) writeState(state);
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch (error) {
      failed++;
      log(`ERROR ${file.sessionId}: ${error.message}`);
      if (runDir) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }

  const ok = failed === 0;
  const error = failed > 0 ? `${failed} capture operation(s) failed` : null;
  writeHeartbeat({ ok, status: ok ? "success" : "failed", evidence_written: evidenceWritten, candidates_created: candidatesCreated, baselined, skipped, failed, files: files.length, error });
  log(`DONE files=${files.length} evidence_written=${evidenceWritten} candidates_created=${candidatesCreated} baselined=${baselined} skipped=${skipped} failed=${failed}`);
  if (!VERBOSE) console.log(`capture done: files=${files.length} evidence_written=${evidenceWritten} candidates_created=${candidatesCreated} baselined=${baselined} skipped=${skipped} failed=${failed}`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  try { writeHeartbeat({ ok: false, status: "failed", error: error.message }); } catch { /* best effort */ }
  log(`FATAL ${error.message}`);
  console.error(error.message);
  process.exitCode = 1;
});
