#!/usr/bin/env node
/**
 * IN-PLUGIN-4 探针：**一轮只跑 1 个 model step** 时，首步到底注不注入、问句是哪一句。
 *
 * 为什么要有这个探针：判据 R1/R2 要的是"单步轮次首步就有 inject_ok，且 queryHead 就是本轮这一句"。
 * 真机部署由产品岗做，所以这里用**宿主真实时序**驱动真插件，把改前/改后放在**同一串事件**上比。
 *
 * 时序照 dsh-agent-loop/lib/index.js:357-360 / 496-554：
 *   ① agent/inbox/inserted（入队，本轮用户的话第一次可见）
 *   ② session/event turn/start
 *   ③ system-prompt/assemble   ← 首步组装（改前在这里拿不到问句）
 *   ④ session/event step/start
 *   ⑤ session/event user/message（落盘）+ 宿主追加的运行时上下文/指引三条
 *   ⑥ assistant/message → turn/end（单步轮次到此结束）
 *
 *   node probe-inplugin4-firststep.mjs                       # 测当前脚本目录这份（改后），本地假 brief
 *   node probe-inplugin4-firststep.mjs --plugin-dir <改前目录>  # 测改前那份
 *   node probe-inplugin4-firststep.mjs --real                # brief 打**生产 8787 的只读 /v1/recall/brief**
 *
 * 只读：不装插件、不重启 8787、不写记忆库（--real 时把 capture 指向一个死端口，
 * 捕获只落在临时目录的重试队列里；回执也写在临时目录，绝不碰生产 inject-receipt.json）。
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith("--") ? true : next;
};
const PLUGIN_DIR = String(argOf("plugin-dir", HERE));
const REAL = argOf("real", false) === true;

// 固定事件序列（每一条都是"一轮只说一句、答完就结束"的单步轮次）
const SEQ = [
  { sessionId: "session-AAAA4444", turn: 1, text: "我们记忆库是几层？" },
  { sessionId: "session-BBBB5555", turn: 1, text: "RANK-1 的独立验收结论到底怎么说" },
  { sessionId: "session-AAAA4444", turn: 2, text: "继续" },
];

async function startFakeMemory() {
  const state = { briefs: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url || "";
      if (url.startsWith("/v1/recall/brief")) {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          body = {};
        }
        state.briefs.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, text: "记忆库一共 8 层：evidence / curated / graph 等等。", included: [{ id: "mem-1" }] }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

/** 假宿主：把 session/event、system-prompt/assemble、agent/inbox/inserted 三条都记下来。 */
function makeCtx() {
  const handlers = [];
  const assembleHandlers = [];
  const inboxHandlers = [];
  const sections = [];
  const systemPrompt = {
    section(section) {
      sections.push(section);
      return () => {
        const i = sections.indexOf(section);
        if (i >= 0) sections.splice(i, 1);
      };
    },
  };
  return {
    handlers,
    assembleHandlers,
    inboxHandlers,
    sections,
    ctx: {
      on(ev, fn) {
        if (ev === "session/event") handlers.push(fn);
        if (ev === "system-prompt/assemble") assembleHandlers.push(fn);
        if (ev === "agent/inbox/inserted") inboxHandlers.push(fn);
      },
      effect(fn) {
        const d = fn();
        if (typeof d === "function") d.toString();
      },
      get: (name) => (name === "systemPrompt" ? systemPrompt : undefined),
      systemPrompt,
    },
  };
}

/** 复刻宿主组装：按注册的 section 生成 assembly → 跑 assemble waterfall → 读回槽位文本。 */
async function assemble(h, sessionId) {
  const value = {
    sections: h.sections.map((s) => ({ name: s.name, text: typeof s.text === "function" ? s.text({}) : s.text })),
    contexts: [],
    tools: [],
    variables: {},
  };
  const context = { agent: { session: { id: sessionId } }, scope: null };
  const chain = async (i) => (i >= h.assembleHandlers.length ? value : h.assembleHandlers[i](value, context, () => chain(i + 1)));
  const out = await chain(0);
  return (out.sections ?? []).find((s) => s.name === "memory-lib:recall")?.text ?? "";
}

async function readLog(workDir) {
  return await fs.readFile(path.join(workDir, "realtime.log"), "utf8").catch(() => "");
}

async function injectRecords(workDir) {
  const text = await readLog(workDir);
  const out = [];
  for (const line of text.split("\n")) {
    const m = /\s(inject_ok|inject_skipped|inject_failed) (\{.*\})$/.exec(line);
    if (!m) continue;
    try {
      out.push({ event: m[1], ...JSON.parse(m[2]) });
    } catch {
      /* 半行跳过 */
    }
  }
  return out;
}

