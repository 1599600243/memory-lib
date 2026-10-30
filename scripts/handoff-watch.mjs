// 交接触发器（handoff watchdog）——把"做完了通知下一个"从"靠人记得"变成"看目录"
//
// 约定（写进 SCOPE.md）：
//   交付信号 = ① reports/<里程碑>-dev-report.md 出现  ② git 工作树干净且有对应提交
//   验收信号 = reports/<里程碑>-acceptance-report.md 出现
//
// ⚠️ 两个条件**必须同时满足**才触发交接（2026-10-06 修）：
//   曾经只检查 ①，结果开发"先落报告、后提交"，触发了一次针对**未提交工作树**的无效验收，
//   白烧一整轮验收。现在工作树不干净就 WAIT，不交接。
//
// 本脚本每 30 秒扫一次 reports/：
//   · 发现 dev 报告且未处理过 → 自动把「开始验收」投给验收岗会话
//   · 发现验收报告且未处理过 → 记日志（产品岗下一轮读日志即可）
// 所有动作追加写 reports/handoff.log，状态存 reports/.handoff-state.json
//
// 用法：node handoff-watch.mjs [轮询秒数，默认 30]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const ROOT = "D:\\MemoryLib";
const REPORTS = path.join(ROOT, "reports");
const APP = path.join(ROOT, "app");
const STATE = path.join(REPORTS, ".handoff-state.json");
const LOG = path.join(REPORTS, "handoff.log");

const DSH = "http://127.0.0.1:3080";
// ⚠️ 2026-10-20 22:4x 换新：验收岗4（session-564b671c，21.7 万 token）切到 gpt-5.6-sol（窗口 20 万）后
//    连压缩都失败（`pi-ai detected context overflow`），整轮被产品岗停掉 → 换**验收岗5**（干净上下文、gpt-5.6-sol）。
//    换会话时 ACCEPTANCE_SESSION 与下面的 ACCEPTANCE_SESSION_FILE 必须一起改（目录名由 cwd=D:\MemoryLib 推导）。
const ACCEPTANCE_SESSION = "session-9d645c73-95aa-426c-ae82-adf29d091f6b"; // 验收岗5（2026-10-20 建，接 IN-PLUGIN-3）
const PRODUCT_SESSION = "session-dccc44aa-5b2e-4e00-af85-d23dfe1d7860"; // 产品岗（我）
// 开发会话的 transcript 文件：用它的静默时长判断"开发是不是空转"（见 alertDevIdle）
// ⚠️ 2026-10-15 再次换新：上一个开发会话（session-39c67a0c…）卡在"没人点的人工批准"上（工作区不含仓库），
//    而更早的 session-f2bbb670… 每轮被 400「System messages are not allowed」打回。
//    现在的开发岗是 **session-c2e02d01…（工作区=D:\MemoryLib ⇒ 会话目录 --D-MemoryLib--）**，
//    并已把模型切到 deepseek-official/deepseek-v4-flash（唯一实测接受 system 角色的路线）。
//    ⚠️ 换会话时 **目录名（由 cwd 推导）与会话 id 必须一起改**，否则静默时长永远算错。
const DEV_SESSION = "session-b3eb6133-7619-4450-a7bc-918a4d6af735"; // 开发岗8（2026-10-19 08:2x 换：它手上是 REFINE-LOOP-2 事件日期修复；开发岗7 的 WRITE-DENY 链已结案、空闲属正常）
const DEV_SESSION_FILE = path.join(String(process.env.USERPROFILE ?? "C:\\Users\\admin"), ".dsh", "sessions", "--D-MemoryLib--", DEV_SESSION, "session.jsonl.zstd");
// 验收会话的 transcript：用来判断"验收岗是不是把这单丢了"（见 openHandoffs / ACCEPTANCE-DROPPED）
// ⚠️ 目录名是**会话 cwd 推导出来的**：旧验收会话 cwd 在 `D:\AI\deepseek-harness\agentgongz`（`--D-AI-deepseek-harness-agentgongz--`），
//    2026-10-08 新建的验收会话 cwd 是 `D:\MemoryLib`（`--D-MemoryLib--`）—— **换会话时这两处必须一起改**：
//    `ACCEPTANCE_SESSION` 与 `ACCEPTANCE_SESSION_FILE`。漏改后者的后果是"静默时长永远算错"，告警会误报/漏报。
const ACCEPTANCE_SESSION_FILE = path.join(String(process.env.USERPROFILE ?? "C:\\Users\\admin"), ".dsh", "sessions", "--D-MemoryLib--", ACCEPTANCE_SESSION, "session.jsonl.zstd");
// 产品岗（我）自己的会话文件：用来判断"流水线是真停了，还是只是串行等我"
const PRODUCT_SESSION_FILE = path.join(String(process.env.USERPROFILE ?? "C:\\Users\\admin"), ".dsh", "sessions", "--D-AI-deepseek-harness-agentgongz--", "session-dccc44aa-5b2e-4e00-af85-d23dfe1d7860", "session.jsonl.zstd");

const INTERVAL_MS = Math.max(5, Number(process.argv[2] ?? 30)) * 1000;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.mkdirSync(REPORTS, { recursive: true }); fs.appendFileSync(LOG, line + "\n"); } catch {}
  console.log(line);
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2), "utf8"); } catch {} }

