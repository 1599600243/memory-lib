#!/usr/bin/env node
/**
 * probe-day-role-matrix.mjs —— 用**同一份凭据、不同声明的 role_id**，量"按天枚举看见什么"
 *
 * 要回答的问题（SCENARIO-2-FOLLOWUP 的核心）：
 *   09-24 那条 role note（role_id = researcher）到底是谁看不见？
 *   新旧 sha 的差别，是"角色准入收紧"，还是"旧 sha 用了请求体声明的身份、新 sha 用凭据解析出的身份"？
 *
 * 两个目标各量一遍，逐个身份打印条数 + 争议条目在不在：
 *   A = 新 sha（真实数据副本上起临时实例）
 *   B = 生产 8787（旧 sha，只读）
 *
 * 用法：node probe-day-role-matrix.mjs [repoRoot] [copyRoot] [day]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const COPY = process.argv[3] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const DAY = process.argv[4] ?? "2026-09-24";
const ROLES = ["reader", "researcher", "capture-ingest"];
const TARGET = "curated/agents/pilot-01/role-7c963da877417294.md";
const SH = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const CRED = "memory-lib/deepseek-harness";
const PROD = "http://127.0.0.1:8787";
const PROD_SECRET_FILE = "D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret";
const norm = (p) => String(p ?? "").replace(/^.*?[\\/](memory)[\\/]/u, "$1/").replace(/\\/gu, "/").toLowerCase();

const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { recallScenario } = await import(pathToFileURL(path.join(REPO, "src/scenario-recall.mjs")).href);
const { rotateCredential } = await import(pathToFileURL(path.join(REPO, "src/identity-admin.mjs")).href);
const { readSecret } = await import(pathToFileURL(path.join(REPO, "src/credential-resolver.mjs")).href);

const dataRoot = path.join(COPY, "memory");
const secretsDir = path.join(COPY, "runtime", "secrets");
const secretStore = { type: "file", dir: secretsDir };
await rotateCredential({ secretsDir, credentialRef: CRED });
const secret = String(await readSecret(secretStore, CRED) ?? "").trim();
const server = createLocalhostServer({
  registryPath: path.join(COPY, "runtime", "identity.json"), secretStore, dataRoot, workspaceRoot: COPY,
  auditPath: path.join(COPY, "runtime", "audit", "role-matrix.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: SH,
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot: COPY, scopes, principal, vectorLane: { probe: false } }),
});
const { port } = await server.listen();
const prodSecret = (await fs.readFile(PROD_SECRET_FILE, "utf8")).trim();

console.log(`A = 新 sha：${REPO}`);
console.log(`B = 生产 8787（旧 sha）`);
console.log(`day = ${DAY}   争议条目 = ${TARGET}\n`);
console.log("目标 | 声明的 role_id | 取回条数 | 含争议条目");
console.log("-----|----------------|----------|-------------");

for (const role of ROLES) {
  // A：新 sha（走参考实现，pageSize 开满）
  let aCount = "ERR", aHas = "-";
  try {
    const r = await recallScenario({
      baseUrl: `http://127.0.0.1:${port}`, credentials: { credential_ref: CRED, secret },
      principal: { agent_id: "pilot-01", role_id: role }, text: `${DAY} 我们聊了什么`, now: NOW, timezone: SH, pageSize: 100,
    });
    const set = new Set((r?.items ?? []).map((x) => norm(x.path)));
    aCount = r?.count ?? "?";
    aHas = set.has(norm(TARGET)) ? "有" : "无";
  } catch (error) { aCount = `ERR ${String(error?.message ?? error).slice(0, 40)}`; }
  console.log(`A    | ${role.padEnd(14)} | ${String(aCount).padStart(8)} | ${aHas}`);

  // B：生产（旧 sha，只读，since/until 翻页取全）
  let bCount = "ERR", bHas = "-";
  try {
    const set = new Set();
    let off = 0;
    for (let page = 0; page < 60; page += 1) {
      const res = await fetch(`${PROD}/v1/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential_ref: CRED, secret: prodSecret, principal: { agent_id: "pilot-01", role_id: role }, since: DAY, until: DAY, limit: 100, offset: off }),
      });
      const body = await res.json();
      if (res.status !== 200) { bCount = `${res.status} ${String(body?.error ?? "").slice(0, 30)}`; break; }
      for (const it of body.results ?? []) set.add(norm(it.path));
      if (body.next_offset === null || body.next_offset === undefined) { bCount = set.size; break; }
      off = body.next_offset;
    }
    bHas = set.has(norm(TARGET)) ? "有" : "无";
  } catch (error) { bCount = `ERR ${String(error?.message ?? error).slice(0, 40)}`; }
  console.log(`B    | ${role.padEnd(14)} | ${String(bCount).padStart(8)} | ${bHas}`);
}
console.log("");

// 附带：凭据自己解析出的身份（谁说了算）
for (const probe of ["/v1/whoami", "/v1/admin/whoami"]) {
  try {
    const res = await fetch(`${PROD}${probe}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CRED, secret: prodSecret, principal: { agent_id: "pilot-01", role_id: "researcher" } }) });
    const body = await res.text();
    console.log(`B ${probe} → ${res.status} ${body.slice(0, 300)}`);
  } catch (error) { console.log(`B ${probe} → ERR ${String(error?.message ?? error).slice(0, 60)}`); }
}
await server.close();
