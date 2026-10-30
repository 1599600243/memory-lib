// 备份：REFINE-LOOP-1 开工前 scripts/refine-worker.mjs 的原型（产品岗版本，178 行）
// 说明：本会话读取原文时未先备份就直接改写了 refine-worker.mjs，
//       这份文件是**按当时读到的原文逐字重建**的备份，用于回滚。
// 回滚：Copy-Item scripts\refine-worker.prototype-before-refine-loop-1.mjs scripts\refine-worker.mjs -Force
// 注意：D:\MemoryLib\scripts 不在任何 git 仓内（仓根是 D:\MemoryLib\app），所以只能靠文件备份回滚。

// 提炼 worker：把 evidence 原文 → 可检索的正式记忆（服务端调模型，红线已撤）
// 用法：
//   node refine-worker.mjs --limit 20            （默认最多处理 20 条新证据）
//   node refine-worker.mjs --limit 20 --dry      （只打印不写）
//   node refine-worker.mjs --limit 5 --since 2026-10-10
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EVIDENCE_DIR = "D:\\MemoryLib\\data\\memory\\evidence\\conversations";
const STATE_FILE = "D:\\MemoryLib\\state\\refine-state.json";
const API = "http://127.0.0.1:8787";
const PATCH = "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml";

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes("--" + name);
const LIMIT = Number(arg("limit", 20));
const SINCE = arg("since", null);
const DRY = has("dry");
const MIN_CHARS = 120;          // 太短的直接跳过（多半是告警/空转）
const SKIP_PREFIX = ["【触发器告警】", "【触发器提醒】", "收到，无新增", "现在 "];

// ---------- 凭据（从 DSH 的 patch 里取，避免把 secret 写进任何仓库文件） ----------
function loadAuth() {
  const yml = fs.readFileSync(PATCH, "utf8");
  const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
  const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
  if (!ref || !secret) throw new Error("拿不到 memory-lib 凭据");
  return { credential_ref: ref, secret, principal: { agent_id: "admin-01", role_id: "librarian-admin" } };
}

// ---------- 状态 ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { done: {}, written: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

// ---------- 读证据 ----------
function parseEvidence(file) {
  const raw = fs.readFileSync(file, "utf8");
  const fm = {};
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").trim();
  return { fm, body };
}

// 把 markdown 对话正文拆成 {role, content}
function parseMessages(body) {
  const out = [];
  const parts = body.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const role = nl < 0 ? p.trim() : p.slice(0, nl).trim();
    const content = (nl < 0 ? "" : p.slice(nl + 1)).trim();
    if (!content) continue;
    out.push({ role: role.includes("用户") ? "user" : "assistant", content });
  }
  return out;
}

// ---------- 调模型 ----------
const DEEPSEEK_KEY = (() => {
  const raw = fs.readFileSync("C:\\Users\\admin\\.dsh\\.credentials.yaml", "utf8");
  return raw.match(/DEEPSEEK_API_KEY\s*:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
})();

async function extract(conv, dateStr) {
  const sys = `你是记忆提炼器。从对话里抽出**值得长期记住的事实**，只输出 JSON。
规则：
- 只抽"用户说的、跨会话还有用"的东西：偏好、决定、约定、事实、重要结论、踩过的坑。
- 不抽：寒暄、告警通知、工具输出、我自己说要做的事、临时状态。
- 每条一句话，中文，必须能独立读懂（带主体和时间）。
- 最多 4 条；没有值得记的就输出 []。
- 每条给 evidence_quote：从对话里**逐字**摘取支撑它的原话片段（不超过 40 字）。
输出格式：{"memories":[{"text":"...","evidence_quote":"...","kind":"preference|decision|fact|lesson"}]}`;

  const user = `对话日期：${dateStr}\n\n` + conv.map((x) => `[${x.role}] ${x.content}`).join("\n").slice(0, 12000);

  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content ?? "{}";
  try { return JSON.parse(txt).memories ?? []; } catch { return []; }
}

// ---------- 写记忆 ----------
async function writeMemory(auth, { text, quote, kind, dateStr, evidenceId, project }) {
  const body = {
    ...auth,
    layer: "curated-shared",
    visibility: "shared",
    type: "memory",
    body: `${text}\n\n> 原话：${quote}\n> 日期：${dateStr}`,
    evidence_refs: [evidenceId],
    tags: ["refined", kind],
    id: crypto.createHash("sha1").update(text).digest("hex").slice(0, 16),
  };
  const r = await fetch(`${API}/v1/write`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`write HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

// ---------- 主流程 ----------
const auth = loadAuth();
const state = loadState();

let files = fs.readdirSync(EVIDENCE_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(EVIDENCE_DIR, f));
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);   // 新的先做

let processed = 0, wrote = 0, skipped = 0;
for (const file of files) {
  if (processed >= LIMIT) break;
  const { fm, body } = parseEvidence(file);
  const id = fm.eventId || fm.id || path.basename(file, ".md");
  if (state.done[id]) { skipped++; continue; }

  const dateStr = fm.calendarDate || (fm.capturedAt || "").slice(0, 10);
  if (SINCE && dateStr < SINCE) continue;

  const msgs = parseMessages(body);
  const userText = msgs.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  if (userText.length < MIN_CHARS || SKIP_PREFIX.some((p) => userText.startsWith(p))) {
    state.done[id] = { at: new Date().toISOString(), reason: "skip-short-or-alert" };
    skipped++;
    continue;
  }

  processed++;
  let memories = [];
  try {
    memories = await extract(msgs, dateStr);
  } catch (e) {
    console.log(`  ✗ ${id} 抽取失败: ${e.message}`);
    continue;   // 不写 done，下次重试
  }

  console.log(`\n[${dateStr}] ${path.basename(file)}  → 抽到 ${memories.length} 条`);
  for (const m of memories) {
    const hash = crypto.createHash("sha1").update(m.text).digest("hex").slice(0, 16);
    if (state.written[hash]) { console.log(`   = 已存在，跳过：${m.text.slice(0, 40)}`); continue; }
    try {
      if (DRY) {
        console.log(`   · [${m.kind}] ${m.text}`);
      } else {
        const res = await writeMemory(auth, { ...m, quote: m.evidence_quote ?? "", kind: m.kind ?? "fact", dateStr, evidenceId: id });
        state.written[hash] = { at: new Date().toISOString(), path: res.path };
        console.log(`   ✓ [${m.kind}] ${m.text}`);
        wrote++;
      }
    } catch (e) {
      console.log(`   ✗ 写入失败: ${e.message}`);
    }
  }
  state.done[id] = { at: new Date().toISOString(), memories: memories.length };
}

if (!DRY) saveState(state);
console.log(`\n完成：处理 ${processed} 条证据，写入 ${wrote} 条记忆，跳过 ${skipped} 条（已有/太短/告警）`);