async function prompt(sessionId, text, { critical = false } = {}) {
  // ⚠️ 2026-10-10 新增：**静音档**（用户要求："把定时暂停吧，要不然一直提示"）。
  //    这里是**所有通知的唯一出口** ⇒ 一个开关就能静音全部提示，且**日志照写、审计不断**。
  //    为什么要"静音"而不是"杀掉触发器"：日志（handoff.log）是最有用的一手材料，
  //    杀掉进程会连日志一起断掉；静音只是不再打扰人。
  //    登记方式：`reports\.watchdog-quiet.json` = {"quiet": true, ...}
  //    恢复：把 quiet 改成 false（或删掉该文件）——**不需要重启触发器**。
  //
  // ⚠️ 2026-10-13 修正（被现实打脸）：**静音把"开发卡了 12.5 小时"也一起藏了** ——
  //    日志里有 NOTIFY-SUPPRESSED，但人没被叫醒。所以静音**只该静"吵人的"**，不该静"必须有人动手的"。
  //    现在：`{ critical: true }` 的通知**穿透静音档**；门槛刻意设高
  //    （开发空转 ≥6 小时 / 异地备份不新鲜 / 验收丢单 / 交接本身 / 验收报告已出）。
  let quiet = null;
  try {
    const q = JSON.parse(fs.readFileSync(path.join(REPORTS, ".watchdog-quiet.json"), "utf8"));
    if (q?.quiet === true) quiet = q;
  } catch {}
  if (quiet && !critical) {
    const first = String(text).split("\n")[0].slice(0, 140);
    try { fs.appendFileSync(LOG, `${new Date().toISOString()} NOTIFY-SUPPRESSED(静音档 → ${sessionId}) ${first}\n`); } catch {}
    return { status: 0, body: "suppressed-by-quiet-mode" };
  }
  if (quiet && critical) {
    try { fs.appendFileSync(LOG, `${new Date().toISOString()} NOTIFY-CRITICAL-THROUGH-QUIET → ${sessionId}\n`); } catch {}
  }
  const res = await fetch(`${DSH}/api/session.prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: "session.prompt",
      payload: { sessionId, mode: "queue", content: [{ type: "text", text }] } }),
  });
  return { status: res.status, body: (await res.text()).slice(0, 160) };
}

const ACCEPTANCE_START = (milestone, reportFile) => `【交接：开始验收 ${milestone}】

开发已交付。请开始独立验收。

⚠️ **硬规矩（先看这条再动手）**：所有 pwsh / 读写调用里**不要传 sandbox_permissions 字段**。
你的 cwd 是 D:\MemoryLib，读写它内部本来就允许；传了那个字段要么被判"不比当前更宽"直接拒绝（你干不了活），
要么弹一个**没人点的批准**（你会静默卡死，历史上卡过 6.6 小时和 7.5 小时）。真被拒就换不越界的等价做法，或把"做不了+原因"写进报告。
完整说明见 ~/.dsh/AGENTS.md 与 D:\MemoryLib\AGENTS.md。

交付物：
- **范围单**：到 D:\\MemoryLib\\orders\\ 找与本里程碑对应的那一份（文件名含里程碑号，如 M1.1）
  ⚠️ 本轮里程碑号为 **${milestone}**。**只要号里带后缀（FOLLOWUP / FOLLOWUP2 / HOTFIX1 …），
  范围单就是 orders\\ 里最新那份含该里程碑号的单子**（如 M1.3-followup2-*.md、M1.3-hotfix1-*.md），
  **不是**最初的功能范围单（如 M1.3-graph-and-federated-retrieval.md）；
  **冲突时以最新的那份为准**，并且**只验它列的东西，不许顺带验别的**。
  挑单前先列一遍 orders\\ 目录按时间排序，把选中的那份完整读一遍再动手。
- 开发报告：${reportFile}
- 代码：D:\\MemoryLib\\app（git 仓库）

按 D:\\MemoryLib\\ACCEPTANCE.md 的四道门验收（**产品门〔含 §3.1 接线门〕** / 工程门 / 回归门 / 文档门），
并遵守三条铁律：开发不自验 · 产品不自己宣布成功 · 不采信口头报告。

要求：
1. 自己复现，别采信报告里的结论；贴原始命令与输出。
2. **接线门（§3.1，2026-10-07 新增）**：新能力必须有**生产者**（由产品自己的写入路径产生）、
   有**消费者**（经真实入口、**带真实身份 principal** 读回），且**不同入口可见性口径一致**。
   **手工注入内部 store / 直接写文件造出的绿灯，只能算工程门材料，不能充当产品门证据。**
   判定句式：把"用户会做什么"写成**一条命令**，命令里**不允许**出现
   store.ingest( / ingestGraphEvent( / 直接写数据文件。
3. **回归门是重点**：报告必须给出「这次改动可能影响的既有行为」清单，你要逐条复验；
   没给清单的，直接判不通过。
   **另：发现既有测试失败时，报告必须给出「基线对照」**——在改动前的 commit 上跑同一套回归，
   证明该失败是"既有的"还是"本轮引入的"。拿不出基线对照的，按「本轮引入」处理，判不通过。
4. 注意「假删除」（用 if (false &&) 短路、或用 skip 掩盖失效用例）——发现即点名。
   **另注意装饰性断言**：恒真断言（如 assert.equal(f(x), f(x))）、或测试名声称验了 A
   而断言里根本没有 A ——同样点名。
5. 报告写到：D:\\MemoryLib\\reports\\${milestone}-acceptance-report.md
   格式按 ACCEPTANCE.md §5：结论 / 验证对象 / 四道门 / 逐条证据 / 未覆盖项 / 你自己的不确定处。
   注意：**"我没验证到"必须写出来**，不许用"应该没问题"糊过去。

写完报告即可结束，产品岗会读。`;

/** 交付条件 ②：app 仓库工作树必须干净（有提交、没漏提交的东西）。 */
function repoClean() {
  try {
    const out = execFileSync("git", ["-C", APP, "status", "--porcelain"], { encoding: "utf8" }).trim();
    return { clean: out === "", dirty: out.split("\n").filter(Boolean).slice(0, 8) };
  } catch (e) {
    return { clean: false, dirty: [`git 调用失败: ${e.message}`] };
  }
}

/** 当前 HEAD —— 用来发现"提交了但没写报告"这种卡死。 */
function repoHead() {
  try { return execFileSync("git", ["-C", APP, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; }
}

/** 当前 HEAD 的提交主题 —— 用来识别"同一轮的重新提交"（amend/continue 后主题不变）。 */
function repoSubject(rev = "HEAD") {
  try { return execFileSync("git", ["-C", APP, "log", "-1", "--format=%s", rev], { encoding: "utf8" }).trim(); } catch { return null; }
}

/**
 * 2026-10-07 新增：**有提交但一直没有 dev 报告** → 告警产品岗。
 * 起因：MAINT2 那轮开发提交了 `839f07d`、却说"报告稍后写"，然后这一轮就结束了 ——
 * 触发器只认 reports\*-dev-report.md，没有文件就**永远不交接**，链路静默停住，
 * 是用户问"为啥又不自动验收了"才被发现。**沉默的失败必须变成响声。**
 */
function alertCommitWithoutReport(state, files) {
  const head = repoHead();
  if (!head) return;
  const rec = state.__repo ?? {};
  const subject = repoSubject(head);
  if (rec.head !== head) {
    state.__repo = { head, subject, changed_at: Date.now(), next_alert_at: Date.now() + 3 * 60 * 1000 };
    writeState(state);
    log(`HEAD 变化 → ${head.slice(0, 7)}（等待 dev 报告）`);
    return;
  }
  if (Date.now() < Number(rec.next_alert_at ?? 0)) return;
  // ⚠️ 2026-10-07 修：**判据不再看"文件时间先后"**。
  //    起因（真实误报）：开发 `22:10:43` 落报告、`22:11:13` 交接、**提交也在 `22:11:13`** ——
  //    "**先写报告、后提交**"这个（更好的）顺序，被旧判据当成"报告比提交早 = 没有报告"，白催了一次。
  //    新判据：**这个提交是否已经有交接记录**（这是"链路上已经处理过"的真正含义）。
  const changedAt = Number(rec.changed_at ?? 0);
  // 判据①：报告 mtime 在提交时间附近（**带 ±5 分钟容差**）—— 开发常常"先写报告、后提交"，
  //   严格"晚于"会把好顺序误判成没有报告（2026-10-07 实例：报告 22:19:46、提交 22:20:06、检测 22:20:13）。
  const GRACE_MS = 5 * 60 * 1000;
  const reportedByMtime = files.some((f) => {
    if (!/-dev-report\.md$/.test(f)) return false;
    try {
      const mt = fs.statSync(path.join(REPORTS, f)).mtimeMs;
      return mt > changedAt - GRACE_MS;
    } catch { return false; }
  });
  // 判据②：这次提交已经有 dev 报告交接记录
  //   ②a 精确：交接时记的 head 就是这个提交；
  //   ②b **结构性**：**提交主题相同** → 同一轮被 amend/继续提交（实例：a659336 → f2bd817 主题完全一致），
  //      这条不看任何时间先后，最不容易误判；
  //   ②c 兼容旧记录：没存 head 的旧条目按交接时间兜底。
  const reportedByHandoff = Object.entries(state).some(([f, v]) => {
    if (f.startsWith("__") || !/-dev-report\.md$/.test(f)) return false;
    if (v?.head === head) return true;
    if (v?.subject && subject && v.subject === subject) return true;
    if (!v?.head && Number(v?.handoff_at ?? 0) >= changedAt) return true;
    return false;
  });
  if (reportedByMtime || reportedByHandoff) return;
  // ⚠️ 2026-10-07 再补一道（用刚做好的 devLastTurn）：**提交 ≠ 这一轮结束。**
  //    起因：产品岗建议开发"分两步提交"（免得被模型层掐断全丢），
  //    于是它提交了第一步（`8dec328 feat: expose pending refinement visibility`）就继续做第二步 →
  //    这条告警在 3 分钟后误报"提交了但没有报告"。
  //    判据：**开发这一轮还在跑（最后事件不是 turn/end）→ 那是中途提交，不告警。**
  const midTurn = devLastTurn();
  if (midTurn?.lastType && midTurn.lastType !== "turn/end") {
    log(`COMMIT-NO-REPORT-SUPPRESSED 提交 ${head.slice(0, 7)} 出现了，但开发这一轮还没结束（最后事件 ${midTurn.lastType}）→ 判为中途提交，不告警`);
    return;
  }
  // 首次 3 分钟后告警，之后每 30 分钟再提醒一次（**沉默的失败要一直喊**，不能只喊一声）
  const waited = Date.now() - Number(rec.changed_at ?? Date.now());
  state.__repo = { ...rec, next_alert_at: Date.now() + 30 * 60 * 1000 };
  writeState(state);
  log(`COMMIT-NO-REPORT 提交 ${head.slice(0, 7)} 已 ${Math.round(waited / 60000)} 分钟但没有新的 dev 报告 → 触发器不会交接，需要产品岗催单`);
  prompt(PRODUCT_SESSION, `【触发器告警】发现新提交 \`${head.slice(0, 7)}\`，但**已经 ${Math.round(waited / 60000)} 分钟没有出现新的 dev 报告**（这一条每 30 分钟重复提醒，直到报告落盘）。\n\n触发器只认 \`reports\\<里程碑>-dev-report.md\`（SCOPE 规矩 6），所以**不会交接给验收岗** —— 这一轮静默停住。\n\n**排查顺序（2026-10-06 教训）**：\n1. 先别急着怪开发"忘了写" —— **先看它最近一轮是怎么结束的**：\n   跑 \`node D:\\AI\\deepseek-harness\\agentgongz\\dev-after-nudge.mjs\`，它会打印 turn/end 的 reason。\n   实例：MAINT2 那次是 \`PI_AI_ERROR\`（模型/接口侧错误，"服务可能出现问题…重试一下"），\n   **那一轮根本没跑起来**，所以报告压根没生成 —— 是**重新投递一次**解决的，不是加规矩。\n2. 若那一轮是 error 结束 → **重发同一张催单**（照 \`orders\\MAINT2-nudge-retry.md\` 的写法）。\n3. 若那一轮是正常结束、代码也提交了 → 那才是"忘了落盘"，催它写报告。\n\n代码提交 ≠ 交付完成。`)
    .then((r) => log(`COMMIT-NO-REPORT-NOTIFY http=${r.status}`))
    .catch((e) => log(`COMMIT-NO-REPORT-NOTIFY-FAIL ${e.message}`));
}

/**
 * 2026-10-06 新增：**开发空转但没人等它** → 告警产品岗（八成是卡在产品岗的复审/放行上）。
 * 起因：ID1 那轮开发 20:57 就按产品岗意见改完设计表、然后**空转近 2 小时**，
 * 因为产品岗一直没回头读它的表、没放行 —— 用户问"他也没推进啊"才发现。
 * 触发器只看 reports 目录与 git，**看不见"我忘了放行"**，所以这里改成看**开发会话文件的静默时长**。
 */
/**
 * 2026-10-07 新增：读开发 transcript 的**最后一轮**状态。
 * 返回 { lastType, reason }：
 *   · lastType 是最后一条事件的类型（`turn/end` = 那一轮结束了；`step/start`/`tool/call` = 还在跑）
 *   · reason 是最后一次 `turn/end` 的 reason（`{kind:"completed"}` 或 `{kind:"error", error:{code,message}}`）
 * 只解压尾部 8MB 的 zstd 帧，够用且便宜。
 */
function devLastTurn() {
  try {
    const st = fs.statSync(DEV_SESSION_FILE);
    const TAIL = 8 * 1048576;
    const start = Math.max(0, st.size - TAIL);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(DEV_SESSION_FILE, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const offs = [];
    for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
    const parts = [];
    for (let k = 0; k < offs.length; k++) {
      const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8")); } catch {}
    }
    let lastType = null;
    let lastEnd = null;
    for (const line of parts.join("").split("\n").slice(-800)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const t = String(o.type ?? o.kind ?? "");
      if (!t) continue;
      lastType = t;
      if (t === "turn/end") lastEnd = o;
    }
    return { lastType, reason: lastEnd?.reason ?? null };
  } catch { return null; }
}

/**
 * 2026-10-08 新增（第 14 处修复）：**产品岗手工开的验收窗口，没有任何东西在盯**。
 * 起因：产品岗为"只补两项验证"手工开了一个窗口，它在触发器眼里**不存在**
 * （`ACCEPTANCE-BUSY/DROPPED` 只覆盖"经触发器交接"的窗口：有 dev 报告、有 handoff 记录）。
 * 结果：验收会话中止、报告一直没落盘，**静默了十几个小时都没有告警** —— 是产品岗自己量出来的。
 * **"该响的不响"比"多喊"严重得多。**
 * 判据：`reports\.acceptance-window.json` 登记 open=true 时，
 * 用**验收会话 transcript 的静默时长**判断它是不是停了；同时检查期望的报告是否落盘。
 */
function alertManualWindowStall(state) {
  let w = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPORTS, ".acceptance-window.json"), "utf8"));
    if (raw?.open === true) w = raw;
  } catch {}
  if (!w) { state.__mw_silent_since = 0; return; }
  const expected = String(w.acceptance_report_expected ?? "");
  // ⚠️ 2026-10-09 新增：**窗口可以指定"盯哪个会话"**。
  //    起因：验收岗2 卡死后，产品岗把独立复核改派给开发岗 ⇒ 仍然盯验收会话就会**误报静默**
  //    （它按指令停手了，本来就该静默）。`w.session_file` 指向被指派方的 transcript；
  //    没写这个字段时退回原来的"验收会话"。
  const watchFile = w.session_file ? path.resolve(String(w.session_file)) : ACCEPTANCE_SESSION_FILE;
  const watchWho = String(w.assigned_role ?? "验收岗");
  // ⚠️ 2026-10-09 修正（被现实打了一次脸）：**"期望报告存在"不等于"窗口结束"**。
  //    第一版在报告一存在时就 `return`（不再盯静默）。但产品岗随后立了"**分段落盘**"的规矩
  //    （每做完一节就落一次盘，防上游中断丢结果）⇒ **报告会先以"中间版"存在，窗口仍然开着**。
  //    实测后果：验收岗2 01:57 落了中间版 → 会话静默 **8.5 小时** → **一条告警都没有**。
  //    ⇒ 现在改成：**窗口是否结束只由产品岗决定**（`.acceptance-window.json` 的 `open:false`）。
  //       报告存在只作为告警正文里的**上下文**（"报告已落盘 N 字节，但可能还在追加/未收口"）。
  let reportNote = "期望报告尚未落盘";
  try {
    const rp = path.join(REPORTS, expected);
    const st = fs.statSync(rp);
    reportNote = `期望报告**已落盘**（${st.size}B，最后写入 ${st.mtime.toISOString()}）—— 注意：可能是**中间版**（分段落盘），窗口仍开着`;
  } catch {}
  let silentMs = null;
  try { silentMs = Date.now() - fs.statSync(watchFile).mtimeMs; } catch {}
  if (silentMs === null) return;
  // ⚠️ 2026-10-09 再修一处（开窗口那一刻的误报）：
  //    窗口刚开、验收会话**还没被唤醒**时，会话 mtime 还是**上一次用它的时刻** ⇒ 静默时长会算成几百分钟，
  //    于是**每次开窗口都会立刻误报一次**（实测：DEPLOY-8-Verify 一开就报"静默 577 分钟"）。
  //    更糟：它把**新窗口的告警额度**也吃掉了（第 3 次/最多 3 次）⇒ 真停住时反而没人喊。
  //    修法两条：
  //      ① 静默时长从 **max(会话最后写入, 窗口开启时刻)** 算起（窗口开之前的历史静默不算）；
  //      ② **里程碑变了就重置告警计数**（每个窗口有自己的额度）。
  const openedAtMs = Date.parse(String(w.opened_at ?? "")) || 0;
  let sessionMtimeMs = 0;
  try { sessionMtimeMs = fs.statSync(watchFile).mtimeMs; } catch {}
  silentMs = Date.now() - Math.max(sessionMtimeMs, openedAtMs);
  if (String(state.__mw_milestone ?? "") !== String(w.milestone ?? "")) {
    state.__mw_milestone = String(w.milestone ?? "");
    state.__mw_alert_count = 0;
    state.__mw_alerted_at = 0;
    writeState(state);
  }
  const floorMs = 12 * 60 * 1000;
  if (silentMs < floorMs) { state.__mw_silent_since = 0; return; }
  const last = Number(state.__mw_alerted_at ?? 0);
  const count = Number(state.__mw_alert_count ?? 0);
  if (count >= 3 || Date.now() - last < 60 * 60 * 1000) return;
  state.__mw_alerted_at = Date.now();
  state.__mw_alert_count = count + 1;
  writeState(state);
  const mins = Math.round(silentMs / 60000);
  log(`MANUAL-WINDOW-STALL 手工验收窗口（${w.milestone}）已静默 ${mins} 分钟（${reportNote}）→ 告警产品岗（第 ${count + 1} 次/最多 3 次）`);
  prompt(PRODUCT_SESSION, `【触发器告警】**你手工开的验收窗口静默了 ${mins} 分钟**\n\n窗口：${w.milestone}（被验 sha ${w.verified_sha ?? "?"}）\n${reportNote}\n期望报告：${path.join(REPORTS, expected)}\n${watchWho}会话最后写入：${new Date(Date.now() - silentMs).toISOString()}\n\n这类窗口**不经触发器交接**，ACCEPTANCE-BUSY/DROPPED 覆盖不到它 —— **这条告警是它唯一的看门人**。\n\n排查顺序：① 量验收会话是"停了"还是"卡在一次长工具调用里"（看事件循环是否还在 tool/call→result）；② 停了 → 催办，并给出"二选一"（补做并落盘 / 把具体阻塞写成报告落盘）；③ 反复停 → **换一个干净的验收会话（一窗一会话）**，别反复重投。\n\n⚠️ **窗口是否结束只由产品岗决定**：确认收口后把 \`reports\\.acceptance-window.json\` 的 \`open\` 改成 \`false\`，否则这条会一直盯（最多 3 次/小时级）。`, { critical: true })
    .then((r) => log(`MANUAL-WINDOW-NOTIFY http=${r.status}`))
    .catch((e) => log(`MANUAL-WINDOW-NOTIFY-FAIL ${e.message}`));
}

