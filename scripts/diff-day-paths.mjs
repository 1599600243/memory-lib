#!/usr/bin/env node
/**
 * diff-day-paths.mjs —— 把"某个 sha 的按天枚举结果"与"生产 8787 的按天枚举结果"逐路径对差
 *
 * 用途：当 A（新 sha）与 B（生产）对同一天的条数不一致时，判断是
 *   ① A 漏了（真回归）  ② A 多了（越权/口径变宽）  ③ 只是口径差（哪一条、为什么）。
 * 只看数字永远说不清，必须看**是哪一条**。
 *
 * 用法：node diff-day-paths.mjs [repoRoot] [copyRoot] [day...]
 * 默认 day：2026-09-24
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const COPY = process.argv[3] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const DAYS = process.argv.slice(4).length ? process.argv.slice(4) : ["2026-09-24"];
const SH = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const CRED = "memory-lib/deepseek-harness";
const PROD = "http://127.0.0.1:8787";
const PROD_SECRET_FILE = "D:\\MemoryLib\\data\\runtime\\secrets\\memory-lib_deepseek-harness.secret";
const norm = (p) => String(p ?? "").replace(/^.*?[\\/](memory)[\\/]/u, "$1/").replace(/\\/gu, "/").toLowerCase();

const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
// ⚠️ 不能静态 import scenario-recall.mjs：**旧 sha 还没有这个文件**（SCENARIO-1 才引入），
//    在 A_MODE=bare（专门用来跑旧 sha）时会直接 ERR_MODULE_NOT_FOUND。
const { recallScenario } = (process.env.A_MODE ?? "recall") === "recall"
  ? await import(pathToFileURL(path.join(REPO, "src/scenario-recall.mjs")).href)
  : { recallScenario: null };
const { rotateCredential } = await import(pathToFileURL(path.join(REPO, "src/identity-admin.mjs")).href);
const { readSecret } = await import(pathToFileURL(path.join(REPO, "src/credential-resolver.mjs")).href);

// A：新 sha + 真实数据副本
const dataRoot = path.join(COPY, "memory");
const secretsDir = path.join(COPY, "runtime", "secrets");
const secretStore = { type: "file", dir: secretsDir };
await rotateCredential({ secretsDir, credentialRef: CRED });
const secret = String(await readSecret(secretStore, CRED) ?? "").trim();
const server = createLocalhostServer({
  registryPath: path.join(COPY, "runtime", "identity.json"), secretStore, dataRoot, workspaceRoot: COPY,
  auditPath: path.join(COPY, "runtime", "audit", "diff-day.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: SH,
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot: COPY, scopes, principal, vectorLane: { probe: false } }),
});

const { port } = await server.listen();
const prodSecret = (await fs.readFile(PROD_SECRET_FILE, "utf8")).trim();

// A 的查询方式：
//   recall（默认）—— 走参考实现（需要 /v1/date/resolve，新 sha 才有）
//   bare        —— 用裸 since/until（**旧 sha** 只有这条路；旧代码把它解释成机器本地日）
const A_MODE = process.env.A_MODE ?? "recall";

async function dayOnA(day) {
  if (A_MODE === "bare") {
    const set = new Set();
    let off = 0;
    for (let page = 0; page < 60; page += 1) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CRED, secret, principal: { agent_id: "pilot-01", role_id: "researcher" }, since: day, until: day, limit: 100, offset: off }) });
      const b = await r.json();
      if (r.status !== 200) { console.log(`A 非 200：${r.status}`); break; }
      for (const it of b.results ?? []) set.add(norm(it.path));
      if (b.next_offset === null || b.next_offset === undefined) break;
      off = b.next_offset;
    }
    return set;
  }
  const a = await recallScenario({
    baseUrl: `http://127.0.0.1:${port}`, credentials: { credential_ref: CRED, secret },
    principal: { agent_id: "pilot-01", role_id: "researcher" },
    text: `${day} 我们聊了什么`, now: NOW, timezone: SH, pageSize: 100,
  });
  return new Set((a?.items ?? []).map((x) => norm(x.path)));
}

async function dayOnB(day) {
  // B = 生产。2026-10-16 起生产默认时区是 UTC（裸日期会按 UTC 日解释），所以本地日必须显式给 calendarTimezone。
  const set = new Set();
  let off = 0;
  for (let page = 0; page < 60; page += 1) {
    const r = await fetch(`${PROD}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential_ref: CRED, secret: prodSecret, principal: { agent_id: "pilot-01", role_id: "researcher" }, calendarDate: day, calendarTimezone: SH, limit: 100, offset: off }) });
    const b = await r.json();
    if (r.status !== 200) { console.log(`B 非 200：${r.status} ${JSON.stringify(b?.error ?? b).slice(0, 120)}`); break; }
    for (const it of b.results ?? []) set.add(norm(it.path));
    if (b.next_offset === null || b.next_offset === undefined) break;
    off = b.next_offset;
  }
  return set;
}

for (const day of DAYS) {
  const setA = await dayOnA(day);
  const setB = await dayOnB(day);

  const onlyA = [...setA].filter((x) => !setB.has(x));
  const onlyB = [...setB].filter((x) => !setA.has(x));
  console.log(`=== ${day} ===`);
  console.log(`A ${REPO.includes("84fc27b") ? "旧 sha" : "新 sha"}（副本，mode=${A_MODE}）：${setA.size} 条   B 生产（现役，calendarDate+${SH}）：${setB.size} 条`);
  console.log(`仅在 A（旧多有 / 新漏）：${onlyA.length}`);
  for (const p of onlyA.slice(0, 20)) console.log(`   + ${p}`);
  console.log(`仅在 B（新多有 / 旧漏）：${onlyB.length}`);
  for (const p of onlyB.slice(0, 20)) console.log(`   - ${p}`);
}
await server.close();
