#!/usr/bin/env node
/**
 * verify-capture-attr.mjs —— CAPTURE-ATTR-1 的**独立复核探针**（产品岗，非执行者）
 *
 * 与开发自带 `test/capture-attr.test.mjs` 的**判据不同**（不是重跑它的测试）：
 *   开发：绑定 `researcher`、解绑 `steward`，测 REST 的 200/400 + frontmatter。
 *   本探针：① 用**反向的角色分配**（解绑 reader、绑 researcher 到另一组值）
 *          ② 额外测**请求体伪造归属**（带 group/user 但值不对）—— 这是"归属只认凭据"的**安全性质**
 *          ③ 额外测**字面值 "unknown"** 与**纯空白**两种脏值（历史 bug 的确切形态）
 *          ④ **每个拒绝都必须"没落盘"**（前后目录清单一致）
 *          ⑤ 同样两组用例**走 MCP**，核 REST 与 MCP 一致
 *
 * 用法：node verify-capture-attr.mjs [repoRoot]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] ?? "D:\\MemoryLib\\app\\memory-lib";
const { createLocalhostServer } = await import(pathToFileURL(path.join(REPO, "src/localhost-server.mjs")).href);
const { createMemoryLib } = await import(pathToFileURL(path.join(REPO, "src/memory-lib.mjs")).href);
const { createTestAuth } = await import(pathToFileURL(path.join(REPO, "test/test-auth.mjs")).href);

const BOUND_GROUP = "probe-group";
const BOUND_USER = "probe-user";
const problems = [];
const note = (ok, msg) => { console.log(`${ok ? "  ✔" : "  ✘"} ${msg}`); if (!ok) problems.push(msg); };

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "capattr-verify-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
const evidenceRoot = path.join(dataRoot, "evidence", "conversations");
await fs.mkdir(evidenceRoot, { recursive: true });

const auth = await createTestAuth(REPO, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
const pilot = registry.frameworks[0].agents.find((a) => a.agent_id === "pilot-01");
const bound = pilot.roles.find((r) => r.role_id === "researcher");
bound.group_id = BOUND_GROUP; bound.user_id = BOUND_USER;
const unbound = pilot.roles.find((r) => r.role_id === "reader");
delete unbound.group_id; delete unbound.user_id;                       // ① 解绑 reader（开发用的是 steward）
const literalUnknown = structuredClone(bound);                          // ③ 字面 "unknown"
literalUnknown.role_id = "probe-unknown"; literalUnknown.group_id = "unknown"; literalUnknown.user_id = "unknown";
const blank = structuredClone(bound);                                   // ③ 纯空白
blank.role_id = "probe-blank"; blank.group_id = "   "; blank.user_id = "";
pilot.roles.push(literalUnknown, blank);
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false },
  libFactory: ({ scopes, principal }) => createMemoryLib({ dataRoot, workspaceRoot, scopes, principal, vectorLane: { probe: false } }),
});

const listing = async () => (await fs.readdir(evidenceRoot)).filter((n) => n.endsWith(".md")).sort();
const fmOf = async (file) => {
  const t = await fs.readFile(path.join(evidenceRoot, file), "utf8");
  const g = /^groupId:\s*"?([^"\r\n]*)"?/mu.exec(t)?.[1];
  const u = /^userId:\s*"?([^"\r\n]*)"?/mu.exec(t)?.[1];
  return { groupId: g, userId: u, text: t };
};

try {
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const rest = async (role, id, extra = {}) => {
    const r = await fetch(`${base}/v1/conversations/capture`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_ref: auth.credentialRef, secret: auth.authValue, principal: { agent_id: "pilot-01", role_id: role }, source: "probe", conversation_id: id, event_id: id, messages: [{ role: "user", content: `probe ${id}` }], ...extra }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const mcpCapture = async (role, id) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-credential-ref": auth.credentialRef, "x-mcp-secret": auth.authValue, "x-mcp-agent": "pilot-01", "x-mcp-role": role },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_capture_conversation", arguments: { source: "probe", conversation_id: id, event_id: id, messages: [{ role: "user", content: `probe ${id}` }] } } }),
    });
    const body = await r.json().catch(() => null);
    return { status: r.status, isError: body?.result?.isError === true, body };
  };

  console.log("== ① 绑定角色捕获：必须成功，且归属取自**凭据解析**（请求体故意不带归属）==");
  const before1 = await listing();
  const ok1 = await rest("researcher", "probe-bound-1");
  note(ok1.status === 200, `REST 200（实际 ${ok1.status}）`);
  const after1 = await listing();
  note(after1.length === before1.length + 1, `落盘新增 1 个文件（${before1.length} → ${after1.length}）`);
  const f1 = after1.find((n) => !before1.includes(n));
  if (f1) {
    const fm = await fmOf(f1);
    note(fm.groupId === BOUND_GROUP && fm.userId === BOUND_USER, `frontmatter 归属 = 凭据解析出的 ${BOUND_GROUP}/${BOUND_USER}（实际 ${fm.groupId}/${fm.userId}）`);
  } else note(false, "找不到刚写入的文件");

  console.log("\n== ② 请求体**伪造归属**：不许被采信 ==");
  const before2 = await listing();
  const spoof = await rest("researcher", "probe-spoof", { principal: { agent_id: "pilot-01", role_id: "researcher", group_id: "attacker-group", user_id: "attacker-user" } });
  const after2 = await listing();
  if (spoof.status === 200) {
    const nf = after2.find((n) => !before2.includes(n));
    const fm = nf ? await fmOf(nf) : null;
    note(fm?.groupId === BOUND_GROUP && fm?.userId === BOUND_USER, `即使请求体给了 attacker-*，落盘归属仍是凭据的 ${BOUND_GROUP}/${BOUND_USER}（实际 ${fm?.groupId}/${fm?.userId}）`);
    note(!(fm?.text ?? "").includes("attacker-group"), "落盘内容里没有 attacker-group");
  } else {
    note(after2.length === before2.length, `请求体伪造被拒（status=${spoof.status}）且**没有落盘**（${before2.length} → ${after2.length}）`);
  }

  console.log("\n== ③ 脏归属值：未绑定的角色 / 字面 \"unknown\" / 纯空白 —— 必须全部拒绝且不落盘 ==");
  // ⚠️ 注意：`reader` 没有捕获权限 ⇒ 它被拒是**权限门**（403），**验不到归属门**。
  //    所以另外解绑一个**有捕获权限**的角色（steward），让归属门被正面验到（400 + 指明 group_id/user_id）。
  const steward = pilot.roles.find((r) => r.role_id === "steward");
  const stewardHadOwnership = Boolean(steward?.group_id || steward?.user_id);
  if (steward) { delete steward.group_id; delete steward.user_id; await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8"); }
  console.log(`     （steward 原本${stewardHadOwnership ? "有" : "没有"}归属，已解绑以正面验归属门）`);

  for (const [label, role] of [["未绑定角色(reader·权限门)", "reader"], ["未绑定角色(steward·归属门)", "steward"], ["字面 unknown", "probe-unknown"], ["纯空白/空", "probe-blank"]]) {
    const b = await listing();
    const r = await rest(role, `probe-reject-${role}`);
    const a = await listing();
    note(r.status >= 400, `${label}：被拒（status=${r.status}，message=${String(r.body?.error?.message ?? r.body?.message ?? "").slice(0, 60)}）`);
    note(a.length === b.length, `${label}：**没有落盘**（${b.length} → ${a.length}）`);
    if (role === "steward") {
      note(/group_id and user_id/iu.test(String(r.body?.error?.message ?? "")), "steward 被拒的理由是**归属门**（消息指明 group_id and user_id），不是权限门");
    }
  }

  console.log("\n== ④ MCP 通道同样两条：绑定的成功、未绑定的被拒 ==");
  const bm = await listing();
  const m1 = await mcpCapture("researcher", "probe-mcp-bound");
  const am = await listing();
  note(m1.isError !== true, `MCP 绑定角色捕获未被判错（isError=${m1.isError}）`);
  note(am.length === bm.length + 1, `MCP 落盘新增 1 个（${bm.length} → ${am.length}）`);
  const nf = am.find((n) => !bm.includes(n));
  if (nf) { const fm = await fmOf(nf); note(fm.groupId === BOUND_GROUP && fm.userId === BOUND_USER, `MCP 写入的归属 = ${fm.groupId}/${fm.userId}`); }
  const bm2 = await listing();
  const m2 = await mcpCapture("reader", "probe-mcp-unbound");
  const am2 = await listing();
  note(m2.isError === true, `MCP 未绑定角色被判错（isError=${m2.isError}）`);
  note(am2.length === bm2.length, `MCP 未绑定**没有落盘**（${bm2.length} → ${am2.length}）`);

  console.log("\n== ⑤ 最后总账：目录里绝不能出现任何 groupId/userId 为 unknown 或空 ==");
  const all = await listing();
  let dirty = 0;
  for (const n of all) { const fm = await fmOf(n); if (!fm.groupId || !fm.userId || fm.groupId === "unknown" || fm.userId === "unknown") dirty += 1; }
  note(dirty === 0, `本次会话写入的 ${all.length} 个文件中，脏归属 ${dirty} 个`);
} finally {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (problems.length) { console.log(`❌ FAIL —— ${problems.length} 项不通过：`); for (const p of problems) console.log(`   - ${p}`); process.exit(1); }
console.log("✅ PASS —— 独立复核全部通过（绑定成功且归属取自凭据 / 伪造不被采信 / 脏值全拒且不落盘 / MCP 一致）");