/**
 * 2026-10-10 新增（第 18 处）：**异地备份的新鲜度看门人**。
 * 起因：`D:\MemoryArchive\live\snapshot.ps1` 每天 04:00 把记忆数据镜像到本地归档并 **push 到私有远端**，
 * 但**推送因单文件超过 GitHub 100MB 上限被拒**，脚本却**静默退出**（日志里既没有 FAIL 也没有 done）
 * ⇒ **异地备份断了约 16 天，没有任何人被告警**。这是"该响的不响"的典型。
 * 判据（两条，都不需要跑 git）：
 *   ① `snapshot.log` 最后一条 `=== snapshot ... ===` 结尾若是 `FAILED` ⇒ 这次跑挂了；
 *   ② `.last-push.json`（脚本成功推送后写）不存在或超过 48 小时 ⇒ 异地副本在退后。
 */
function alertArchiveStale(state) {
  const live = "D:\\MemoryArchive\\live";
  const logPath = path.join(live, "snapshot.log");
  const stampPath = path.join(live, ".last-push.json");
  const problems = [];

  let lastLogLines = [];
  try {
    const all = fs.readFileSync(logPath, "utf8").split(/\r?\n/u).filter(Boolean);
    // ⚠️ 只从**最后一次 `snapshot start`** 起算：否则会把"上一轮失败、这一轮成功"那次的旧 FATAL
    //    当成当前问题（实测踩过一次，误报）。
    const lastStart = all.map((l) => l.includes("=== snapshot start ===")).lastIndexOf(true);
    lastLogLines = lastStart >= 0 ? all.slice(lastStart) : all.slice(-40);
  } catch { return; }
  const marks = lastLogLines.filter((l) => l.includes("=== snapshot "));
  const lastMark = marks.length ? marks[marks.length - 1] : "";
  if (lastMark.includes("FAILED")) problems.push(`最近一次快照失败：${lastMark.trim()}`);
  const fatal = lastLogLines.filter((l) => l.includes("FATAL")).slice(-1)[0];
  if (fatal) problems.push(`日志里有 FATAL：${fatal.trim()}`);

  let stamp = null;
  try {
    // ⚠️ PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 **BOM** ⇒ 必须先剥掉再 JSON.parse，
    //    否则会误判成"文件不存在"（实测踩过）。脚本侧也已改成无 BOM 写入（双保险）。
    const raw = fs.readFileSync(stampPath, "utf8").replace(/^\uFEFF/u, "");
    stamp = JSON.parse(raw);
  } catch {}
  if (!stamp) problems.push("`.last-push.json` 不存在 ⇒ **从未成功推送过**（或脚本是旧版）");
  else {
    const ageH = (Date.now() - Date.parse(String(stamp.at))) / 3600000;
    if (!Number.isFinite(ageH)) problems.push("`.last-push.json` 的 `at` 解析失败");
    else if (ageH > 48) problems.push(`最后一次成功推送在 **${ageH.toFixed(1)} 小时前**（阈值 48h）`);
    if (String(stamp.ahead_after ?? "0") !== "0") problems.push(`推送后本地仍 ahead=${stamp.ahead_after}`);
  }
  if (!problems.length) { state.__archive_alerted_at = 0; state.__archive_alert_count = 0; return; }

  const last = Number(state.__archive_alerted_at ?? 0);
  const count = Number(state.__archive_alert_count ?? 0);
  if (count >= 3 || Date.now() - last < 6 * 60 * 60 * 1000) return;   // 同一问题最多喊 3 次、间隔 6 小时
  state.__archive_alerted_at = Date.now();
  state.__archive_alert_count = count + 1;
  writeState(state);
  log(`ARCHIVE-STALE ${problems.join("；")} → 告警产品岗（第 ${count + 1} 次/最多 3 次）`);
  prompt(PRODUCT_SESSION, `【触发器告警】**异地备份（记忆归档）不新鲜了**\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\n背景：\`D:\\MemoryArchive\\live\\snapshot.ps1\` 每天 04:00 把记忆数据镜像到本地归档并 push 到私有远端。\n**2026-10-10 发现它曾因"单文件超 GitHub 100MB 上限"被拒、而脚本静默退出，异地副本断了约 16 天。**\n\n排查：① 看 \`D:\\MemoryArchive\\live\\snapshot.log\` 尾部；② 看 \`.last-push.json\`；③ 手动跑一次脚本看它现在是否"失败必响"。`, { critical: true })
    .then((r) => log(`ARCHIVE-NOTIFY http=${r.status}`))
    .catch((e) => log(`ARCHIVE-NOTIFY-FAIL ${e.message}`));
}

