// VISIBILITY-FIX-1-REJECT3 —— 宠物桥 `/draft` 通道的**最小诊断**（只读，自建 tmp 夹具）。
//
// 用途：把"桥这条通道到底抛什么"直接打出来，而不是靠推断。三条读数：
//   1. 桥的 `/draft <内容>` 返回什么；
//   2. 桥的 `/draft:list` 返回什么（修前是 500 "pet backend failed"：作用域为空 ⇒ MISSING_SCOPE）；
//   3. 直接调 store 的 `listDrafts({roleId:null})` / `clearDrafts({all:true,roleId:null})`，
//      拿到真实的 `code`/`message`（不经 HTTP 包装）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalhostServer } from "../src/localhost-server.mjs";
import { createServerLibFactory } from "../src/server-wiring.mjs";
import { createPetRuntimeStore } from "../src/pet-runtime-store.mjs";
import { createTestAuth } from "../test/test-auth.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "visfix1r3-diag-"));
const workspaceRoot = path.join(tmp, "workspace");
const dataRoot = path.join(workspaceRoot, "memory");
await fs.mkdir(dataRoot, { recursive: true });
const auth = await createTestAuth(ROOT, tmp);
const registry = JSON.parse(await fs.readFile(auth.registryPath, "utf8"));
for (const role of registry.frameworks[0].agents.flatMap((a) => a.roles)) { role.group_id ??= "home-circle"; role.user_id ??= "user-owner"; }
await fs.writeFile(auth.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const fakeLlm = { async chat() { return "ok"; }, async *chatStream() { yield "ok"; } };
const server = createLocalhostServer({
  registryPath: auth.registryPath, secretStore: auth.secretStore, dataRoot, workspaceRoot,
  auditPath: path.join(tmp, "audit.jsonl"), host: "127.0.0.1", port: 0,
  indexScheduleEnabled: false, vectorLane: { probe: false }, llm: fakeLlm,
  libFactory: createServerLibFactory({ dataRoot, workspaceRoot, vectorLane: { probe: false } }),
  petConfig: { openai: { credentialRef: auth.credentialRef, principal: { agent_id: "pilot-01", role_id: "pet" } } },
});
const address = await server.listen();
const BASE = `http://127.0.0.1:${address.port}`;
const bridge = (content) => fetch(`${BASE}/v1/pet/openai/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: ["Bear" + "er", auth.authValue].join(" ") },
  body: JSON.stringify({ model: "memory-lib-pet", stream: false, messages: [{ role: "user", content }] }),
}).then(async (r) => ({ status: r.status, text: await r.text() }));

// 预置一条 role_id="pet" 的草稿（让 list 的结果非空，便于区分"空"和"抛错"）
const store = createPetRuntimeStore({ dataRoot, workspaceRoot });
await store.putDraft({ content: "DIAG-PRESET-PET", roleId: "pet" });

for (const input of ["/draft DIAG-BRIDGE", "/draft:list"]) {
  const r = await bridge(input);
  console.log(`[bridge] ${input} -> ${r.status} ${r.text.slice(0, 200)}`);
}
// 直接调 store 复现同一路径，拿到真实错误对象
for (const [label, fn] of [
  ["listDrafts({roleId:null})", () => store.listDrafts({ roleId: null })],
  ["clearDrafts({all:true,roleId:null})", () => store.clearDrafts({ all: true, roleId: null })],
]) {
  try { const v = await fn(); console.log(`[store] ${label} -> ok ${JSON.stringify(v).slice(0, 120)}`); }
  catch (e) { console.log(`[store] ${label} -> THROW ${e?.code} ${e?.message}`); }
}
await server.close();
await fs.rm(tmp, { recursive: true, force: true });
