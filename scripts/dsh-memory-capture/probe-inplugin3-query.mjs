#!/usr/bin/env node
/**
 * IN-PLUGIN-3 探针：**实测**每一轮注入到底拿的是哪句话去检索（改前 vs 改后同一串事件）。
 *
 * 为什么要有这个探针：判据 Q1/Q3 要的是"两轮 inject_ok 的 queryHead 分别是各自那句话"，
 * 而"改前到底差多少"也必须用**同一串事件**跑两份真实插件才可比 —— 不许拿推理代替读数。
 *
 *   node probe-inplugin3-query.mjs                                   # 测当前脚本目录这份（改后）
 *   node probe-inplugin3-query.mjs --plugin-dir D:\MemoryLib\in-plugin-3-before   # 测改前那份
 *
 * 只读：起一个本地假记忆服务（不碰 8787、不写记忆库），工作目录用临时目录，跑完删掉。
 */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
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

// —— 固定事件序列：A 问主题 1 → B 问主题 2 → 回到 A 说短句「继续」 → 新会话 C 第一句就是短句
//    （三句话都互不为子串，否则"串味"没法用字符串包含判出来）
const SEQ = [
  { sessionId: "session-AAAA1111", turn: 1, text: "我们记忆库是几层？" },
  { sessionId: "session-BBBB2222", turn: 1, text: "RANK-1 的独立验收结论到底怎么说" },
  { sessionId: "session-AAAA1111", turn: 2, text: "继续" },
  { sessionId: "session-CCCC3333", turn: 1, text: "好的嗯" },
];

async function startFakeMemory() {
  const state = { briefs: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url || "";
      if (url.startsWith("/v1/conversations/capture")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, evidenceId: "conversation-fake-1" }));
        return;
      }
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
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"ok":false}');
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, state, close: () => new Promise((r) => srv.close(r)) };
}

function makeCtx() {
  const handlers = [];
  const assembleHandlers = [];
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
    sections,
    ctx: {
      on(ev, fn) {
        if (ev === "session/event") handlers.push(fn);
        if (ev === "system-prompt/assemble") assembleHandlers.push(fn);
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

async function injectRecords(workDir) {
  const text = await fs.readFile(path.join(workDir, "realtime.log"), "utf8").catch(() => "");
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

const mem = await startFakeMemory();
const work = await fs.mkdtemp(path.join(os.tmpdir(), "i3-probe-"));
process.env.DSH_HOME = work;
process.env.INPLUGIN1_WORK_DIR = work;
process.env.MEMORY_LIB_URL = `http://127.0.0.1:${mem.port}`;
process.env.MEMORY_LIB_CRED_REF = "memory-lib/test";
process.env.MEMORY_LIB_SECRET = "test";
process.env.DSH_REFINE_ENABLED = "off";
process.env.DSH_INJECT_ENABLED = "on";
process.env.DSH_INJECT_BRIEF_URL = `http://127.0.0.1:${mem.port}/v1/recall/brief`;
process.env.DSH_INJECT_RECEIPT = path.join(work, "inject-receipt.json");
process.env.DSH_INJECT_THROTTLE_MS = "0"; // 每轮都真注入，只看"拿哪句话"

const pluginUrl = new URL(`file:///${path.join(PLUGIN_DIR, "index.js").replace(/\\/g, "/")}`).href;
const mod = await import(`${pluginUrl}?probe=${Date.now()}`);
const h = makeCtx();
const api = mod.apply(h.ctx);

const rows = [];
for (const step of SEQ) {
  h.handlers.forEach((fn) => fn({ id: step.sessionId, workspace: "D:/MemoryLib" }, { type: "turn/start", data: { turn: step.turn } }));
  h.handlers.forEach((fn) =>
    fn({ id: step.sessionId }, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: step.text }] } }),
  );
  await assemble(h, step.sessionId);
  const recs = (await injectRecords(work)).filter((r) => r.event === "inject_ok");
  const rec = recs[recs.length - 1] ?? {};
  const brief = mem.state.briefs[mem.state.briefs.length - 1] ?? {};
  rows.push({
    sessionId: step.sessionId,
    said: step.text,
    briefQuery: String(brief.query ?? ""),
    briefChars: String(brief.query ?? "").length,
    queryChars: rec.queryChars ?? null,
    queryHead: rec.queryHead ?? "(该版本没有 queryHead 字段)",
    queryMessages: rec.queryMessages ?? null,
    loggedSessionId: rec.sessionId ?? "(该版本没有 sessionId 字段)",
  });
}

console.log(`插件目录          : ${PLUGIN_DIR}`);
console.log(`工作目录（临时）  : ${work}`);
console.log("");
for (const r of rows) {
  console.log(`── ${r.sessionId} 说：${r.said}`);
  console.log(`   brief.query   : ${JSON.stringify(r.briefQuery)}  (${r.briefChars} 字)`);
  console.log(`   queryChars    : ${r.queryChars}`);
  console.log(`   queryHead     : ${JSON.stringify(r.queryHead)}`);
  console.log(`   queryMessages : ${r.queryMessages}`);
  console.log(`   日志 sessionId: ${r.loggedSessionId}`);
}
const totalBriefChars = rows.reduce((s, r) => s + r.briefChars, 0);
console.log("");
console.log(`合计送给 /v1/recall/brief 的问句字数：${totalBriefChars}`);
// "串味"的判定：这一轮的问句里出现了**别的会话**说过的话（同会话自己的上一条不算，那是 Q3 允许的回补）
const contaminated = rows.filter((r) => {
  const foreign = SEQ.filter((s) => s.sessionId !== r.sessionId).map((s) => s.text);
  return foreign.some((t) => r.briefQuery.includes(t));
});
console.log(`问句里串进"别的会话的话"的轮数：${contaminated.length} / ${rows.length}（改前应 >0，改后必须 0）`);
for (const c of contaminated) console.log(`   ! ${c.sessionId} 的问句 = ${JSON.stringify(c.briefQuery)}`);

h.handlers.length = 0;
await mem.close();
await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
void api;
process.exitCode = contaminated.length === 0 ? 0 : 1;