function alertDevIdle(state) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(DEV_SESSION_FILE).mtimeMs; } catch { return; }
  const idleMs = Date.now() - mtimeMs;
  const mins0 = Math.round(idleMs / 60000);
  // ⚠️ 2026-10-07 新增（**这条差点让我漏掉一次真故障**）：
  //    光看"会话文件静默多久"分不清三件事：
  //      ① 它正在这一轮里干活（长工具调用，静默几分钟很正常）；
  //      ② 它那一轮**以 error 结束**（模型流被掐断）—— 这时它是**真停了**，而且永远不会自己恢复；
  //      ③ 它正常结束、在等下一单。
  //    所以这里读一下**最后一条事件**与**最后一次 turn/end 的 reason**：
  //      · 最后事件不是 turn/end → ①：静默正常，**不告警**；
  //      · turn/end 且 reason.kind === "error" → ②：**立刻喊**（不等 20 分钟），并带上错误码/消息；
  //      · turn/end 且 completed → ③：走原来的空闲逻辑。
  //    实例：REFINE-1 那轮 11:33 以 `PI_AI_ERROR / Upstream response stream was interrupted` 结束，
  //    产品岗却把它当成"积压旧告警"跳过、**静默 18 分钟才发现**。
  const turn = devLastTurn();
  if (turn?.lastType && turn.lastType !== "turn/end") {
    state.__idle_alerted_at = 0; state.__idle_alert_count = 0; writeState(state);
    log(`DEV-IDLE-SUPPRESSED 开发静默 ${mins0} 分钟，但它这一轮还没结束（最后事件 ${turn.lastType}）→ 正在干活，不告警`);
    return;
  }
  const reason = turn?.reason ?? null;
  const isError = reason && typeof reason === "object" && String(reason.kind ?? "") === "error";
  if (isError && idleMs >= 3 * 60 * 1000) {
    const last = Number(state.__dev_error_alerted_at ?? 0);
    if (Date.now() - last < 30 * 60 * 1000) return;
    state.__dev_error_alerted_at = Date.now();
    writeState(state);
    const code = reason?.error?.code ?? "(no code)";
    const message = String(reason?.error?.message ?? "").slice(0, 200);
    log(`DEV-TURN-ERROR 开发第 ${reason?.turn ?? "?"} 轮以 error 结束（${code}: ${message}）→ 已静默 ${mins0} 分钟`);
    prompt(PRODUCT_SESSION, `【触发器告警】**开发那一轮是 error 结束的 —— 不是它在想，是它死了。**\n\n` +
      `轮次：**turn ${reason?.turn ?? "?"}** · 已静默 **${mins0} 分钟**\n` +
      `错误：\`${code}\` — ${message}\n\n` +
      `**这意味着**：它那一轮没跑完、**没提交、也没报告**，而且**不会自己恢复**。\n\n` +
      `**按 SCOPE 的既有教训办**（MAINT2 / ID1 两轮都是这个病）：\n` +
      `1. 先确认工作树与 HEAD（\`git -C D:\\MemoryLib\\app status --porcelain\` / \`rev-parse HEAD\`）——` +
      `看它有没有提交到一半；\n` +
      `2. **重发同一张单**（写一张"重发"便条，照 \`orders\\MAINT2-nudge-retry.md\` 的写法），` +
      `并建议它**分两步提交**，免得下次被掐断又全丢；\n` +
      `3. 若连续多次 PI_AI_ERROR → 记入账，并考虑换 provider（模型层不稳不是开发的错）。\n\n` +
      `（本条 30 分钟最多喊一次。）`)
      .then((r) => log(`DEV-TURN-ERROR-NOTIFY http=${r.status}`))
      .catch((e) => log(`DEV-TURN-ERROR-NOTIFY-FAIL ${e.message}`));
    return;
  }

  const idleMs2 = idleMs;
  if (idleMs2 < 20 * 60 * 1000) { state.__idle_alerted_at = 0; state.__idle_alert_count = 0; writeState(state); return; }
  // ⚠️ 2026-10-07 加的最重要一道闸：**"开发在等我"是正常流水线状态，不是停住**。
  //    当天实测：DEV-IDLE 喊了 10 次，绝大多数是"开发已完成、在等产品岗裁决/放行"——
  //    而产品岗（我）一直在动，流水线并没有停。**只有在【开发静默 AND 产品岗也静默】时，才是真停住。**
  //    判据用产品岗会话文件的 mtime（和我判断开发是否空转用的是同一套事实）。
  let productIdleMs = null;
  try { productIdleMs = Date.now() - fs.statSync(PRODUCT_SESSION_FILE).mtimeMs; } catch {}
  if (productIdleMs !== null && productIdleMs < 10 * 60 * 1000) {
    state.__idle_alerted_at = 0; state.__idle_alert_count = 0; writeState(state);
    log(`DEV-IDLE-SUPPRESSED 开发静默 ${Math.round(idleMs / 60000)} 分钟，但产品岗 ${Math.round(productIdleMs / 60000)} 分钟前还在工作 → 流水线只是串行，不告警`);
    return;
  }
  // ⚠️ 2026-10-07 再补一刀：**开发空闲也可能是"它的活正在被验收"** —— 这同样不是停住。
  //    判据（结构性事实）：**还有开着的验收窗口**（已交接、未出验收报告）→ 抑制。
  //    这样 DEV-IDLE 只在"开发静默 + 产品岗静默 + 没有在验的东西"时才喊，那才是真的没人推进。
  let openWindows = [];
  try { openWindows = openHandoffs(state, fs.readdirSync(REPORTS).filter((f) => f.endsWith(".md"))); } catch {}
  if (openWindows.length > 0) {
    state.__idle_alerted_at = 0; state.__idle_alert_count = 0; writeState(state);
    log(`DEV-IDLE-SUPPRESSED 开发静默 ${Math.round(idleMs / 60000)} 分钟，但验收岗正在验 ${openWindows.map((o) => o.milestone).join("/")} → 流水线在推进，不告警`);
    return;
  }
  // ⚠️ 2026-10-08 再补一刀（第 13 处）：**产品岗"手工开的补验窗口"，触发器看不见**。
  //    起因：FIX2 出报告后，产品岗手工开了一个"只补做两项验证"的复验窗口 ——
  //    它**不经触发器交接**（没有新的 dev 报告、没有新的 handoff 记录），
  //    同时产品岗**明确要求开发待命、不要开新活**（规矩 13：一次只开一个验收窗口）。
  //    ⇒ 于是"开发静默 + 没有开着的窗口"同时成立，DEV-IDLE 就喊了 —— 但那是**预期状态，不是停住**。
  //    （告警自身也提醒"这类静默多半是卡在产品岗"，而这次恰恰**是产品岗故意让它待命**。）
  //    判据：产品岗在 `reports\.acceptance-window.json` 里显式登记"窗口开着"，关窗时改 `open:false`。
  let manualWindow = null;
  try {
    const w = JSON.parse(fs.readFileSync(path.join(REPORTS, ".acceptance-window.json"), "utf8"));
    if (w?.open === true) manualWindow = w;
  } catch {}
  if (manualWindow) {
    state.__idle_alerted_at = 0; state.__idle_alert_count = 0; writeState(state);
    log(`DEV-IDLE-SUPPRESSED 开发静默 ${Math.round(idleMs / 60000)} 分钟，但产品岗手工开着验收窗口（${manualWindow.milestone ?? "?"}）→ 开发是**按指令待命**，不告警`);
    return;
  }
  // ⚠️ 2026-10-10 再补一刀（第 17 处）：**产品岗显式让开发"停手待命"时，不再喊空转**。
  //    起因：开发交完活、下一单还没下（这是第 3 种情况"没人给单"），DEV-IDLE 仍按"多半卡在产品岗"喊 ——
  //    喊得对，但**每喊一次就打断产品岗一次**（通知是排队送到我这里、要我整轮处理的）。
  //    判据：产品岗在 `reports\.dev-parked.json` 里登记 `{"parked": true}`；想让它继续干活时删掉/改 false。
  //    **注意**：这只抑制"空转提醒"，不抑制别的告警；而且 parked 不等于"可以不管开发"，
  //    所以登记时必须写 reason（给未来的自己看）。
  let devParked = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(REPORTS, ".dev-parked.json"), "utf8"));
    if (p?.parked === true) devParked = p;
  } catch {}
  if (devParked) {
    state.__idle_alerted_at = 0; state.__idle_alert_count = 0; writeState(state);
    log(`DEV-IDLE-SUPPRESSED 开发静默 ${Math.round(idleMs / 60000)} 分钟，但产品岗已登记"开发停手待命"（${devParked.reason ?? "无理由"}）→ 不告警`);
    return;
  }
  const last = Number(state.__idle_alerted_at ?? 0);
  // ⚠️ 2026-10-07 去噪：**同一段空转最多喊 3 次，间隔 60 分钟**（原来 30 分钟无上限）。
  //    起因：当天 DEV-IDLE 喊了 **10 次** —— 开发每次"等我裁决"都会触发；
  //    而通知是排队送到产品岗会话的，我一次读一批时**收到的全是同一段空转的旧件**，
  //    时间戳还是旧的（例如"22:39:19 起静默 80 分钟"在我已经在推进之后才到）。
  //    **第一条才是有用的**（它告诉我"你卡住管线了"），后面的只是重复；
  //    超过 3 次改为**只记日志**，避免刷屏（"该响的要响"不等于"一直响"）。
  const REPEAT_MS = 60 * 60 * 1000;
  const MAX_PROMPTS = 3;
  const count = Number(state.__idle_alert_count ?? 0);
  if (Date.now() - last < REPEAT_MS) return;
  state.__idle_alerted_at = Date.now();
  state.__idle_alert_count = count + 1;
  writeState(state);
  const mins = Math.round(idleMs / 60000);
  if (count >= MAX_PROMPTS) {
    log(`DEV-IDLE 开发会话已静默 ${mins} 分钟（本轮已喊 ${count} 次，超过上限 → 只记日志不再打扰）`);
    return;
  }
  log(`DEV-IDLE 开发会话已静默 ${mins} 分钟 → 可能卡在产品岗的复审/放行，告警产品岗（第 ${count + 1} 次/最多 ${MAX_PROMPTS} 次）`);
  prompt(PRODUCT_SESSION, `【触发器告警】**开发已空转 ${mins} 分钟**（会话文件 ${new Date(mtimeMs).toISOString()} 之后再没动过）。\n\n⚠️ **先看这条告警是不是旧的**：它是**生成时刻**的快照，可能在你手上排了一会儿队。\n**判断方法**：直接量当前状态 —— 若开发会话文件的静默时间已经很小，说明它早就在干活了，**这条忽略即可**。\n\n这类静默**多半不是开发的问题，是卡在产品岗身上** —— 上一次就是这么来的：\nID1 那轮开发按意见改完设计表后**空转近 2 小时**，因为产品岗一直没回头读它的表、没放行。\n\n**排查顺序**：\n1. 看它最后一条消息说了什么：\`node D:\\AI\\deepseek-harness\\agentgongz\\dev-last-full.mjs\`\n   —— 若它在"等产品岗复审/放行/决策"，**那就是你的活，立刻做**。\n2. 看有没有它交了但我没处理的东西：\`reports\\\` 里的 dev 报告 / 设计表 / 判定表（**不落盘的除外**）。\n3. 都不像 → 可能是它那一轮结束了但**没人给它下一单**，去看 \`orders\\\` 里最近一张单的状态。\n\n（同一段空转**最多喊 3 次、每次间隔 1 小时**；超过后只记日志，避免刷屏。）`, { critical: mins >= 360 });
}

