// memory-lib D3.3/D4 — 主动召回（memory_recall_brief / POST /v1/recall/brief）。
// 固定五板块：当前项目状态 / 活跃计划 / 相关工具记忆 / 近期经历 / 未决与风险，
// 另有第六板块「我的经验」（当前身份有角色记忆时才出现，最多 3 条）。
// format=markdown（默认）沿用 D3；format=prompt 返回可注入系统提示的开场简报（≤1500 字、脱敏、纯文本）。
import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles, readTextFile, parseFrontmatter } from "./read-only-core.mjs";
import { parseFrontmatterTyped, parseSections, unquote } from "./frontmatter-util.mjs";
import { containsSensitiveText, redactSensitiveText } from "./extraction-quality.mjs";
import { createRoleMemory } from "./role-memory.mjs";
import { principalAllowsContainer } from "./container-policy.mjs";
import { selectCandidates } from "./recall-candidates.mjs";
import { readRecallDfStats } from "./recall-df-index.mjs";
import { memoryFactOf } from "./recall-fact.mjs";
export { memoryFactOf } from "./recall-fact.mjs";

const SECTION_TITLES = ["当前项目状态", "活跃计划", "相关工具记忆", "近期经历", "未决与风险", "近期记忆"];
const PROMPT_SECTION_TITLES = [...SECTION_TITLES, "我的经验"];
const NONE = "（明确的无）";
// INJECT-1：注入用的记忆段。范围单要求 ≤600 字、top 5~8、带 included 回执。
const MEMORY_TITLE = "近期记忆";
const MEMORY_BUDGET_CHARS = 600;
const MEMORY_TOP_DEFAULT = 6;
const MEMORY_TOP_MAX = 8;
const MEMORY_EXCERPT_CHARS = 90;
// RANK-1：单条注入单元的硬上限。超过就**整条丢弃**（reason=too-long），绝不句中断开。
const MEMORY_ITEM_MAX_CHARS = 260;
const DEFAULT_ZONE = "Asia/Shanghai";
// INDEX-1：候选文件的读取并发。改前是**顺序**读（1445 个文件实测 195ms 里绝大部分是它），
// 并发 8 路把同一批文件的读取降到 39ms，而"读哪些文件、怎么解析、怎么打分"一律没变
// （结果按文件名顺序回填，顺序与改前逐条一致）。全量扫描的回退路径也因此便宜了 3 倍。
const MEMORY_READ_CONCURRENCY = 8;
// RANK-1：可数属性问法里的量词/单位集合。这里只管"问的是哪一种量"，
// 不认任何具体名词、不认任何具体数字 —— 换个名词（层/个/条/人…）同一套机制都成立。
const COUNT_UNITS = [
  "个", "条", "层", "位", "家", "人", "名", "次", "种", "块", "门", "步", "项", "类", "套",
  "篇", "章", "节", "行", "页", "张", "只", "台", "件", "分", "秒", "倍", "成", "度", "天", "周", "月", "年",
];
// RANK-1：量词分"类"。问「几个」时，答「4 项」可以认（都是通用计数），
// 但答「180 天」不能认 —— 那是时间维度，只是句子碰巧带了数字和量词。
// 有了这个分类，"量词不同也算答案"才不会把无关句子顶上来。
const COUNT_UNIT_CLASS = new Map(
  COUNT_UNITS.map((unit) => [unit, ["天", "周", "月", "年", "秒", "分"].includes(unit) ? "time" : ["倍", "成", "度"].includes(unit) ? "ratio" : "general"]),
);
const COUNT_QUERY_RE = new RegExp(`(?:几|多少)\\s*(${COUNT_UNITS.join("|")})`, "u");
// 数字（阿拉伯/中文）+ 量词。用于判断"这句话是不是直接回答了那个数量"。
const NUMBER_CLASS = "\\d+|[一二三四五六七八九十百千万零两]+";
// RANK-1：判断"数字是不是就在被问的东西旁边"的窗口（前 / 后，单位：字符）。
const COUNT_WINDOW_BEFORE = 15;
const COUNT_WINDOW_AFTER = 6;
// Windows 绝对路径 + 常见凭据形态（prompt 输出必须脱敏）
const ABS_PATH_RE = /[A-Za-z]:\\[^\s，。；;"'（）()]+/gu;
const CRED_RE = /\b(sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/gu;

export function createRecall({ dataRoot, workspaceRoot } = {}) {
  if (!dataRoot) throw new Error("recall requires dataRoot");
  const projectRoot = path.join(dataRoot, "project-state");
  const plansRoot = path.join(dataRoot, "plans");
  const toolsRoot = path.join(dataRoot, "tools-memory");
  const memoriesRoot = path.join(dataRoot, "curated", "shared");
  const roleMemory = createRoleMemory({ dataRoot });

  // VISIBILITY-FIX-1-REJECT：本模块的三个"扫目录"读法（项目状态 / 活跃计划 / 工具记忆）
  // 此前**直接把文件内容拼进简报**，完全不做归属判定 —— 于是别人的 private 计划/工具记忆
  // 会经 `memory_recall_brief`（REST 与 /mcp 都算）泄露。这里对每个容器**按它自己的可见性默认**
  // 调用同一套 container-policy 判据（与 plans-memory/tools-memory/project-memory 的 list 保持一致）：
  //   plan → default private；tool → default platform；project → default project。
  // 注意方向：这**不是**把工具记忆收紧成 private（那会砍掉平台共享，属放宽/收紧之外的行为变更）。
  const visible = (principal, frontmatter, container, extra = {}) => {
    if (!principal) return false; // 拿不到身份 ⇒ 不放行（默认拒绝；调用方已要求身份）
    const defaults = { plan: "private", tool: "platform", project: "project" };
    return principalAllowsContainer(principal, {
      ...frontmatter,
      container,
      visibility: frontmatter?.visibility ?? defaults[container] ?? "private",
      ...extra,
    });
  };

  async function projectState(project, principal = null) {
    if (!project) return NONE;
    const dir = path.join(projectRoot, slugify(project));
    const filePath = path.join(dir, "current-state.md");
    const text = await readTextFile(filePath);
    if (!text) return NONE;
    const { frontmatter, body } = parseFrontmatterTyped(text);
    if (!visible(principal, frontmatter, "project", { project })) return NONE;
    const sections = parseSections(body, ["目标", "当前进展", "下一步", "阻塞"]);
    const parts = [];
    if (sections["目标"]) parts.push(`目标：${sections["目标"]}`);
    if (sections["当前进展"]) parts.push(`进展：${sections["当前进展"]}`);
    if (sections["阻塞"] && sections["阻塞"] !== "当前无阻塞") parts.push(`阻塞：${sections["阻塞"]}`);
    return parts.join("；") || `项目 ${project}（updated_at ${frontmatter.updated_at ?? ""}）`;
  }

  // F2：未指定 project 时列出所有项目的 current-state（新会话不知道项目名）。
  async function projectStates(project, principal = null) {
    if (project) return projectState(project, principal);
    const states = [];
    for (const filePath of await walkFiles(projectRoot)) {
      if (path.basename(filePath) !== "current-state.md") continue;
      const text = await readTextFile(filePath);
      if (!text) continue;
      const { frontmatter, body } = parseFrontmatterTyped(text);
      const proj = frontmatter.project ?? path.basename(path.dirname(filePath));
      if (!visible(principal, frontmatter, "project", { project: proj })) continue;
      const sections = parseSections(body, ["目标", "当前进展", "阻塞"]);
      const parts = [];
      if (sections["目标"]) parts.push(`目标：${sections["目标"]}`);
      if (sections["当前进展"]) parts.push(`进展：${sections["当前进展"]}`);
      states.push(`[${proj}] ${parts.join("；") || "（无）"}`);
    }
    return states.length ? states.join("\n") : NONE;
  }

  async function activePlans(principal = null) {
    const items = [];
    for (const filePath of await walkFiles(plansRoot)) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const { frontmatter, body } = parseFrontmatterTyped(text);
      if (frontmatter.status !== "active") continue;
      if (!visible(principal, frontmatter, "plan")) continue;
      const sections = parseSections(body, ["目标", "当前卡点"]);
      const blocker = sections["当前卡点"] && sections["当前卡点"] !== "无" ? `，卡点：${sections["当前卡点"]}` : "";
      items.push(`${frontmatter.topic ?? path.basename(filePath, ".md")}：${sections["目标"] ?? ""}${blocker}`);
    }
    return items.length ? items.join("；") : NONE;
  }

  async function tools(principal = null) {
    const items = [];
    for (const filePath of await walkFiles(toolsRoot)) {
      const text = await readTextFile(filePath);
      if (!text) continue;
      const { frontmatter, body } = parseFrontmatterTyped(text);
      if (String(frontmatter.status ?? "active") !== "active") continue;
      if (!visible(principal, frontmatter, "tool")) continue;
      const sections = parseSections(body, ["用途"]);
      const purpose = String(sections["用途"] ?? "").replace(/[。；;]+$/, "");
      items.push(`${frontmatter.tool_name ?? path.basename(filePath, ".md")}：${purpose}（验证 ${String(frontmatter.verified_at ?? "").slice(0, 10)}）`);
    }
    return items.length ? items.join("；") : NONE;
  }

  async function recentEpisodes() {
    return { text: NONE, pendingItems: [] };
  }

  // INJECT-1：第六段「近期记忆」——**直接读 curated/shared**。
  //
  // 为什么必须加这一段：本模块原来只读 project-state / plans / tools-memory / 角色记忆，
  // 而记忆库里 700+ 条长期记忆全在 curated/shared ⇒ brief 六个段落全是「（明确的无）」，
  // 拿去做注入等于什么都没注入（范围单实测）。
  //
  // 取法：
  //   有 query ⇒ 按**词面相关度**挑（宁可少给，也不给无关的）；没有 query ⇒ 按近 days 天。
  //   这里刻意不走向量：brief 在每次对话前都会被调一次，要便宜、要确定、要能被单测钉死。
  //   相关度不够的条目不进段——范围单明确禁止"为了看起来命中而放宽到返噪"。
  // 可见性：沿用本模块同一套 container-policy 判据（visible()），不另写一套。
  async function recentMemories({ query = null, principal = null, days = 7, max = MEMORY_TOP_DEFAULT, budgetChars = MEMORY_BUDGET_CHARS } = {}) {
    const wanted = Math.max(1, Math.min(MEMORY_TOP_MAX, Number(max) || MEMORY_TOP_DEFAULT));
    const budget = Math.max(80, Number(budgetChars) || MEMORY_BUDGET_CHARS);
    // CJK-FILLER-1：自然问句（"我上次说我对什么过敏来着"）切出来的 bigram 里混着
    // 「什么/怎么/我的/来着」这类虚词，把"命中数"撑高却没有任何信息量；真正的实词
    // 只命中 1 个时会被 scoreTokens 的"≥2 命中或一个 ≥4 字 token"挡在门外。
    // 这里只剔除**明确的疑问/代词/助词 bigram**（白名单式、写死可见），
    // 门槛本身一个字都不动；剔完若一个不剩，原样回退，避免短问句被清空。
    const rawTokens = queryTokens(query);
    const contentTokens = rawTokens.filter((token) => !CJK_FILLER_BIGRAMS.has(token));
    const tokens = contentTokens.length ? contentTokens : rawTokens;
    const hasQuery = String(query ?? "").trim().length > 0;
    const queryCharacterCount = [...String(query ?? "").replace(/\s/gu, "")].length;
    // RANK-1：问的是可数属性吗（几层／几个／多少人…）？是的话，"直接给出那个数量"的句子要排前面。
    const countUnit = tokens.length ? countQueryUnit(query) : null;
    const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 24 * 3600 * 1000;
    const cutoffDay = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_ZONE }).format(new Date(cutoff));

    // SHORT-Q-1 只对 token ≤2 且最长 token ≤2 字的短问句允许单 token 命中；其余够格门槛不变。
    //
    // INDEX-1：改前这里无条件 `walkFiles(memoriesRoot)` + 逐个顺序读**全部** md（1445 个 ⇒ 195ms）。
    // 现在先用增量索引的 `fts_chunks` 把"要从哪些文件里找"缩下来（≥3 字片段 OR，按命中数降序，≤800），
    // 再把这批**候选文件**交给下面一模一样的取值/打分/排序/打包逻辑。
    // 索引缺失/损坏/查询报错/候选为空/候选填不满注入位数/新文件过多 ⇒ `mode:"full"`，**退回改前的全量扫描**。
    let scan = await selectCandidates({ dataRoot, memoriesRoot, query, wanted });
    // CJK-FILLER-3：多 token 的自然问句（"我上次说我我对什么过敏来着"）用 FTS 预筛
    // 会把正确答案筛在外面（实测只剩 43 个候选、目标文件不在其中），而全量扫描
    // 实测只要 ~14ms（1600 个文件）。少给一次错误答案远比省 14ms 重要 ⇒ 直接全量。
    if (scan.mode === "candidates" && tokens.length >= 3) {
      scan = { ...scan, mode: "full", source: "full", paths: null, reason: "long-query-full-scan" };
    }
    let globalDfStats = null;
    if (tokens.length && scan.mode === "candidates") {
      globalDfStats = readRecallDfStats({ dataRoot, tokens });
      if (!globalDfStats.ok) {
        scan = { ...scan, mode: "full", source: "full", paths: null, reason: globalDfStats.reason };
        globalDfStats = null;
      }
    }
    const candidatePaths = scan.mode === "candidates" ? scan.paths : await walkFiles(memoriesRoot);
    const filePaths = candidatePaths.filter((filePath) => filePath.endsWith(".md"));
    const texts = await readTextsPooled(filePaths, MEMORY_READ_CONCURRENCY);

    const rows = [];
    for (let i = 0; i < filePaths.length; i += 1) {
      const filePath = filePaths[i];
      const text = texts[i];
      if (!text) continue;
      const { frontmatter, body } = parseFrontmatterTyped(text);
      if (String(frontmatter.status ?? "active") !== "active") continue;
      const container = frontmatter.container ?? "long-term";
      if (!visible(principal, frontmatter, container)) continue;
      const fact = memoryFactOf(body);
      if (!fact) continue;
      const calendarDate = String(frontmatter.calendarDate ?? frontmatter.valid_from ?? frontmatter.occurred_at ?? "").slice(0, 10);
      const id = frontmatter.id ?? path.basename(filePath, ".md");
      if (!tokens.length && calendarDate && calendarDate < cutoffDay) continue; // 没有 query 就只给近 N 天
      rows.push({ id, calendarDate, fact });
    }

    // RANK-1 第 2 阶段：算每个 query token 的**区分度**（df：这条词在多少条记忆里出现过）。
    // 为什么要有这一步：改前 `weight += token.length` 是纯词长加权 —— `commit`（6 字符）这种
    // 到处都在的词比 `D3F6`（4 字符）这种只在一条里出现的词权重还高，于是"到处都在的词"
    // 把真正的答案压下去（范围单 §二 的根因）。这里按 idf 打折：越普遍的词越不值钱。
    const df = new Map(tokens.map((t) => [t, 0]));
    let corpusSize = rows.length;
    if (tokens.length && globalDfStats) {
      const visibleFileIds = new Set();
      for (const doc of globalDfStats.docs) {
        const frontmatter = doc.frontmatter ?? {};
        if (!doc.hasFact || String(frontmatter.status ?? "active") !== "active") continue;
        const container = frontmatter.container ?? "long-term";
        if (!visible(principal, frontmatter, container)) continue;
        visibleFileIds.add(doc.fileId);
      }
      corpusSize = visibleFileIds.size;
      for (const token of tokens) {
        let count = 0;
        for (const fileId of globalDfStats.postings.get(token) ?? []) if (visibleFileIds.has(fileId)) count += 1;
        df.set(token, count);
      }
    } else if (tokens.length) {
      for (const row of rows) {
        const hay = normalizeDashes(`${row.fact}\n${row.id}`).toLowerCase();
        for (const t of tokens) if (t && hay.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
    const N = Math.max(1, corpusSize);
    const weightOf = (t) => t.length * Math.log(1 + N / (1 + (df.get(t) ?? 0)));

    // CJK-FILLER-2：一个词**库里根本没有**（df=0）时，它说明不了"这条记忆不相关"，
    // 只能说明这个词不在记忆词汇表里 —— 自然问句的剩余部分几乎全是这种词
    // （"我上次说我我对什么过敏来着" → 我上/次说/说我/敏来 …）。
    // 所以判相关时只拿"库里真实存在的词"投门槛；一个存在的都没有时原样回退。
    const scoredTokens = (() => {
      if (!tokens.length) return tokens;
      const present = tokens.filter((t) => (df.get(t) ?? 0) > 0);
      return present.length ? present : tokens;
    })();
    const longestScored = scoredTokens.reduce((max, token) => Math.max(max, [...String(token ?? "")].length), 0);
    // CJK-FILLER-4：门槛按**过滤后的实词**判定，而不是原始问句长度。
    // "我对什么过敏" 原始 6 字（旧判据 → 非短问句），但它过滤后只剩「过敏」一个实词，
    // 就该按短问句（命中 ≥1 即可）来判；否则自然问句永远够不着门槛。
    const isShortQuery = scoredTokens.length > 0 && scoredTokens.length <= 2 && longestScored <= 2;

    const candidates = [];
    for (const row of rows) {
      if (scoredTokens.length) {
    const score = scoreTokens(scoredTokens, `${row.fact}\n${row.id}`, { shortQuery: isShortQuery });
        if (!score.enough) continue; // 不相关的**一条都不进**（宁可少注入）
        let weight = 0;
        const hay = normalizeDashes(`${row.fact}\n${row.id}`).toLowerCase();
        for (const t of scoredTokens) if (t && hay.includes(t)) weight += weightOf(t);
        // RANK-1：这条记忆里有没有"数字+被问的量词"、且数字离被问的东西不远（如 8层）。
        //   档 2 = 量词完全对口；档 1 = 量词不同但"数字+量词"那句确实在答这个问题
        //          （问"过了几个"、答"4 项通过"）；档 0 = 只是提到了相关名词。
        const answersCount = countUnit ? factAnswersCount(row.fact, countUnit, tokens) : false;
        const answersCountAny = countUnit && !answersCount ? Boolean(anyUnitAnswerSentence(row.fact, tokens, { unit: countUnit })) : false;
        const answerTier = answersCount ? 2 : answersCountAny ? 1 : 0;
        candidates.push({ id: row.id, calendarDate: row.calendarDate, fact: row.fact, score: weight, answersCount, answersCountAny, answerTier });
      } else if (!hasQuery || queryCharacterCount > 1) {
        // 单字噪声不放行；多字符但因空格切分而无 token 的旧问法继续沿用近期记忆兜底。
        candidates.push({ id: row.id, calendarDate: row.calendarDate, fact: row.fact, score: 0, answersCount: false, answersCountAny: false, answerTier: 0 });
      }
    }

    // RANK-1 排序（三档）：
    //   ① 问题问的是数量时，"直接给出那个数量"的那句排在"只提到名词"的那句前面；
    //   ② 同一档内按区分度加权后的词面相关度；
    //   ③ 再同分按日期（方向与改前一致）、最后按 id 稳定排序。
    // 注：① 只是插了一个布尔优先档 —— 没有写死任何数字、任何 id、任何具体名词。
    candidates.sort(
      (a, b) =>
        (b.answerTier ?? 0) - (a.answerTier ?? 0) ||
        b.score - a.score ||
        String(a.calendarDate).localeCompare(String(b.calendarDate)) ||
        String(a.id).localeCompare(String(b.id)),
    );

    // RANK-1 打包：**单位是整句**。
    //   · 一条记忆要么整句进去，要么整条不进 —— 绝不句中断开（改前会按 90 字切一半再补「…」）；
    //   · 装不下就**换下一条**（continue 而不是 break）：小条目还能补位；
    //   · 第 1 名先占位（rank===1 时它面前是全额预算），不会被后面的条目挤掉。
    const picked = [];
    const included = [];
    const dropped = [];
    let used = 0;
    let firstPick = null;
    for (const item of candidates) {
      const rank = included.length + dropped.length + 1;
      if (included.length >= wanted) {
        dropped.push({ id: item.id, rank, reason: "top-limit" });
        continue;
      }
      const excerpt = sanitizePrompt(pickSentence(item.fact, { countUnit, tokens })).trim();
      if (!excerpt) {
        dropped.push({ id: item.id, rank, reason: "empty" });
        continue;
      }
      if (excerpt.length > MEMORY_ITEM_MAX_CHARS) {
        dropped.push({ id: item.id, rank, reason: "too-long", chars: excerpt.length });
        continue;
      }
      const line = `- [${item.calendarDate || "日期未知"}] ${excerpt}`;
      const next = used + line.length + (picked.length ? 1 : 0);
      if (next > budget) {
        dropped.push({ id: item.id, rank, reason: "budget", chars: line.length });
        continue;
      }
      if (rank === 1) firstPick = { id: item.id, chars: line.length };
      picked.push(line);
      included.push({
        id: item.id,
        calendarDate: item.calendarDate || null,
        excerpt,
        rank,
        chars: line.length,
        answersCount: Boolean(item.answersCount),
        answersCountAny: Boolean(item.answersCountAny),
      });
      used = next;
    }

    const truncated = dropped.some((d) => d.reason === "budget" || d.reason === "too-long" || d.reason === "top-limit");
    const base = {
      included,
      dropped,
      considered: candidates.length,
      count_unit: countUnit,
      answer_first: included.find((x) => x.answersCount || x.answersCountAny)?.id ?? null,
      answer_exact: included.find((x) => x.answersCount)?.id ?? null,
      first_pick: firstPick,
      used_chars: used,
      // INDEX-1：只增字段 —— 这一轮"从哪儿找的候选"，验收据此判断走的是哪条路。
      candidate_source: scan.source, // "fts" / "df-bigram" / "mixed" / "full"
      candidate_files: filePaths.length, // 这一轮实际读了多少个文件（fts=候选数，full=全量）
      scan_ms: scan.scanMs, // 粗筛耗时（索引查询 + 目录列举 + 新鲜度比对；不含读文件与打分）
      candidate_reason: scan.reason, // 走 full 的原因（null=用了索引候选）
    };
    if (!picked.length) return { text: NONE, ...base, truncated: false };
    return { text: picked.join("\n"), ...base, truncated };
  }

  // D4.1：第六板块「我的经验」——当前身份（agent_id/role_id）的 active 角色记忆，最多 3 条。
  // VISIBILITY-FIX-1-REJECT：身份必须**透到仓储**（`listRoleNotes` 现在要求 principal）。
  // 此前只传了 agent_id/role_id ⇒ 仓储侧 requirePrincipal 抛 MISSING_PRINCIPAL，
  // 把所有**有身份的**调用者都打成 403（修前是 200）——那是回归，不是加固。
  // 这里把服务端解析出来的 principal 一并传下去；agent_id/role_id 仅作为"进一步过滤"。
  async function myExperience(agent_id, role_id, principal = null) {
    if (!agent_id && !role_id) return null;
    const notes = (await roleMemory.listRoleNotes({ agent_id: agent_id ?? undefined, role_id: role_id ?? undefined, principal }))
      .filter((n) => n.status === "active")
      .slice(0, 3);
    if (!notes.length) return null;
    return notes.map((n) => `[${n.kind}] ${n.sections?.["经验"] ?? ""}`).join("\n");
  }

  async function recallBrief({ project = null, days = 7, limit_chars = 2000, agent_id = null, role_id = null, format = "markdown", principal = null, query = null, memories = MEMORY_TOP_DEFAULT, memory_limit_chars = MEMORY_BUDGET_CHARS, memory_only = false } = {}) {
    const [state, plans, tool, ep, experience, memoryBlock] = await Promise.all([
      projectStates(project, principal),
      activePlans(principal),
      tools(principal),
      recentEpisodes(days),
      myExperience(agent_id, role_id, principal),
      recentMemories({ query, principal, days, max: memories, budgetChars: memory_limit_chars }),
    ]);
    const episodes = ep.text;
    // 未决与风险：项目阻塞 + 计划卡点 + 经历未决项
    const riskParts = [];
    if (state !== NONE && /阻塞/.test(state)) riskParts.push(state.split("阻塞：")[1]?.split("；")[0] ?? state);
    if (plans !== NONE && /卡点/.test(plans)) riskParts.push(plans.split("卡点：")[1]?.split("；")[0] ?? "");
    riskParts.push(...(ep.pendingItems ?? []));
    const risks = riskParts.filter(Boolean).join("；") || NONE;

    const sections = {
      "当前项目状态": state,
      "活跃计划": plans,
      "相关工具记忆": tool,
      "近期经历": episodes,
      "未决与风险": risks,
      [MEMORY_TITLE]: memoryBlock.text,
    };
    if (experience) sections["我的经验"] = experience;

    const isPrompt = String(format) === "prompt";
    // memory_only：只渲染「近期记忆」段。给"代理注入"用——它只要记忆，不要别的五段，
    // 否则 600 字预算里一半会被项目状态/计划占掉，注入的记忆反而更少。
    if (memory_only) {
      const capOnly = Math.max(80, Math.min(Number(memory_limit_chars) || MEMORY_BUDGET_CHARS, MEMORY_BUDGET_CHARS));
      const only = sanitizePrompt(memoryBlock.text).trim() || NONE;
      // RANK-1：打包已经在 recentMemories 里按**整条**做完了，这里只做长度兜底，
      // 而且兜底也是**从整条开始丢**（绝不句中断开）。改前这里是 truncateAtSentence ——
      // 它会在任意位置把文本切成半句，是"注入里出现「…tools-memory、pl…」"的直接来源。
      const textOnly = fitWholeLines(only, capOnly);
      return {
        text: textOnly,
        sections: { [MEMORY_TITLE]: textOnly },
        total_chars: textOnly.length,
        project: project ?? null,
        days: Number(days) || 7,
        format: isPrompt ? "prompt" : "markdown",
        query: typeof query === "string" && query.trim() ? query.trim() : null,
        included: memoryBlock.included,
        dropped: memoryBlock.dropped,
        count_unit: memoryBlock.count_unit ?? null,
        answer_first: memoryBlock.answer_first ?? null,
        first_pick: memoryBlock.first_pick ?? null,
        memory_used_chars: memoryBlock.used_chars ?? null,
        memory_truncated: memoryBlock.truncated,
        candidate_source: memoryBlock.candidate_source ?? null,
        candidate_files: memoryBlock.candidate_files ?? null,
        scan_ms: memoryBlock.scan_ms ?? null,
        candidate_reason: memoryBlock.candidate_reason ?? null,
        memory_only: true,
      };
    }

    const keys = isPrompt ? PROMPT_SECTION_TITLES : Object.keys(sections);
    const cap = isPrompt ? Math.max(200, Math.min(1500, Number(limit_chars) || 1500)) : Math.max(200, Number(limit_chars) || 2000);
    const text = isPrompt ? renderPrompt(sections, cap) : boundBrief(sections, cap);
    return {
      text,
      sections,
      total_chars: text.length,
      project: project ?? null,
      days: Number(days) || 7,
      format: isPrompt ? "prompt" : "markdown",
      query: typeof query === "string" && query.trim() ? query.trim() : null,
      included: memoryBlock.included,
      dropped: memoryBlock.dropped,
      count_unit: memoryBlock.count_unit ?? null,
      answer_first: memoryBlock.answer_first ?? null,
      first_pick: memoryBlock.first_pick ?? null,
      memory_used_chars: memoryBlock.used_chars ?? null,
      memory_truncated: memoryBlock.truncated,
      candidate_source: memoryBlock.candidate_source ?? null,
      candidate_files: memoryBlock.candidate_files ?? null,
      scan_ms: memoryBlock.scan_ms ?? null,
      candidate_reason: memoryBlock.candidate_reason ?? null,
      memory_only: false,
    };
  }

  return { recallBrief };
}

// format=prompt：以 `## 记忆简报` 开头，六板块各一行标题 + 内容，空板块写「（明确的无）」，
// ≤1500 字、纯文本无表格无 emoji、无凭证/绝对路径。
function renderPrompt(sections, limit) {
  const lines = ["## 记忆简报", ""];
  for (const title of PROMPT_SECTION_TITLES) {
    const content = sanitizePrompt(String(sections[title] ?? "")).trim() || NONE;
    lines.push(`### ${title}`, content, "");
  }
  let text = lines.join("\n").trim();
  if (text.length > limit) {
    text = truncateAtSentence(text, limit);
  }
  return text;
}

function sanitizePrompt(text) {
  let t = String(text ?? "");
  t = redactSensitiveText(t);
  t = t.replace(ABS_PATH_RE, "[本机路径已隐藏]");
  t = t.replace(CRED_RE, "[凭证已隐藏]");
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ""); // 去 emoji
  t = t.replace(/^\s*\|.*$/gmu, ""); // 去表格行
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function slugify(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unnamed";
}

// ---------------------------------------------------------------------------
// INDEX-1：候选文件的并发读取
// ---------------------------------------------------------------------------

/**
 * 并发读一批文件，**按入参顺序回填**（`out[i]` 对应 `paths[i]`），读不到的位置是 `null`。
 * 语义与"逐个 await readTextFile"等价：同一批文件、同样只读、同样的失败即跳过；
 * 只是把 1445 次串行 I/O 摊成 8 路并发（实测 195ms → 39ms）。
 */
async function readTextsPooled(paths, concurrency = 8) {
  const out = new Array(paths.length).fill(null);
  const width = Math.max(1, Math.min(Number(concurrency) || 1, paths.length || 1));
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= paths.length) return;
      out[index] = await readTextFile(paths[index]);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// INJECT-1：近期记忆段的取材工具
// ---------------------------------------------------------------------------

/** 压成一句话（到第一个句末标点），不搬原文全文。`maxChars<=0` ⇒ 整句不截（RANK-1 的打包单位）。 */
export function firstSentence(text, maxChars = MEMORY_EXCERPT_CHARS) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  const stop = flat.search(/[。；！？.!?]/u);
  const one = stop >= 0 ? flat.slice(0, stop + 1) : flat;
  if (!(maxChars > 0)) return one;
  return one.length > maxChars ? `${one.slice(0, maxChars)}…` : one;
}

// ---------------------------------------------------------------------------
// RANK-1：可数属性问法（"几层/几个/多少人…"）⇒ 让"直接给出那个数量"的句子排首位
// ---------------------------------------------------------------------------

/** 问法里的量词（"记忆库有几层" ⇒ "层"；"分几个" ⇒ "个"）。不是可数问法就返回 null。 */
export function countQueryUnit(query) {
  const m = String(query ?? "").match(COUNT_QUERY_RE);
  return m ? m[1] : null;
}

/**
 * 这段文字里是否出现了「数字 + 该量词」，**并且那个数字就在被问的东西旁边**。
 *
 * 为什么要有"旁边"这个条件：只说"数字+量词"会把无关句子也点亮 ——
 * 问「D1 复验硬标准过了几个」，一条写着"…并抽 **3 个**事实比对 evidence…"的记忆
 * 会凭「3 个」被顶到最前，可它答的根本不是这个问。真正的答案里数字和被问的名词是挨着的：
 * 「5 项**硬标准**中 **4 项**通过」。所以要求：数字前后一小段（前 15 字 / 后 6 字）里
 * 出现**任意一个问句 token**。
 */
export function factAnswersCount(text, unit, tokens = []) {
  if (!unit) return false;
  const hay = normalizeDashes(String(text ?? "")).toLowerCase();
  const re = new RegExp(`(?:${NUMBER_CLASS})\\s*${escapeRe(unit)}`, "gu");
  const wanted = (tokens ?? []).filter(Boolean);
  let m;
  while ((m = re.exec(hay)) !== null) {
    if (!wanted.length) return true;
    const from = Math.max(0, m.index - COUNT_WINDOW_BEFORE);
    const to = Math.min(hay.length, m.index + m[0].length + COUNT_WINDOW_AFTER);
    const around = hay.slice(from, to);
    if (wanted.some((t) => around.includes(t))) return true;
    if (m.index === re.lastIndex) re.lastIndex += 1; // 防零宽死循环
  }
  return false;
}

function escapeRe(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 挑出要注入的那一句：**整句**，不改写、不截断。
 *   ① 问的是可数属性时：先找"数字+被问的量词"那句（如问几层→8层）；
 *   ② 没有完全对口的，就找"数字+任一量词、且这句和问题足够相关"那句
 *      （问"过了几个"，答的是"4 项通过" —— 量词不同也得认）；
 *   ③ 都不是：取与本轮问题**词面重叠最多**的那一句（同分取靠前的）。
 * 一条记忆只贡献一句，所以注入文本永远是完整句子 —— 绝不会出现半句。
 */
export function pickSentence(text, { countUnit = null, tokens = [] } = {}) {
  const sentences = splitSentences(text);
  if (!sentences.length) return "";
  if (countUnit) {
    const exact = sentences.find((s) => factAnswersCount(s, countUnit, tokens));
    if (exact) return exact;
    const anyUnit = sentences.find((s) => factHasNumberUnit(s) && scoreTokens(tokens, s).enough);
    if (anyUnit) return anyUnit;
  }
  if (!tokens.length) return sentences[0];
  let best = sentences[0];
  let bestWeight = scoreTokens(tokens, best).weight;
  for (const s of sentences.slice(1)) {
    const w = scoreTokens(tokens, s).weight;
    if (w > bestWeight) {
      best = s;
      bestWeight = w;
    }
  }
  return best;
}

/** 任意「数字 + 量词」（不限被问的那一个）。 */
export function factHasNumberUnit(text) {
  return new RegExp(`(?:${NUMBER_CLASS})\\s*(?:${COUNT_UNITS.join("|")})`, "u").test(String(text ?? ""));
}

/**
 * 按句末/分句标点切句（保留标点），空段丢掉。切出来的一定是完整的一句/一个分句。
 * **括号里的标点不算断句**：记忆里常见「（以。！？结尾）」「参看《甲。乙》」这种写法，
 * 按标点硬切会切出「必须是完整可读句子（以。」这种碎片 —— 那正是"半句"。
 */
export function splitSentences(text) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!flat) return [];
  const OPEN = "（(【[《〈「『“‘";
  const CLOSE = "）)】]》〉」』”’";
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of flat) {
    buf += ch;
    if (OPEN.includes(ch)) {
      depth += 1;
      continue;
    }
    if (CLOSE.includes(ch)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && "。；！？!?;".includes(ch)) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 这条记忆里有没有"数字+量词"、且那句与问题足够相关（用于"问几个、答 4 项"这种量词错位）。
 * 只认同**一类**量词：问"几个"时，"4 项"算，"180 天"不算（时间维度是另一个量纲）。
 */
export function anyUnitAnswerSentence(text, tokens = [], { unit = null } = {}) {
  if (!tokens.length) return null;
  const cls = unit ? (COUNT_UNIT_CLASS.get(unit) ?? "general") : null;
  const units = cls ? COUNT_UNITS.filter((u) => (COUNT_UNIT_CLASS.get(u) ?? "general") === cls) : COUNT_UNITS;
  const re = new RegExp(`(?:${NUMBER_CLASS})\\s*(?:${units.join("|")})`, "u");
  const found = splitSentences(text).find((s) => re.test(normalizeDashes(s)) && scoreTokens(tokens, s).enough);
  return found ?? null;
}
/**
 * 长度兜底：按**整行**（= 整条记忆）装，装不下就整行丢，绝不切断。
 * 单行自己就超预算 ⇒ 返回「（明确的无）」（宁可不给，也不给半句）。
 */
export function fitWholeLines(text, maxChars) {
  const lines = String(text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (!lines.length) return NONE;
  const cap = Math.max(0, Number(maxChars) || 0);
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + (kept.length ? 1 : 0);
    if (next > cap) continue;
    kept.push(line);
    used = next;
  }
  return kept.length ? kept.join("\n") : NONE;
}

/**
 * RANK-1：横线归一。同一个 commit 号/区间在不同记忆里可能写成 `R1-R11` / `R1–R11`（en dash）/
 * `R1—R11`（em dash）/ `−`（减号）。不归一的话"带连字符的问法"匹配不上"带破折号的事实"，
 * 一条本该命中的记忆会整条消失（实测：问「R1-R11 最后 commit」命不中 `R1–R11` 那条）。
 * 只影响**匹配**，不改注入出去的正文。
 */
export function normalizeDashes(text) {
  return String(text ?? "").replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, "-");
}