// ── 运行环境：全部落到临时目录，生产侧只允许"读 brief" ──────────────────────
const work = await fs.mkdtemp(path.join(os.tmpdir(), "i4-probe-"));
const mem = REAL ? null : await startFakeMemory();
const fakeBase = `http://127.0.0.1:${mem ? mem.port : 1}`;
// DSH_HOME：--real 时用真实 home（要从 profiles/web/cordis.patch.yml 读真凭证），否则用临时目录
process.env.DSH_HOME = REAL ? process.env.USERPROFILE + "\\.dsh" : work;
process.env.INPLUGIN1_WORK_DIR = work; // 日志/状态/队列都在临时目录
process.env.MEMORY_LIB_URL = `http://127.0.0.1:1`; // 捕获**不打生产**（写进临时重试队列而已）
process.env.MEMORY_LIB_CRED_REF = process.env.MEMORY_LIB_CRED_REF ?? "memory-lib/probe";
process.env.MEMORY_LIB_SECRET = process.env.MEMORY_LIB_SECRET ?? "probe";
process.env.DSH_REFINE_ENABLED = "off";
process.env.DSH_INJECT_ENABLED = "on";
process.env.DSH_INJECT_BRIEF_URL = REAL ? "http://127.0.0.1:8787/v1/recall/brief" : `${fakeBase}/v1/recall/brief`;
process.env.DSH_INJECT_RECEIPT = path.join(work, "inject-receipt.json");
process.env.DSH_INJECT_THROTTLE_MS = "0";
void fakeBase;

const pluginUrl = new URL(`file:///${path.join(PLUGIN_DIR, "index.js").replace(/\\/g, "/")}`).href;
const mod = await import(`${pluginUrl}?probe4=${Date.now()}`);
const h = makeCtx();
const api = mod.apply(h.ctx);

const rows = [];
for (const step of SEQ) {
  const { sessionId, turn, text } = step;
  // ① 入队（宿主 send() → inbox.splice → emit agent/inbox/inserted）
  h.inboxHandlers.forEach((fn) =>
    fn({ agent: { id: sessionId, session: { id: sessionId } }, message: { source: { kind: "user" }, content: [{ type: "text", text }] } }),
  );
  // ② turn/start
  h.handlers.forEach((fn) => fn({ id: sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn } }));
  // ③ 首步 assemble
  const injected = await assemble(h, sessionId);
  // ④ step/start
  h.handlers.forEach((fn) => fn({ id: sessionId }, { type: "step/start", data: { turn, step: 1 } }));
  // ⑤ 用户消息落盘 + 宿主的运行时上下文/指引（真机实测这三条也是 user/message）
  h.handlers.forEach((fn) =>
    fn({ id: sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } }),
  );
  h.handlers.forEach((fn) =>
    fn({ id: sessionId }, {
      type: "user/message",
      data: { source: { kind: "plugin" }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }] },
    }),
  );
  h.handlers.forEach((fn) =>
    fn({ id: sessionId }, { type: "user/message", data: { source: { kind: "agent-instructions" }, content: [{ type: "text", text: "<system-reminder>workspace instructions</system-reminder>" }] } }),
  );
  // ⑥ 答完就结束（这就是"单步轮次"）
  h.handlers.forEach((fn) => fn({ id: sessionId }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "8 层。" }] } } }));
  h.handlers.forEach((fn) => fn({ id: sessionId }, { type: "turn/end", data: { turn } }));
  await new Promise((r) => setTimeout(r, 120));

  const recs = await injectRecords(work);
  const rec = recs[recs.length - 1] ?? {};
  // --real 时不截取 brief 请求体（那是真服务）；问句看日志里的 queryHead/queryChars 就够
  const brief = REAL ? {} : ((mem.state.briefs.at(-1) ?? {}) || {});
  rows.push({
    sessionId,
    turn,
    said: text,
    injectedChars: injected.length,
    event: rec.event ?? "(没有任何注入日志)",
    blockedBy: rec.blockedBy ?? null,
    briefQuery: REAL ? (rec.queryHead ?? "(该版本没打 brief)") : String(brief.query ?? "(该版本没打 brief)"),
    queryHead: rec.queryHead ?? null,
    queryMessages: rec.queryMessages ?? null,
    includedIds: rec.includedIds ?? null,
  });
}

console.log(`插件目录        : ${PLUGIN_DIR}`);
console.log(`brief 端点      : ${process.env.DSH_INJECT_BRIEF_URL}${REAL ? "  （生产只读）" : "  （本地假服务）"}`);
console.log(`工作目录（临时）: ${work}`);
console.log("");
for (const r of rows) {
  console.log(`── ${r.sessionId} turn ${r.turn} 说：${r.said}`);
  console.log(`   首步注入字数   : ${r.injectedChars}${r.injectedChars > 0 ? "  ← 有注入" : "  ← 没注入"}`);
  console.log(`   注入日志       : ${r.event}${r.blockedBy ? ` blockedBy=${r.blockedBy}` : ""}`);
  console.log(`   brief.query    : ${JSON.stringify(r.briefQuery)}`);
  console.log(`   queryHead      : ${JSON.stringify(r.queryHead)}`);
  console.log(`   queryMessages  : ${r.queryMessages}`);
  if (r.includedIds) console.log(`   includedIds    : ${JSON.stringify(r.includedIds)}`);
}
const noInject = rows.filter((r) => r.injectedChars === 0).length;
console.log("");
console.log(`单步轮次数=${rows.length}  没注入的轮数=${noInject}（改前这份代码实测见 --plugin-dir 对照；改后必须 0）`);
console.log("");
console.log("── realtime.log 原文（注入 + 入队那几行）──");
for (const line of (await readLog(work)).split("\n")) {
  if (/inject_ok|inject_skipped|inject_failed|INBOX-QUERY/.test(line)) console.log(line);
}

if (mem) await mem.close();
await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
process.exitCode = noInject === 0 ? 0 : 1;