/**
 * 2026-10-07 新增：**验收岗一次只做一单** —— 上一单还没出验收报告，就不许再交接下一单。
 *
 * 起因（真实事故）：MAINT3 于 18:26 交接给验收岗；18:46 又把 MAINT4 交接了（MAINT3 还没出报告）；
 * 18:52 验收岗**只出了 MAINT4 的报告**就 turn/end 收工 —— **MAINT3 被静默丢了**，
 * 没有报告、没有报错、链路上谁都不知道。是我事后读交接日志才发现的。
 *
 * 两道防线：
 *   ① **不让它同时接两单**（本函数返回 busy → 新的 dev 报告不交接，排队等）
 *   ② **万一还是丢了，要喊出来**（交接超 30 分钟未出报告 + 验收会话静默 > 10 分钟 → 判"疑似丢单"，告警产品岗）
 *
 * 注意：**不自动放行**。丢单时宁可停住 + 告警，也不自动把下一单推过去 ——
 * 独裁式的"自动重试"会掩盖问题，而"静默丢单"正是我们要消灭的那类失败。
 */
function acceptanceReportExists(milestone, files) {
  const prefix = `${String(milestone ?? "").toUpperCase()}-`;
  return files.some((f) => /-acceptance-report\.md$/i.test(f) && f.toUpperCase().startsWith(prefix));
}

/** 从已有状态里**推导**出"还开着、等验收报告"的单子（自愈，不依赖额外记账）。 */
/**
 * 2026-10-08 新增：**"行政归档"（waiver）** —— 产品岗把某一轮判为"不单独验证、并入后续轮次"时，
 * 让触发器别再等它的验收报告，否则它会**永久挡住后续所有交接**（`acBusy` 一直为真）。
 *
 * 为什么用**独立文件**而不是写进 `state`：
 * `state` 由触发器自己持有并在内存里改、周期性整份写回 —— 我在外面改 `state` 会被它下一次写回**覆盖**。
 * 独立文件每次扫描重读，**不参与 state 的读写竞争**，也便于审计（谁在什么时候为什么归档）。
 *
 * 文件：`reports\.handoff-waivers.json`
 *   { "RETRIEVAL-1-AMENDED-CONTRACT": { "reason": "…", "at": "2026-10-08T…", "folded_into": "RETRIEVAL-1-FIX2" } }
 */
const WAIVERS_FILE = path.join(REPORTS, ".handoff-waivers.json");
function waiverEntries() {
  try { return JSON.parse(fs.readFileSync(WAIVERS_FILE, "utf8")) ?? {}; } catch { return {}; }
}
/** 归档：这一轮不单独验证（并入后续轮次）→ 不进"未出报告"清单，也不再交接。 */
function waivedMilestones() {
  const out = new Set();
  for (const [k, v] of Object.entries(waiverEntries())) {
    if (v?.hold === true) out.add(String(k).toUpperCase());      // 按住时同样视为"不催"
    else out.add(String(k).toUpperCase());
  }
  return out;
}
/** 按住：产品岗明确"这一轮还没做完，先别交接给验收"。 */
function heldMilestones() {
  const out = new Set();
  for (const [k, v] of Object.entries(waiverEntries())) if (v?.hold === true) out.add(String(k).toUpperCase());
  return out;
}

function openHandoffs(state, files) {
  const open = [];
  const waived = waivedMilestones();
  for (const [f, v] of Object.entries(state)) {
    if (f.startsWith("__")) continue;
    if (v?.action !== "handoff-to-acceptance") continue;
    const m = /^(.+?)-dev-report\.md$/.exec(f);
    if (!m) continue;
    const milestone = m[1].toUpperCase();
    if (acceptanceReportExists(milestone, files)) continue;
    if (waived.has(milestone)) continue;   // 行政归档 / 产品岗按住：不单独验证，并入后续轮次
    open.push({ milestone, reportFile: f, handoff_at: Number(v.handoff_at ?? 0) });
  }
  if (state.__acceptance && !acceptanceReportExists(state.__acceptance.milestone, files)
      && !waived.has(String(state.__acceptance.milestone ?? "").toUpperCase())) open.push(state.__acceptance);
  return open;
}

