// SDK 实测（对运行中 8787 服务，生产数据）
import { MemoryClient } from "../sdk/memory-client.mjs";
import fs from "node:fs/promises";

const secret = (await fs.readFile("I:\\OpenClaw\\memory-data\\runtime\\secrets\\memory-lib_deepseek-harness.secret", "utf8")).trim();

const mem = new MemoryClient({ url: "http://127.0.0.1:8787", credentialRef: "memory-lib/deepseek-harness", secret, agent: "pilot-01", role: "researcher" });
const admin = new MemoryClient({ url: "http://127.0.0.1:8787", credentialRef: "memory-lib/deepseek-harness", secret, agent: "admin-01", role: "librarian-admin" });

console.log("health:", JSON.stringify(await mem.health()));

const s = await mem.search({ query: "审批", limit: 3 });
console.log(`search "审批": ${s.count} 条 | 首条 lanes=${JSON.stringify(s.results[0]?.lanes)}`);

const g = await mem.get("mem_20260805_memory_loop");
console.log("get:", g.item ? "OK " + g.item.id : "null");

const reg = await admin.adminRegistry();
console.log("registry frameworks:", reg.frameworks.map((f) => `${f.framework_id}[${f.credential_status}]`).join(", "));

const inbox = await admin.adminInbox({ limit: 10 });
console.log("inbox 候选数:", inbox.count);

const audit = await admin.adminAudit({ limit: 5 });
console.log("audit 最近:", audit.events.length, "条 | 最新:", audit.events[0]?.action, audit.events[0]?.allow ? "allow" : audit.events[0]?.denyReason);

// 错误语义验证
try { await mem.get("mem_no_such_id"); } catch (e) { console.log("get 不存在 ->", e.code, `(HTTP ${e.status})`); }
try { await mem.propose({ content: "x", scope: { layer: "memory", visibility: "agent", project: "main" } }); } catch (e) { console.log("越权 propose ->", e.code, e.detail ? `detail=${e.detail}` : ""); }

console.log("SDK_SMOKE_OK");
