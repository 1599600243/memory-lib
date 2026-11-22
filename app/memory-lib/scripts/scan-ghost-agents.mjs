// GHOST-1：只读巡检——把审计里出现过的 agent 与身份登记表对账，标出“未注册但在活动”的幽灵身份。
// 只读：不写任何文件；发现幽灵也返回 0（只报告，方便接进巡检）。
// 用法：
//   node scripts/scan-ghost-agents.mjs [--audit <path>] [--registry <path>] [--identities <path>] [--tail <n>] [--json]
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_AUDIT = "D:\\MemoryLib\\data\\runtime\\audit\\access.jsonl";
export const DEFAULT_REGISTRY = "D:\\MemoryLib\\data\\runtime\\identity.json";
export const DEFAULT_IDENTITIES = "D:\\MemoryLib\\data\\runtime\\identities.json";
export const DEFAULT_TAIL = 20000;

export function parseArgs(argv) {
  const options = { audit: DEFAULT_AUDIT, registry: DEFAULT_REGISTRY, identities: DEFAULT_IDENTITIES, tail: DEFAULT_TAIL, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    const match = arg.match(/^--(audit|registry|identities|tail)(?:=(.*))?$/u);
    if (!match) throw new Error(`unknown option: ${arg}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === "") throw new Error(`--${match[1]} requires a value`);
    if (match[1] === "tail") {
      const tail = Number(value);
      if (!Number.isInteger(tail) || tail <= 0) throw new Error("--tail must be a positive integer");
      options.tail = tail;
    } else options[match[1]] = value;
  }
  return options;
}

// 审计的拒绝事件按分钟聚合成一行（repeat=聚合掉的次数），所以“事件数”要把 repeat 加回来。
export function parseAuditLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (typeof record.agent !== "string" || !record.agent) return null;
  const repeat = Number.isInteger(record.repeat) && record.repeat > 0 ? record.repeat : 0;
  return {
    agent: record.agent,
    role: typeof record.role === "string" ? record.role : null,
    allow: record.allow === true,
    denyReason: typeof record.denyReason === "string" ? record.denyReason : null,
    ts: typeof record.ts === "string" ? record.ts : null,
    events: 1 + repeat,
  };
}

export function aggregateAgents(lines) {
  const agents = new Map();
  let skipped = 0;
  let records = 0;
  for (const line of lines) {
    if (typeof line !== "string" || !line.trim()) continue;
    const record = parseAuditLine(line);
    if (!record) { skipped += 1; continue; }
    records += record.events;
    const stat = agents.get(record.agent) ?? { agent: record.agent, allow: 0, deny: 0, events: 0, last: null, roles: new Set(), denyReasons: new Map() };
    if (record.allow) stat.allow += record.events;
    else {
      stat.deny += record.events;
      const reason = record.denyReason ?? "(none)";
      stat.denyReasons.set(reason, (stat.denyReasons.get(reason) ?? 0) + record.events);
    }
    stat.events += record.events;
    if (record.role) stat.roles.add(record.role);
    if (record.ts && (!stat.last || Date.parse(record.ts) > Date.parse(stat.last))) stat.last = record.ts;
    agents.set(record.agent, stat);
  }
  return { agents, skipped, records };
}

export function registrySets(registryJson, identitiesJson) {
  const identityAgents = new Set();
  for (const framework of Array.isArray(registryJson?.frameworks) ? registryJson.frameworks : []) {
    for (const agent of Array.isArray(framework?.agents) ? framework.agents : []) {
      if (typeof agent?.agent_id === "string" && agent.agent_id) identityAgents.add(agent.agent_id);
    }
  }
  const identityRecords = new Set();
  for (const record of Array.isArray(identitiesJson?.identities) ? identitiesJson.identities : []) {
    if (typeof record?.agent_id === "string" && record.agent_id) identityRecords.add(record.agent_id);
  }
  return { identityAgents, identityRecords };
}

export function summarize({ agents, skipped, records }, { identityAgents, identityRecords }) {
  const rows = [...agents.values()]
    .map((stat) => {
      const inIdentity = identityAgents.has(stat.agent);
      const inIdentities = identityRecords.has(stat.agent);
      const status = inIdentity ? "ok" : inIdentities ? "identities-only" : "GHOST";
      return {
        agent: stat.agent,
        roles: [...stat.roles].sort(),
        allow: stat.allow,
        deny: stat.deny,
        events: stat.events,
        last: stat.last,
        denyReasons: Object.fromEntries([...stat.denyReasons.entries()].sort((a, b) => b[1] - a[1])),
        inIdentity,
        inIdentities,
        status,
      };
    })
    .sort((a, b) => b.deny - a.deny || b.events - a.events || a.agent.localeCompare(b.agent));
  return {
    rows,
    ghosts: rows.filter((row) => row.status === "GHOST"),
    identitiesOnly: rows.filter((row) => row.status === "identities-only"),
    totals: {
      agents: rows.length,
      records,
      skipped,
      ghosts: rows.filter((row) => row.status === "GHOST").length,
      identitiesOnly: rows.filter((row) => row.status === "identities-only").length,
    },
  };
}

export function formatReport(summary, meta = {}) {
  const lines = [];
  if (meta.audit) lines.push(`audit: ${meta.audit}`);
  if (meta.tail) lines.push(`tail: last ${meta.tail} lines`);
  lines.push(`scanned: ${summary.totals.agents} agents, ${summary.totals.records} events, ${summary.totals.skipped} skipped lines (invalid JSON / no agent)`);
  if (meta.identityAgents !== undefined) lines.push(`registry: ${meta.identityAgents} agents | identities: ${meta.identityRecords} records`);
  lines.push("");
  lines.push(["AGENT".padEnd(26), "ALLOW".padStart(6), "DENY".padStart(6), "LAST(ts)".padEnd(26), "identity.json".padEnd(13), "identities.json".padEnd(15), "STATUS"].join(" "));
  for (const row of summary.rows) {
    lines.push([
      row.agent.padEnd(26),
      String(row.allow).padStart(6),
      String(row.deny).padStart(6),
      String(row.last ?? "-").padEnd(26),
      (row.inIdentity ? "yes" : "no").padEnd(13),
      (row.inIdentities ? "yes" : "no").padEnd(15),
      row.status,
    ].join(" "));
  }
  lines.push("");
  if (summary.ghosts.length) {
    lines.push(`GHOST (未注册但在活动): ${summary.ghosts.length}`);
    for (const ghost of summary.ghosts) {
      const reasons = Object.entries(ghost.denyReasons).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
      lines.push(`  - ${ghost.agent}  events=${ghost.events} (allow=${ghost.allow}, deny=${ghost.deny})  last=${ghost.last ?? "-"}  denyReasons: ${reasons}`);
    }
  } else lines.push("GHOST (未注册但在活动): 0");
  if (summary.identitiesOnly.length) {
    lines.push(`IDENTITIES-ONLY (在 identities.json、不在 identity.json): ${summary.identitiesOnly.length}`);
    for (const row of summary.identitiesOnly) lines.push(`  - ${row.agent}  events=${row.events}  last=${row.last ?? "-"}`);
  } else lines.push("IDENTITIES-ONLY (在 identities.json、不在 identity.json): 0");
  return lines.join("\n");
}

async function readJsonOrNull(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`cannot read ${filePath}: ${error.message}`);
  }
}

function countNewlines(buffer) {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 10) count += 1;
  return count;
}

// 从文件尾部倒着读，避免把 60MB 审计整体读进内存。
export async function readTailLines(filePath, limit) {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const chunkSize = 64 * 1024;
    let position = size;
    let newlines = 0;
    let buffer = Buffer.alloc(0);
    while (position > 0 && newlines <= limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, position);
      newlines += countNewlines(chunk);
      buffer = Buffer.concat([chunk, buffer]);
    }
    let text = buffer.toString("utf8");
    if (position > 0) {
      const cut = text.indexOf("\n");
      text = cut >= 0 ? text.slice(cut + 1) : "";
    }
    return text.split(/\r?\n/u).filter((line) => line.trim()).slice(-limit);
  } finally {
    await handle.close();
  }
}

export async function scan(options = {}) {
  const audit = path.resolve(options.audit ?? DEFAULT_AUDIT);
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  const identitiesPath = options.identities ?? path.join(path.dirname(registryPath), "identities.json");
  const tail = options.tail ?? DEFAULT_TAIL;
  const lines = await readTailLines(audit, tail);
  const aggregation = aggregateAgents(lines);
  const registryJson = await readJsonOrNull(registryPath);
  const identitiesJson = await readJsonOrNull(identitiesPath);
  const sets = registrySets(registryJson, identitiesJson);
  const summary = summarize(aggregation, sets);
  return {
    summary,
    meta: {
      audit,
      tail,
      registry: registryPath,
      identities: identitiesPath,
      identityAgents: sets.identityAgents.size,
      identityRecords: sets.identityRecords.size,
      registryLoaded: registryJson !== null,
      identitiesLoaded: identitiesJson !== null,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (options.help) {
    console.log("用法: node scripts/scan-ghost-agents.mjs [--audit <path>] [--registry <path>] [--identities <path>] [--tail <n>] [--json]");
    return 0;
  }
  let result;
  try { result = await scan(options); } catch (error) {
    console.error(`scan failed: ${error.message}`);
    return 1;
  }
  const { summary, meta } = result;
  if (options.json) console.log(JSON.stringify({ meta, ...summary }, null, 2));
  else {
    console.log(formatReport(summary, meta));
    if (!meta.registryLoaded) console.log(`warning: registry not found at ${meta.registry}`);
    if (!meta.identitiesLoaded) console.log(`warning: identities not found at ${meta.identities}`);
  }
  // 只报告：发现幽灵也返回 0，方便接入巡检而不让任务失败。
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
