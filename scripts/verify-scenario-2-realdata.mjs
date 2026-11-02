#!/usr/bin/env node
/**
 * verify-scenario-2-realdata.mjs —— 在**真实数据副本**上用**被复核的 sha** 重跑契约表
 *
 * 为什么要有这一步：synthetic 夹具只能证明"算法对"，证明不了"真实库的数字对不对"。
 * `docs/SCENARIO-RECALL-CONTRACT.md` §实测数字 钉了一张表：
 *   10-07 → 177 条 / 70,397 字符 / 9 块
 *   10-05 → 112 条 / 43,967 字符 / 6 块
 *   09-24 → 105 条 / 40,944 字符 / 6 块
 *
 * 副本布局照抄生产（见 autostart.cmd）：
 *   --data-root <copy>/memory --workspace-root <copy>
 *   --registry <copy>/runtime/identity.json --secrets-dir <copy>/runtime/secrets
 * 源目录**只读**；凭据轮换只发生在副本的 secrets 目录里，不碰生产的 wincred。
 *
 * 用法：node verify-scenario-2-realdata.mjs [repoRoot] [copyRoot]
 *   copyRoot 默认 .\sc2-realdata-copy；不存在才复制（复用已有副本）
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const COPY = process.argv[3] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const SRC_DATA = "D:\\MemoryLib\\data";
const SH = "Asia/Shanghai";
const NOW = "2026-10-15T08:00:00.000Z";
const CRED = "memory-lib/deepseek-harness";

const TABLE = [
  { day: "2026-10-07", count: 177, chars: 70397, chunks: 9 },
  { day: "2026-10-05", count: 112, chars: 43967, chunks: 6 },
  { day: "2026-09-24", count: 105, chars: 40944, chunks: 6 },
];

const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { recallScenario } = await import(pathToFileURL(path.join(REPO, "src/scenario-recall.mjs")).href);
const { rotateCredential } = await import(pathToFileURL(path.join(REPO, "src/identity-admin.mjs")).href);
const { readSecret } = await import(pathToFileURL(path.join(REPO, "src/credential-resolver.mjs")).href);

const dataRoot = path.join(COPY, "memory");
const workspaceRoot = COPY;
const registryPath = path.join(COPY, "runtime", "identity.json");
const secretsDir = path.join(COPY, "runtime", "secrets");

const already = await fs.access(dataRoot).then(() => true, () => false);
if (!already) {
  console.log(`复制真实数据（只读源）：${SRC_DATA} → ${COPY}`);
  await fs.mkdir(COPY, { recursive: true });
  await fs.cp(path.join(SRC_DATA, "memory"), dataRoot, { recursive: true });
  await fs.cp(path.join(SRC_DATA, "runtime"), path.join(COPY, "runtime"), { recursive: true });
  console.log("复制完成");
} else {
  console.log(`复用已有副本：${COPY}`);
}

// 只在副本里轮换一个 file 型凭据（不碰生产 wincred，也不改 registry 的角色绑定）
const secretStore = { type: "file", dir: secretsDir };
await rotateCredential({ secretsDir, credentialRef: CRED });
const secret = String(await readSecret(secretStore, CRED) ?? "").trim();
note(secret.length > 0, `副本内凭据可用（长度 ${secret.length}）`);

// ⚠️ 必须照抄生产的 libFactory 形状（server.mjs:142）：它解出 `agentId` 并传给 createMemoryLib。
//    D4F1 self-root（memory-lib.mjs:175-185）靠 agentId 追加 `curated/agents/<认证 agent>`；
//    漏传 agentId ⇒ 该目录不可达 ⇒ 会量出"少 1 条"的**假象**（我 2026-10-16 就是这样错了半天）。
const server = createLocalhostServer({
  registryPath, secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(COPY, "runtime", "audit", "sc2-verify.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, calendarTimezone: SH,
  libFactory: ({ scopes, agentId, principal, audit }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, principal, audit, vectorLane: { probe: false } }),
});

try {
  const { port } = await server.listen();
  console.log(`被复核对象：${REPO}`);
  console.log(`principal：pilot-01/researcher（真实 registry，未改绑定）\n`);

  for (const row of TABLE) {
    const r = await recallScenario({
      baseUrl: `http://127.0.0.1:${port}`,
      credentials: { credential_ref: CRED, secret },
      principal: { agent_id: "pilot-01", role_id: "researcher" },
      text: `${row.day} 我们聊了什么`, now: NOW, timezone: SH, pageSize: 100, chunkChars: 8000,
    });
    const chunks = r?.chunks ?? [];
    const items = r?.items ?? [];
    const chars = items.reduce((n, x) => n + String(x.excerpt ?? "").length, 0);
    console.log(`== ${row.day} ==  取回 ${r?.count} / total ${r?.totalCount} / complete ${r?.complete} / ${r?.pages} 页 / 块 ${chunks.length} / excerpt 合计 ${chars}  ｜ 文档：${row.count} / ${row.chunks} 块 / ${row.chars} 字符`);
    note(r?.kind === "answer", `${row.day}：正常应答（kind=${r?.kind} reason=${r?.reason ?? "-"}）`);
    note(r?.count === row.count, `${row.day}：取回条数 == 文档 ${row.count}（实际 ${r?.count}）`);
    note(r?.count === r?.totalCount && r?.complete === true, `${row.day}：取回 == total_count 且 complete=true（${r?.count}/${r?.totalCount}）`);
    note(chars === row.chars, `${row.day}：excerpt 字符合计 == 文档 ${row.chars}（实际 ${chars}）`);
    note(chunks.length === row.chunks, `${row.day}：块数 == 文档 ${row.chunks}（实际 ${chunks.length}）`);
    const flat = chunks.flatMap((c) => (c.items ?? c.entries ?? []));
    note(flat.length === items.length, `${row.day}：块并集 == 当天取回集合（${flat.length}/${items.length}）`);
  }
} finally {
  await server.close();
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— 契约文档 §实测数字 三行（条数 / excerpt 字符合计 / 块数）在真实数据副本上逐列复现");
