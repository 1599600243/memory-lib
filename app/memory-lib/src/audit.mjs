// memory-lib Slice 2 — audit log (append-only JSONL).
// Auditable but non-leaking: fixed field whitelist. Never records secrets,
// Authorization headers, full query results, or error stack traces.
// F3 adds three fields for the server-side auto-review lane (channel "auto-review"):
// decision / rule / dryRun describe WHICH rule fired and whether it was applied — never
// the candidate's text, so a routing decision can be audited without copying content.
import fs from "node:fs/promises";
import fscb from "node:fs";
import path from "node:path";

const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;

function withScanMeta(events, meta) {
  Object.defineProperties(events, {
    truncated: { value: meta.truncated === true, enumerable: false },
    scanned_bytes: { value: meta.scanned_bytes ?? 0, enumerable: false },
  });
  return events;
}

export async function readAuditTail(auditPath, { limit = 100, allow = null, maxScanBytes = DEFAULT_MAX_SCAN_BYTES, chunkBytes = DEFAULT_TAIL_CHUNK_BYTES } = {}) {
  const wanted = Math.max(1, Math.min(1000, Number(limit) || 100));
  const scanLimit = Math.max(1, Number(maxScanBytes) || DEFAULT_MAX_SCAN_BYTES);
  const blockSize = Math.max(1024, Number(chunkBytes) || DEFAULT_TAIL_CHUNK_BYTES);
  let handle;
  try {
    handle = await fs.open(auditPath, "r");
    const stat = await handle.stat();
    const found = [];
    let carry = Buffer.alloc(0);
    let position = stat.size;
    let scanned = 0;
    let stopped = false;
    while (position > 0 && scanned < scanLimit && found.length < wanted) {
      const take = Math.min(blockSize, position, scanLimit - scanned);
      position -= take;
      const block = Buffer.alloc(take);
      const { bytesRead } = await handle.read(block, 0, take, position);
      scanned += bytesRead;
      carry = Buffer.concat([block.subarray(0, bytesRead), carry]);
      const parts = [];
      let end = carry.length;
      for (let i = carry.length - 1; i >= 0; i -= 1) {
        if (carry[i] !== 10) continue;
        parts.push(carry.subarray(i + 1, end));
        end = i;
      }
      carry = carry.subarray(0, end);
      for (let i = 0; i < parts.length && found.length < wanted; i += 1) {
        const line = parts[i].toString("utf8").trim();
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (allow === null || event.allow === allow) found.push(event);
        } catch { /* ignore incomplete or malformed audit lines */ }
      }
      if (bytesRead < take) break;
    }
    if (found.length < wanted && position === 0 && carry.length) {
      const line = carry.toString("utf8").trim();
      if (line) {
        try {
          const event = JSON.parse(line);
          if (allow === null || event.allow === allow) found.push(event);
        } catch { /* a partially written final line is not returned */ }
      }
    }
    stopped = found.length < wanted && position > 0 && scanned >= scanLimit;
    return withScanMeta(found, { truncated: stopped, scanned_bytes: scanned });
  } catch {
    return withScanMeta([], { truncated: false, scanned_bytes: 0 });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function auditCountPath(auditPath) {
  return path.join(path.dirname(auditPath), `.${path.basename(auditPath, path.extname(auditPath))}.count.json`);
}

export async function countAuditLines(auditPath) {
  let stat;
  try { stat = await fs.stat(auditPath); } catch { return 0; }
  const sidecar = auditCountPath(auditPath);
  try {
    const cached = JSON.parse(await fs.readFile(sidecar, "utf8"));
    if (cached.bytes === stat.size && Number.isSafeInteger(cached.lines)) return cached.lines;
  } catch { /* stream and refresh the derived count */ }
  const lines = await new Promise((resolve) => {
    let count = 0;
    let bytes = 0;
    let lastByte = null;
    const stream = fscb.createReadStream(auditPath);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      lastByte = chunk.at(-1);
      let offset = -1;
      while ((offset = chunk.indexOf(10, offset + 1)) !== -1) count += 1;
    });
    stream.on("error", () => resolve(0));
    stream.on("end", () => resolve(count + (bytes > 0 && lastByte !== 10 ? 1 : 0)));
  });
  try {
    const after = await fs.stat(auditPath);
    if (after.size === stat.size) await fs.writeFile(sidecar, `${JSON.stringify({ bytes: stat.size, lines })}\n`, "utf8");
  } catch { /* count remains useful even if the cache cannot be written */ }
  return lines;
}

export async function readAuditLines(auditPath, options = {}) {
  const result = await readAuditTail(auditPath, { ...options, limit: options.limit ?? 1000 });
  return result.reverse();
}