/** query → 词面 token：拉丁词 + 中文二元组（中文没有空格，二元组是最便宜也最稳的做法）。 */
// CJK-FILLER-1：自然问句里只起语法作用、从不在记忆正文里当实词用的 2 字片段。
// 只用于**降低噪音 token**（把"我对什么过敏"收成"过敏"），不参与任何门槛计算。
const CJK_FILLER_BIGRAMS = new Set([
  "什么", "怎么", "为什", "哪些", "哪个", "哪个", "多少", "是不", "可以", "能否", "是否",
  "我对", "我的", "我们", "你说", "你看", "你是", "你觉", "记得", "还记", "不记",
  "上次", "上回", "那个", "这个", "一下", "告诉", "请问", "来着", "说过", "提过",
  "对吧", "是吧", "好么", "怎样", "如何", "在哪", "是谁", "干嘛", "干什",
]);

export function queryTokens(query) {
  const raw = normalizeDashes(String(query ?? "")).toLowerCase();
  const tokens = new Set();
  for (const word of raw.match(/[a-z0-9][a-z0-9._-]{1,}/gu) ?? []) tokens.add(word);
  const cjk = raw.replace(/[^\u4e00-\u9fa5]+/gu, " ");
  for (const run of cjk.split(/\s+/u)) {
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  // SHORT-Q-1：`8层` 这种恰好两个字符的混合问句不会被上面的拉丁词/CJK 段各自切出 token。
  // 只补这一个严格的两字符形态；更长问句的切词集合保持不变。
  const compact = raw.trim();
  if ([...compact].length === 2 && /^[a-z0-9\u4e00-\u9fa5]{2}$/u.test(compact)) tokens.add(compact);
  return [...tokens];
}

/**
 * 相关度：命中 token 的加权和（token 越长权重越高）。
 * `enough` 是"够不够格进简报"的门槛——范围单禁止为了看起来命中而返噪，所以：
 *   短问句（token ≤2 且最长 token ≤2 字）命中 ≥1；其余仍须命中 ≥2 或一个 ≥4 字 token。
 */
export function scoreTokens(tokens, haystack, { shortQuery = tokens.length > 0 && tokens.length <= 2 && tokens.reduce((max, token) => Math.max(max, [...String(token ?? "")].length), 0) <= 2 } = {}) {
  const text = normalizeDashes(String(haystack ?? "")).toLowerCase();
  let weight = 0;
  let hits = 0;
  let longest = 0;
  const longestQueryToken = tokens.reduce((max, token) => Math.max(max, [...String(token ?? "")].length), 0);
  const isShortQuery = shortQuery && tokens.length > 0 && tokens.length <= 2 && longestQueryToken <= 2;
  for (const token of tokens) {
    if (token && text.includes(token)) {
      hits += 1;
      weight += token.length;
      longest = Math.max(longest, token.length);
    }
  }
  return { weight, hits, enough: isShortQuery ? hits >= 1 : hits >= 2 || longest >= 4 };
}

// 有界：总长 ≤ limit；每块至少保留一段（截断到句末），绝不丢弃板块。
function boundBrief(sections, limit) {
  const keys = Object.keys(sections);
  const overhead = keys.map((k) => `## ${k}\n\n`.length).reduce((a, b) => a + b, 0);
  let budget = limit - overhead;
  if (budget <= 0) budget = limit;
  const lengths = keys.map((k) => Math.max(1, String(sections[k] ?? "").length));
  const total = lengths.reduce((a, b) => a + b, 0);
  const quotas = lengths.map((l) => Math.max(60, Math.floor((l / total) * budget)));
  // 若配额和超出预算，按比例回缩（仍保证每块 ≥60）
  let sum = quotas.reduce((a, b) => a + b, 0);
  if (sum > budget) {
    const scale = budget / sum;
    for (let i = 0; i < quotas.length; i += 1) quotas[i] = Math.max(60, Math.floor(quotas[i] * scale));
  }
  const out = [];
  for (let i = 0; i < keys.length; i += 1) {
    const content = truncateAtSentence(String(sections[keys[i]] ?? NONE), quotas[i]);
    out.push(`## ${keys[i]}\n\n${content}`);
  }
  return out.join("\n\n");
}

function truncateAtSentence(text, maxChars) {
  const t = String(text ?? "");
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const bounds = [slice.lastIndexOf("。"), slice.lastIndexOf("；"), slice.lastIndexOf("\n"), slice.lastIndexOf("！")];
  const cut = Math.max(...bounds);
  return cut > 0 ? t.slice(0, cut + 1).trim() : slice;
}