function checkAcceptanceBusy(state, files) {
  const open = openHandoffs(state, files);
  if (!open.length) return { busy: false };
  const oldest = open.reduce((a, b) => (Number(a.handoff_at ?? 0) <= Number(b.handoff_at ?? 0) ? a : b));
  const ageMs = Date.now() - Number(oldest.handoff_at ?? 0);
  let accIdleMs = null;
  try { accIdleMs = Date.now() - fs.statSync(ACCEPTANCE_SESSION_FILE).mtimeMs; } catch {}
  const dropped = ageMs > 30 * 60 * 1000 && accIdleMs !== null && accIdleMs > 10 * 60 * 1000;
  const last = Number(state.__acceptance_alerted_at ?? 0);
  // ⚠️ 2026-10-07 调（去噪）：**正常验收本来就要 20–40 分钟**，而"忙"的门槛原来设在 20 分钟
  //    → **每次正常验收都会喊一次**（MAINT8 就是这样：交接 20 分钟、验收会话静默 0 分钟，正在干活）。
  //    现在：**"只是在忙"要 45 分钟才提一次，且每小时最多一次**；
  //    **"疑似丢单"（交接 >30 分钟 + 验收会话静默 >10 分钟）仍然 15 分钟一喊** —— 那才是要立刻处理的。
  const every = dropped ? 15 * 60 * 1000 : 60 * 60 * 1000;
  const floor = dropped ? 30 * 60 * 1000 : 45 * 60 * 1000;
  if (ageMs > floor && Date.now() - last > every) {
    state.__acceptance_alerted_at = Date.now();
    writeState(state);
    const mins = Math.round(ageMs / 60000);
    const accIdle = accIdleMs === null ? "（读不到验收会话文件）" : `${Math.round(accIdleMs / 60000)} 分钟`;
    log(`${dropped ? "ACCEPTANCE-DROPPED" : "ACCEPTANCE-BUSY"} ${open.map((o) => o.milestone).join("/")} 已交接 ${mins} 分钟未出验收报告`
      + `${dropped ? `，且验收会话已静默 ${accIdle} → **疑似把这单丢了**` : "（验收岗仍在忙）"}`
      + ` → **不再交接下一单**，需产品岗裁决`);
    prompt(PRODUCT_SESSION, `【触发器告警】${dropped ? "**验收岗疑似丢单**" : "验收岗仍在忙"}：\n\n`
      + `已交接但**没有验收报告**的单：**${open.map((o) => o.milestone).join(" / ")}**（最早 ${mins} 分钟前交接）。\n`
      + `验收会话静默：${accIdle}。\n\n`
      + `触发器已**拒绝再交接下一单**（改自 2026-10-07 的 MAINT3 事故：MAINT3 交接 20 分钟后 MAINT4 也交接过去，\n`
      + `验收岗只出了 MAINT4 的报告就收工，**MAINT3 静默丢了**）。\n\n`
      + `**排查顺序**：\n`
      + `1. 读交接日志确认情况：\`Get-Content D:\\MemoryLib\\reports\\handoff.log -Tail 30\`\n`
      + `2. 看验收岗最后在干什么：\`node D:\\AI\\deepseek-harness\\agentgongz\\session-tail.mjs ${ACCEPTANCE_SESSION}\`\n`
      + `3. 若确实丢了 → **补一单请求它补验**（照 \`orders\\MAINT3-acceptance-recheck-request.md\` 的写法），`
      + `并**要求它写明所验提交**（仓库 HEAD 可能已经往后走了）。\n`
      + `4. 若它只是还在忙 → 等它出报告即可，**不要**提前放行下一单。\n\n`
      + `（本条 ${dropped ? "每 15" : "每 30"} 分钟重复，直到该单的验收报告落盘。）`, { critical: dropped })
      .then((r) => log(`ACCEPTANCE-${dropped ? "DROPPED" : "BUSY"}-NOTIFY http=${r.status}`))
      .catch((e) => log(`ACCEPTANCE-${dropped ? "DROPPED" : "BUSY"}-NOTIFY-FAIL ${e.message}`));
  }
  return { busy: true, open, ageMs, dropped };
}