export function createAuditLog(auditPath, { aggregationWindowMs = 60_000, now = () => Date.now() } = {}) {
  let pending = null;
  let chain = Promise.resolve();

  function aggregationKey(event) {
    return JSON.stringify([event.action ?? null, event.denyReason ?? null, event.agent ?? null, event.role ?? null, event.credentialFingerprint ?? null]);
  }

  async function appendLine(line) {
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, line, "utf8");
  }

  function enqueue(task) {
    chain = chain.then(task, task).catch((err) => console.error(`audit write failed: ${err.message}`));
    return chain;
  }

  async function flushPending() {
    if (!pending) return;
    const item = pending;
    pending = null;
    if (item.count > 1) {
      const { window_head, ...aggregateBase } = item.base;
      await appendLine(`${JSON.stringify({ ...aggregateBase, repeat: item.count - 1, window_start: new Date(item.startedAt).toISOString(), window_end: new Date(item.endedAt).toISOString(), aggregated: true })}\n`);
    }
  }

  return {
    async record(event) {
      const timestamp = now();
      const denied = event.allow !== true;
      const key = denied ? aggregationKey(event) : null;
      const current = pending;
      if (current && (!denied || key !== current.key || timestamp - current.startedAt >= aggregationWindowMs)) {
        await enqueue(() => flushPending());
      }
      const auditEvent = {
        ts: new Date().toISOString(),
        requestId: event.requestId ?? null,
        channel: event.channel ?? "localhost",
        framework: event.framework ?? null,
        agent: event.agent ?? null,
        role: event.role ?? null,
        container: event.container ?? null,
        visibility: event.visibility ?? null,
        group_id: event.group_id ?? null,
        user_id: event.user_id ?? null,
        credentialFingerprint: event.credentialFingerprint ?? null,
        auth_method: event.auth_method ?? null,
        action: event.action ?? null,
        scope: event.scope ?? null,
        resourceId: event.resourceId ?? null,
        allow: event.allow === true,
        denyReason: event.denyReason ?? null,
        latencyMs: typeof event.latencyMs === "number" ? Math.round(event.latencyMs) : null,
        decision: event.decision ?? null,
        rule: event.rule ?? null,
        dryRun: event.dryRun === true,
        ...(event.replacementId ? { replacementId: event.replacementId } : {}),
        ...(event.merge_sources ? { merge_sources: event.merge_sources } : {}),
        ...(event.target_id ? { target_id: event.target_id } : {}),
        ...(typeof event.similarity === "number" ? { similarity: event.similarity } : {}),
        ...(typeof event.similarity_threshold === "number" ? { similarity_threshold: event.similarity_threshold } : {}),
        ...(event.basis ? { basis: event.basis } : {}),
        ...(event.evidence_comparison ? { evidence_comparison: event.evidence_comparison } : {}),
        ...(event.version_decision ? { version_decision: event.version_decision } : {}),
        ...(event.source ? { source: event.source } : {}),
        ...(event.target ? { target: event.target } : {}),
        ...(event.recallCount !== undefined ? { recallCount: event.recallCount } : {}),
        ...(event.audit_id ? { audit_id: event.audit_id } : {}),
        ...(event.reason ? { reason: String(event.reason).slice(0, 500) } : {}),
        ...(event.deleted_at ? { deleted_at: event.deleted_at } : {}),
        ...(Array.isArray(event.ingest_paths) ? { ingest_paths: event.ingest_paths.map(String).slice(0, 32) } : {}),
        ...(event.recursive !== undefined ? { recursive: event.recursive === true } : {}),
        ...(event.glob ? { glob: String(event.glob).slice(0, 240) } : {}),
        ...(event.kind ? { kind: String(event.kind).slice(0, 40) } : {}),
        ...(event.ingest_counts ? { ingest_counts: event.ingest_counts } : {}),
      };
      const line = JSON.stringify(auditEvent) + "\n";
      try {
        if (denied) {
          if (pending && pending.key === key && timestamp - pending.endedAt < aggregationWindowMs) {
            pending.count += 1;
            pending.endedAt = timestamp;
            return;
          }
          const headEvent = { ...auditEvent, window_head: true };
          await appendLine(`${JSON.stringify(headEvent)}\n`);
          pending = { key, base: headEvent, count: 1, startedAt: timestamp, endedAt: timestamp };
          return;
        }
        await enqueue(() => flushPending());
        await appendLine(line);
      } catch (err) {
        // audit must never crash the request path; surface as a warning field later
        console.error(`audit write failed: ${err.message}`);
      }
    },
    async flush() { await enqueue(() => flushPending()); },
  };
}