function scan() {
  const state = readState();
  let files = [];
  try { files = fs.readdirSync(REPORTS).filter((f) => f.endsWith(".md")); } catch { return; }

  alertCommitWithoutReport(state, files);
  alertDevIdle(state);
  alertManualWindowStall(state);
  alertArchiveStale(state);
  const acBusy = checkAcceptanceBusy(state, files);

  for (const f of files) {
    const full = path.join(REPORTS, f);
    const m = /^(.+?)-dev-report\.md$/.exec(f);
    const a = /^(.+?)-acceptance-report\.md$/.exec(f);
    const size = (() => { try { return fs.statSync(full).size; } catch { return 0; } })();

    if (m && !state[f]) {
      const milestone = m[1].toUpperCase();
      if (size < 500) { log(`WAIT ${f} 只有 ${size}B，太小，可能是写一半，等下一轮`); continue; }
      // 2026-10-06 新增：**文件必须先"稳住"再交接**。
      // 起因：M1.2-followup / M1.3-followup2 / MAINT2-followup2 三份报告都在**交接之后又被改过**
      // （最大一次 24076B → 23601B），说明触发器可能把"还没写完的报告"交给了验收岗，
      // 于是验收岗验的是旧版、交付物是新版 —— 又是一次无效验收。
      // 做法：连续两次扫描看到**同一大小**才认为写完了。
      const pending = state.__pending ?? {};
      if (pending[f]?.size !== size) {
        pending[f] = { size, first_seen_at: pending[f]?.first_seen_at ?? Date.now(), last_size_change_at: Date.now() };
        state.__pending = pending;
        writeState(state);
        log(`SETTLE ${f}（${size}B）第一次见到这个大小 → 等下一轮确认它不再变化再交接`);
        continue;
      }
      delete pending[f];
      state.__pending = pending;
      // 2026-10-07 新增：**验收岗还有没出报告的单 → 不许再交接**（否则它会静默丢掉上一单，见 checkAcceptanceBusy）
      if (acBusy.busy) {
        const waitlog = state.__waitlog ?? {};
        if (Date.now() - Number(waitlog[f] ?? 0) > 30 * 60 * 1000) {
          waitlog[f] = Date.now();
          state.__waitlog = waitlog;
          writeState(state);
          log(`WAIT ${f} 验收岗还有未出报告的单（${acBusy.open.map((o) => o.milestone).join("/")}，${Math.round(acBusy.ageMs / 60000)} 分钟）→ **不交接，排队**`);
        }
        continue;
      }
      // 条件 ②：工作树必须干净，否则不交接
      const repo = repoClean();
      if (!repo.clean) {
        log(`WAIT ${f} 报告已落盘但 app 工作树不干净 → 不交接（等开发提交）：${repo.dirty.join(" | ")}`);
        continue;
      }
      // 2026-10-08 新增：**产品岗按住（hold）时不许交接**。
      // 起因：开发在 15 分钟里产出 4 份报告，而最新那份（FIX2）里还有明确未做完的项
      // （用户裁决的"停写 auto-stub"仍未执行）—— 若照常交接，验收必然再判一次不通过，白烧一个窗口。
      // 用 `reports\.handoff-waivers.json` 里 `{ "hold": true }` 表达"还没做完，先别交接"。
      const held = heldMilestones();
      const waivedNow = waivedMilestones();
      // ⚠️ 2026-10-08 修正（产品岗自己踩的 bug，5 分钟内发现）：
      //    第一版只把 `waivedMilestones()` 用在了 `openHandoffs`（控制"催不催报告"），
      //    **没有用在交接路径上** ⇒ 结果重启后它**照样把已归档的那一轮交付出去了**
      //    （日志 21:27:53 HANDOFF RETRIEVAL-1-FIX1-entry-consistency-amended… + 21:28:01 HANDOFF-SENT）。
      //    **"不催"和"不交"是两件事，必须都挡。**
      if (held.has(milestone) || waivedNow.has(milestone)) {
        const holdlog = state.__holdlog ?? {};
        if (Date.now() - Number(holdlog[f] ?? 0) > 30 * 60 * 1000) {
          holdlog[f] = Date.now(); state.__holdlog = holdlog; writeState(state);
          log(`${held.has(milestone) ? "HOLD" : "WAIVED-SKIP"} ${f} ${held.has(milestone) ? "产品岗按住了这一轮" : "已被产品岗行政归档（不单独验证，并入后续轮次）"}（${milestone}）→ **不交接**`);
        }
        continue;
      }
      // ⚠️ 2026-10-13 新增（第 19 处）：**"骨架报告"不算交付，不许交接**。
      //    起因（真实事故）：产品岗要求开发「**分段落盘**」（先落骨架再逐节填，防上游中断丢结果），
      //    而触发器是"报告一出现 + 稳住 + 树干净 ⇒ 交接" ⇒ **骨架被当成交付物交了出去**，
      //    验收岗拿到一份 `## Plan  - [ ] …` 的空壳。两条规矩**直接冲突**。
      //    判据（机械、可查）：
      //      · 前 60 行里有 `STATUS: WIP / IN PROGRESS / 未完成` ⇒ 未完成；
      //      · 或前 60 行里有**未勾选的待办** `- [ ]` ⇒ 未完成（正式报告不会留这个）。
      //    命中就**不交接、不写 handoff state**（等它把标记去掉/打勾，下一轮自然会交接）。
      // ⚠️ 2026-10-17 修（真 bug，把 MEMORY-LOOP-1 卡了 30 分钟不交接）：
      //    旧判据是"前 60 行里**出现过** STATUS: WIP 就算未完成" ⇒ 报告里只要**提到**这个词
      //    （例如"首行 STATUS: WIP → STATUS: READY"这种说明句）就会被误判未完成、**永不交接**。
      //    新判据：只看**第一条形如 `STATUS: xxx` 的行**（行首锚定），以它的值为准。
      //      · 值为 READY ⇒ 视为已完成（其余地方提到 WIP 不算）；
      //      · 值含 WIP / IN PROGRESS / 未完成 ⇒ 未完成；
      //      · 一条 STATUS 行都没有 ⇒ 退回旧的启发式（未打勾的待办 / 占位符）。
      let wip = null;
      try {
        const text = fs.readFileSync(full, "utf8");
        const statusLine = /^[ \t>*_`#-]{0,8}STATUS[ \t*_`]*:[ \t*_`]*([^\n]{0,40})$/mu.exec(text);
        const statusValue = String(statusLine?.[1] ?? "").trim();
        if (statusLine) {
          if (/^(READY|DONE|COMPLETE)\b/iu.test(statusValue)) {
            wip = null;
          } else if (/WIP|IN[\s._-]?PROGRESS|未完成|DRAFT/iu.test(statusValue)) {
            wip = `第一条 STATUS 行是「${statusValue.slice(0, 30)}」`;
          }
        } else {
          const head = text.split(/\r?\n/u).slice(0, 60).join("\n");
          if (/^[ \t]*[-*][ \t]*\[[ \t]\]/mu.test(head)) wip = "前 60 行含未勾选的待办项（- [ ]）";
          else if (/to be filled|待填|占位|placeholder|_TBD_/iu.test(head)) wip = "前 60 行含占位符（to be filled / 待填 / TBD）";
        }
      } catch {}
      if (wip) {
        const wiplog = state.__wiplog ?? {};
        if (Date.now() - Number(wiplog[f] ?? 0) > 30 * 60 * 1000) {
          wiplog[f] = Date.now(); state.__wiplog = wiplog; writeState(state);
          log(`WIP-SKIP ${f}（${size}B）判定为**未完成**（${wip}）→ **不交接**（骨架不是交付物；等问题单打完勾/去掉标记）`);
        }
        continue;
      }
      // ⚠️ 2026-10-16 新增（第 20 处）：**交接必须由"交付声明"触发，而不是"文件大小稳住"**。
      //    起因（当日第二次同类事故）：开发按规矩"边做边落盘"，报告在**交接之后**还在被改写
      //    （VISIBILITY-AUDIT-2-REJECT2-dev-report.md 15202B → 15573B）⇒ 验收岗可能拿到旧版。
      //    上一次（2026-10-13 M2.1-A）是"骨架被当成品交接"，根子是同一条：**用文件状态猜"完成"**。
      //    新判据（正向、机械、可查）：报告里必须有 `STATUS: READY`（允许 **加粗** / `code` 包裹）
      //      ⇒ 才算"开发明确声明交付"。没有 ⇒ **不交接**，并按 30 分钟节流提醒产品岗一次
      //      （防止"忘了写 READY"把流水线静默堵死 —— 静默堵塞比误交接更难发现）。
      let notReady = null;
      try {
        const whole = fs.readFileSync(full, "utf8");
        if (!/STATUS:\s*[*_`\s]{0,4}READY/iu.test(whole)) notReady = "报告里没有 STATUS: READY";
      } catch (error) { notReady = `报告不可读（${error.message}）`; }
      if (notReady) {
        const nrlog = state.__notreadylog ?? {};
        if (Date.now() - Number(nrlog[f] ?? 0) > 30 * 60 * 1000) {
          nrlog[f] = Date.now(); state.__notreadylog = nrlog; writeState(state);
          log(`NOT-READY-SKIP ${f}（${size}B，已稳住且树干净）判定为**未声明交付**（${notReady}）→ 不交接（新规矩：要看 STATUS: READY）`);
          prompt(PRODUCT_SESSION, `【触发器】${milestone} 的 dev 报告已稳住、工作树也干净，但**没有 STATUS: READY** ⇒ 按 2026-10-16 的新规矩**我没有交接**。\n\n报告：${full}\n\n请你判一下：\n· 若它其实已经完成交付 → 让开发在报告里补一行 STATUS: READY（一行即可，补完下一轮就会交接）；\n· 若它还在写 → 忽略本条。\n\n（这条每 30 分钟最多一次；新规矩的起因是"报告在交接后又被改了"，导致验收岗可能读到旧版。）`).catch(() => {});
        }
        continue;
      }
      state[f] = { seen_at: new Date().toISOString(), size, action: "handoff-to-acceptance", repo_clean: true, handoff_at: Date.now(), head: repoHead(), subject: repoSubject() };
      // 显式记一笔"验收岗手上有活"（checkAcceptanceBusy 也会从 state 推导，这里是双保险）
      state.__acceptance = { milestone, report_file: f, handoff_at: Date.now() };
      writeState(state);
      log(`HANDOFF 发现 ${f}（${size}B，已稳住）且工作树干净 → 通知验收岗开始验收 ${milestone}`);
      prompt(ACCEPTANCE_SESSION, ACCEPTANCE_START(milestone, full), { critical: true })
        .then((r) => log(`HANDOFF-SENT ${milestone} http=${r.status} ${r.body}`))
        .catch((e) => log(`HANDOFF-FAIL ${milestone} ${e.message}`));
      continue;
    }

    if (a && !state[f]) {
      state[f] = { seen_at: new Date().toISOString(), size, action: "notify-product" };
      // 该单的验收报告出来了 → 解除"验收岗在忙"（若它正是手上那一单）
      if (state.__acceptance && acceptanceReportExists(state.__acceptance.milestone, files)) delete state.__acceptance;
      writeState(state);
      log(`ACCEPTANCE-DONE 发现 ${a[1]} 验收报告（${size}B）→ 产品岗请读 ${full}`);
      prompt(PRODUCT_SESSION, `【验收报告已出】${full}\n请读取、核对，并决定：通过 / 打回 / 报给用户。`, { critical: true })
        .then((r) => log(`PRODUCT-NOTIFIED http=${r.status}`))
        .catch((e) => log(`PRODUCT-NOTIFY-FAIL ${e.message}`));
      continue;
    }

    // 已经处理过但文件变了（开发补写/改写）→ 记一笔
    // ⚠️ 2026-10-06 修：原来只看"变大"，**报告变小就完全看不见**。
    // MAINT2-followup2 那次就是交接后报告被改小（24076 → 23601B），差点让验收岗验了旧版。
    if (state[f] && Math.abs(size - (state[f].size ?? 0)) > 200) {
      const before = state[f].size ?? 0;
      const delta = size - before;
      log(`REVISED ${f} 从 ${before}B 变为 ${size}B（${delta > 0 ? "+" : ""}${delta}）—— 内容被改过，产品岗注意`);
      // A. **已交接给验收岗的 dev 报告被改** → 验收岗的判据基准可能已经过期，必须立刻提醒产品岗
      //    2026-10-06 收紧：**只提醒"近期交接"的**（2 小时内）。
      //    起因：新逻辑一上线就把三份**历史报告**（M1.2-followup 等，早已关闭、没有在跑的验收）
      //    也挨个告警了一遍 —— 那些改动的基准其实是"首次扫描抓到写一半的大小"，
      //    属于历史噪音，**不该喊人**，记日志即可。真需要提醒的是"刚刚交接、还在验"的那一份。
      const handoffAge = Date.now() - Number(state[f].handoff_at ?? 0);
      const recentHandoff = state[f].action === "handoff-to-acceptance" && handoffAge < 2 * 60 * 60 * 1000;
      if (m && recentHandoff) {
        // ⚠️ 2026-10-07 改：**不再"改一次喊一次"，改成"改完了、稳住了，才喊一次"**。
        //    起因：M2.0-followup 的报告被连续改了 3 次（7725→8634→9059B），**喊了 3 次** ——
        //    同一件事的重复告警是噪声，会训练人忽略告警（而我们最怕的就是"该响的不响"）。
        //    做法：先记 `revision_pending`，等文件**连续两次扫描大小不变**再通知；期间不再喊。
        state[f].revision_pending = { size, before, since: state[f].revision_pending?.since ?? Date.now() };
        state[f].revision_notified = false; // 新的一次改动 → 允许之后再通知一次
        state[f].revised_at_ms = Date.now(); // "最后一次变化"的时刻：去噪判据用它，而不是用"记下来的大小"
        log(`REVISED-AFTER-HANDOFF（待稳住再通知）${f} 现在 ${size}B，交接于 ${Math.round(handoffAge / 60000)} 分钟前`);
      } else if (m) {
        log(`REVISED-OLD ${f}（交接于 ${state[f].handoff_at ? Math.round(handoffAge / 3600000) + " 小时前" : "很久以前"}）→ 只记日志，不告警`);
      }
      // B. 大幅**增长**（>1500B）且旧文件名 → 很可能是"新一拨交付覆写了旧文件名"（触发器不会交接）
      // ⚠️ 2026-10-07 收紧：**必须先排除"同一轮报告被补写"**，否则会误报"会静默卡死"。
      //    判据：**该里程碑的验收报告是否已经存在**。
      //      · 已存在 → 上一轮已收口，这次大幅补写**大概率是新一轮交付覆写了旧文件名** → 告警（原意图）
      //      · 不存在且交接刚发生 → 就是**同一轮**在补内容（验收岗已拿到、`REVISED-AFTER-HANDOFF` 已提醒过产品岗）
      //        → **不告警**，只记日志（实例：MAINT5 按单补写"固定影响面清单 + 附录" +5988B，被误报"会静默卡死"）
      const roundClosed = acceptanceReportExists(m?.[1] ?? "", files);
      // ⚠️ 2026-10-08 收紧：**判据从"大幅增长 >1500B"改成"该轮已收口时，任何变化都算"**。
      //    起因（产品岗自己踩的）：我给开发的单子里允许"追加到已交接的报告文件"，
      //    开发照做（6241B → 6950B，+709B，**低于 1500B 门槛**）→ 这条告警**没响**。
      //    而 handoff 判据是 `if (m && !state[f])`（第 411 行）—— **已处理过的文件名永不再交接**
      //    ⇒ 这一轮会**静默卡死**（既不交接、也不告警）。**这是最坏的失效方式。**
      //    所以：**已收口的里程碑，报告文件哪怕只变一个字节也要报**（revision_alerted 保证只报一次）。
      const closedReopen = roundClosed && delta !== 0;
      if (m && (delta > 1500 || closedReopen) && state[f].revision_alerted !== true && roundClosed) {
        state[f].revision_alerted = true;
        log(`REVISED-ALERT ${f} 变化 ${delta > 0 ? "+" : ""}${delta}B 且该里程碑已有验收报告 → 文件名已被交接处理过，**触发器不会再交接它** ⇒ 新内容会静默卡死，必须换新文件名`);
        prompt(PRODUCT_SESSION, `【触发器告警】${full}\n\n开发报告被**大幅补写**（+${delta}B），且该里程碑**已有验收报告**（上一轮已收口）——\n**很可能是新一轮交付覆写了旧文件名**，而触发器不会为它交接（该文件名已被处理过）→ 这一轮会静默卡死。\n\n若这确实是新一轮交付：让开发**换一个新报告文件名**（如 \`M1.3-followup2-dev-report.md\`）后重新落盘。\n若不是（只是补字/改错别字）：忽略本条即可。`)
          .then((r) => log(`REVISED-NOTIFY http=${r.status}`))
          .catch((e) => log(`REVISED-NOTIFY-FAIL ${e.message}`));
      } else if (m && delta > 1500) {
        log(`REVISED-SAME-ROUND ${f} 大幅补写 +${delta}B，但该里程碑**还没有验收报告** → 判为"同一轮在补内容"，不告警（REVISED-AFTER-HANDOFF 已提醒过产品岗）`);
      }
      state[f].size = size; state[f].revised_at = new Date().toISOString(); writeState(state);
    }
  }
  notifySettledRevisions(state, files);
}

/**
 * 2026-10-07 新增：**"已交接的 dev 报告被改"这件事，等它稳住再通知产品岗（且只通知一次）**。
 * 与交接用同一套"连续两次扫描大小相同即算稳住"的判据；期间改了又改也不喊，
 * 避免"同一份报告改 3 次 → 喊 3 次"这种噪声（噪声会训练人忽略告警）。
 */
function notifySettledRevisions(state, files) {
  for (const [f, v] of Object.entries(state)) {
    if (f.startsWith("__") || !/-dev-report\.md$/.test(f)) continue;
    if (!v?.revision_pending || v.revision_notified === true) continue;
    if (v.action !== "handoff-to-acceptance") continue;
    // ⚠️ 2026-10-08 去噪（这一条是被自己烦到才修的）：**已收口 + 已报过"不会再交接"的文件，不再重复通知**。
    //    起因：同一份已收口的报告被反复追加（6,241 → 6,950 → 7,166B …），
    //    每次都会 ①先触发 REVISED-ALERT（说清"触发器不会再交接它、会静默卡死、要换新文件名"），
    //    ②再触发本函数一次 —— **同一件事报两遍，而且会随时间无限重复**。
    //    两条的处置完全相同（换新文件名）⇒ **只留信息更全的第一条**。
    //    注意：**只在"已收口"时去重**；窗口还开着的（正常交接中）报告仍照旧通知，
    //    因为那条是"验收可能在读旧版"的唯一提醒，**不能省**。
    let closedForDedupe = false;
    try {
      const filesD = fs.readdirSync(REPORTS).filter((x) => x.endsWith(".md"));
      closedForDedupe = acceptanceReportExists((/^(.+?)-dev-report\.md$/.exec(f) ?? [])[1] ?? "", filesD);
    } catch {}
    if (closedForDedupe && v.revision_alerted === true) {
      v.revision_notified = true;
      writeState(state);
      log(`REVISED-AFTER-HANDOFF-DEDUPED ${f} 该轮已收口、且已报过"不会再交接" → 不重复通知（处置仍是：换新文件名）`);
      continue;
    }
    const handoffAge = Date.now() - Number(v.handoff_at ?? 0);
    let size = 0;
    try { size = fs.statSync(path.join(REPORTS, f)).size; } catch { continue; }
    // ⚠️ bug 修正（2026-10-07，我自己踩的）：**不能拿"刚记下来的大小"当"已稳住"** ——
    //    那样在"发现变化的同一轮"就会判定稳住并立刻通知（等于没去噪）。
    //    正确判据：**距最后一次变化至少过了一个扫描周期**，且期间大小没再变。
    const sinceLastChange = Date.now() - Number(v.revised_at_ms ?? 0);
    if (sinceLastChange < INTERVAL_MS) continue;              // 刚变过 → 至少等一个周期
    if (Number(v.revision_pending.size) !== size) {           // 还在变 → 记下新大小，等下一轮
      v.revision_pending = { size, since: v.revision_pending.since };
      writeState(state);
      continue;
    }
    const settledMs = Date.now() - Number(v.revision_pending.since ?? 0);
    const before = Number(v.revision_pending.before ?? 0);
    // ⚠️ 2026-10-08 新增（真实事故换来的）：**"变小"不是"增补"，是"替换"**。
    //    实例：RETRIEVAL-1-dev-report.md 10,217B（已完成轮次）→ 3,402B（新一轮），
    //    标题从中文换成英文、语言都变了 —— 但旧告警只会说"被改过（现已稳住）"，
    //    并**无条件建议"让验收重读当前版本"**。而那时那一轮的验收窗口**早已关闭**、
    //    裁定也已下过 ⇒ 照它做会把**新一轮的报告**塞给验收去重验**旧轮**，制造混乱。
    //    修法两件：① 变小 ⇒ 单独判为"替换/覆盖"，措辞与"增补"区分开；
    //             ② "让验收重读"这条建议**只在验收窗口还开着时**才给。
    let windowOpen = false;
    try {
      const filesNow = fs.readdirSync(REPORTS).filter((x) => x.endsWith(".md"));
      windowOpen = openHandoffs(state, filesNow).some((o) => o.reportFile === f);
    } catch {}
    v.revision_notified = true;
    writeState(state);
    if (before > 0 && size < before) {
      log(`REVISED-AFTER-HANDOFF-REPLACED ${f} ${before}B → ${size}B（**变小** ⇒ 不是增补，是替换；验收窗口${windowOpen ? "仍开着" : "已关闭"}）`);
      prompt(PRODUCT_SESSION, `【触发器告警】**报告被"替换"了，不是被增补**：${path.join(REPORTS, f)}\n\n大小 **${before}B → ${size}B（变小）**，交接于 ${Math.round(handoffAge / 60000)} 分钟前。\n**变小 + 交接已久 ⇒ 很可能是新一轮交付覆写了旧文件名（记录损失）**，而不是同一轮补内容。\n\n${windowOpen ? "该文件的**验收窗口还开着** → 让验收**重读当前版本**，并注明读到的字节数 + 它实际验的 sha。" : "⚠️ 该文件的**验收窗口已经关闭**（该里程碑已有验收报告）→ **不要**让验收重读：这份文件**已经不属于那一轮**了。\n**并且（更急的）**：这个**文件名已经被交接处理过**（`handoff-watch.mjs:411` 是 `if (m && !state[f])`）⇒ **触发器永远不会再交接它** —— 如果这里面装的是**新一轮**的内容，它**不会被交给验收岗，会静默卡死**。\n**修法只有一个：换新文件名**（如 `XXX-followup-dev-report.md`）。"}\n\n建议动作：核对**大小差 + 文件头（标题/语言）**，然后按下面的规矩处置 ——\n① **新一轮交付写错/复用文件名** → 让它**换成带轮次标识的新文件名**（否则不交接、会静默卡死）；\n② **就地改写历史报告** → 按**记录事故**留案（写清丢了什么、权威材料在哪），并立规禁止。\n（本条只在报告**稳住之后**通知一次。）`)
        .then((r) => log(`REVISED-AFTER-HANDOFF-NOTIFY http=${r.status}`))
        .catch((e) => log(`REVISED-AFTER-HANDOFF-NOTIFY-FAIL ${e.message}`));
      continue;
    }
    log(`REVISED-AFTER-HANDOFF-SETTLED ${f} 稳住于 ${size}B（改动持续约 ${Math.round(settledMs / 1000)}s，交接于 ${Math.round(handoffAge / 60000)} 分钟前）→ 通知产品岗一次`);
    prompt(PRODUCT_SESSION, `【触发器告警】**已交接的 dev 报告被改过（现已稳住）**：${path.join(REPORTS, f)}\n\n最终大小 **${size}B**（此前 ${before || "?"}B，**变大**），交接于 ${Math.round(handoffAge / 60000)} 分钟前。\n\n${windowOpen ? "验收岗已经拿到过**旧版** —— 它可能在读旧版，而交付物是新版。\n\n建议动作：给验收岗发一条提醒，要求它**重读当前版本**并注明自己读到的字节数/版本。" : "⚠️ 该文件的**验收窗口已经关闭**（该里程碑已有验收报告）→ **不要**让验收重读：这份文件已不属于那一轮，验收也已出过报告。**按记录事故处理或要求开发换新文件名。**"}\n（本条只在报告**稳住之后**通知一次；期间反复改写不会再喊。）`)
      .then((r) => log(`REVISED-AFTER-HANDOFF-NOTIFY http=${r.status}`))
      .catch((e) => log(`REVISED-AFTER-HANDOFF-NOTIFY-FAIL ${e.message}`));
    // ⚠️ 2026-10-16 新增（第 21 处）：**报告在交接后被改动时，直接提醒验收岗重读**，不再只提醒产品岗再人工转达。
    //    起因：产品岗收到"报告被改过"的告警后，还得自己判断"这份交付物是不是还有效" —— 今天那份就已经被新单取代，
    //    产品岗据此没有转达（判断是对的，但**这条链不该依赖人**）。验收窗口还开着 ⇒ 直接让验收岗重读并注明版本。
    if (windowOpen) {
      prompt(ACCEPTANCE_SESSION, `【触发器提醒】**你正在验收的这份 dev 报告，在你开始之后被改动过**：${path.join(REPORTS, f)}\n\n现在大小 **${size}B**（此前 ${before || "?"}B；交接于 ${Math.round(handoffAge / 60000)} 分钟前）。\n\n请你：① **重读当前版本**，不要用改动前读到的内容下结论；② 在验收报告里**注明你读到的字节数 + 你实际验的 sha**；③ 若新版与旧版的结论有差异，把差异单独写出来（这条提醒的意义就在这里）。\n（本条只在报告稳住之后发一次。）`)
        .then((r) => log(`REVISED-AFTER-HANDOFF-ACCEPTANCE-NOTIFY http=${r.status}`))
        .catch((e) => log(`REVISED-AFTER-HANDOFF-ACCEPTANCE-NOTIFY-FAIL ${e.message}`));
    }
  }
}

log(`交接触发器启动：每 ${INTERVAL_MS / 1000}s 扫一次 ${REPORTS}`);
scan();
setInterval(scan, INTERVAL_MS);




