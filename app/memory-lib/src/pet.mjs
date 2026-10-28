// memory-lib — pet command service (server-side pet-runtime).
// Clients only send commands and a semantic mode. Retrieval, persona assembly,
// writes, and model calls remain behind the memory-lib protocol.
import { fetchUrl, webSearch } from "./research.mjs";
import { normalizePetMode } from "./pet-mode.mjs";

export const MODE_PROMPTS = Object.freeze({
  companion: "你是陪伴模式的记忆伙伴：温和、简洁、诚实，关注用户感受。只引用服务端授权检索到的记忆；没有依据就明确说不知道，不要编造。",
  assistant: "你是普通模式的记忆助手：清晰、务实、主动但不越权。需要长期记忆时提示用户使用记住命令。",
  steward: "你是管家模式：条理、审慎，用报告和清单说明巡检结果与待确认事项。管家只做记忆候选、任务和低风险提议，不改学习层。",
  learner: "你是学习模式的私教：耐心、准确，帮助理解、测验和间隔复习；学习数据只写入 learning 层。",
  governance: "你是治理模式：克制、逐项确认、说明依据并保留审计。没有明确授权时只展示候选，不执行治理写入。",
  // Server-only compatibility aliases. New clients use semantic values above.
  chat: "你是陪伴模式的记忆伙伴：温和、简洁、诚实，关注用户感受。只引用服务端授权检索到的记忆；没有依据就明确说不知道，不要编造。",
  solve: "你是普通模式的记忆助手：清晰、务实、一步步解决问题，但不越权。",
  quiz: "你是学习模式的私教：针对主题出有区分度的小测验，并给出答案与解析。",
  research: "你是研究助手：先基于服务端授权记忆梳理观点；联网结果只读展示，并明确指出可能过时或不一致之处。",
  visualize: "你是学习模式的路径顾问：建议如何把主题组织成结构化学习地图。",
});

export function createPetApi({ llm, learning, webConfig, personaStore } = {}) {
  if (!llm || typeof llm.chat !== "function") throw new Error("pet requires an llm client");
  if (!learning) throw new Error("pet requires a learning api");

  async function handleCommand({ input, mode = "companion", search, history, signal, roleId, principal, onRemember, onDraft, onPersona }) {
    const text = String(input ?? "").trim();
    if (!text) return { reply: "说点什么吧。" };
    const semanticMode = normalizePetMode(mode).mode ?? "companion";

    const remember = detectRememberIntent(text);
    if (remember) {
      if (typeof onRemember !== "function") return { reply: "要把这句话记入候选，请切换到普通模式；我不会在陪伴模式直接写正式记忆。", operation: "remember_denied" };
      const result = await onRemember({ ...remember, raw: text, roleId: roleId ?? semanticMode, principal });
      return { reply: result?.reply ?? rememberReply(result), operation: "remember", candidate: result };
    }

    const draft = parseDraftCommand(text);
    if (draft) {
      if (typeof onDraft !== "function") return { reply: "草稿区当前不可用。", operation: "draft_denied" };
      const result = draft.action === "clear" || draft.action === "list"
        ? await onDraft(draft)
        : await onDraft({ ...draft, roleId: roleId ?? semanticMode, principal });
      return { reply: result?.reply ?? draftReply(result, draft), operation: "draft", draft: result };
    }

    const persona = detectPersonaInstruction(text);
    if (persona) {
      if (typeof onPersona !== "function") return { reply: "我识别到了表达偏好，但当前角色没有可用的 Persona 写入通道。", operation: "persona_denied" };
      const result = await onPersona({ ...persona, raw: text, roleId: roleId ?? semanticMode, principal });
      return { reply: result?.reply ?? `好的，之后我会${persona.preference}。`, operation: "persona", persona: result };
    }

    if (text.startsWith("/")) return handleSlash(text, { search, mode: semanticMode, principal });
    return handleChat(text, semanticMode, search, history, roleId, signal, principal);
  }

  async function handleChat(text, mode, search, history, roleId, signal, principal = null) {
    const { context, contextHits } = await getMemoryContext(search, text);
    const persona = await loadPersona(mode, principal?.role_id ?? roleId);
    const messages = buildMessages({ mode, persona, context, history, text });
    const reply = await llm.chat(messages, { signal });
    return { reply, context_hits: contextHits, mode, persona: persona.role_id ?? mode };
  }

  async function handleSlash(text, { search, mode, principal }) {
    const parts = text.slice(1).split(/\s+/u);
    const cmd = parts[0] ?? "";
    const arg = parts.slice(1).join(" ").trim();
    switch (cmd) {
      case "help":
        return { reply: "可用命令：\n/remember <内容> — 创建记忆候选（普通模式）\n/draft <内容> — 写入七天草稿区\n/draft:list — 查看草稿\n/draft:clear — 清理草稿\n/learn:topic <主题> — 创建/查看学习地图\n/learn:status <主题> — 学习进度\n/learn:review <主题> — 到期复习\n/learn:quiz <主题> — 生成测验\n/learn:explain <主题> <概念> — 概念解释\n/learn:practice <主题> — 实践建议\n/research <主题> — 联网研究并纠偏（按服务端场景授权）\n/fetch <url> — 抓取网页并总结核验\n直接输入文字可与我对话。" };
      case "learn:topic": return learnTopic(arg, search, principal);
      case "learn:status": return learnStatus(arg, principal);
      case "learn:review": return learnReview(arg, principal);
      case "learn:quiz": return learnQuiz(arg, principal);
      case "learn:explain": return learnExplain(arg, search);
      case "learn:practice": return learnPractice(arg, search);
      case "research": return research(arg, search, mode);
      case "fetch": return fetchCmd(arg);
      default: return { reply: `未知命令：/${cmd}（输入 /help 查看可用命令）` };
    }
  }

  async function loadPersona(mode, roleId) {
    // VISIBILITY-FIX-1-REJECT4（产品裁决 2026-10-17）：
    //   身份 = 服务端从凭据解析出的 role_id，是**权限与归属的权威**；
    //   `mode` = 同一身份之下的**内容维度/标签**，不参与"读谁的 persona"。
    //   ⇒ 权威键是 (role_id, mode)：先按身份取，取不到才回退到**同身份的**内置缺省
    //     （缺省里绝不含任何其它身份的数据）。调用方**必须**给出 roleId；
    //     未给时按"无身份"处理（用语义模式名作键 = 修前的错口径，这里显式拒绝）。
    const personaRole = String(roleId ?? "").trim();
    if (!personaRole) throw Object.assign(new Error("pet persona requires an authenticated role_id; refusing to use a mode or a default persona"), { code: "MISSING_PRINCIPAL", status: 403 });
    if (!personaStore || typeof personaStore.loadPersona !== "function") return { role_id: personaRole, name: personaRole, tone: "简洁、诚实" };
    return personaStore.loadPersona(personaRole);
  }

  async function getMemoryContext(search, text) {
    if (!search) return { context: "", contextHits: 0 };
    const hits = await searchMemoryContext(search, text);
    return { context: hits.map((h) => `[${h.sourceType}] ${String(h.excerpt ?? "").slice(0, 200)}`).join("\n"), contextHits: hits.length };
  }

  async function research(topic, search, mode) {
    if (!topic) return { reply: "用法：/research <主题>" };
    const memory = search ? await collectContext(search, topic) : "";
    const web = await webSearch(webConfig, topic);
    const webBlock = web.length ? web.map((r) => `- ${r.title}（${r.url}）\n  ${String(r.snippet ?? "").slice(0, 200)}`).join("\n") : "(未配置联网搜索源，仅基于记忆)";
    const reply = await llm.chat([
      { role: "system", content: MODE_PROMPTS.research },
      { role: "system", content: `当前语义模式：${mode}\n记忆上下文：\n${memory || "(无匹配记忆)"}\n\n联网结果：\n${webBlock}\n\n请基于以上内容回答，并明确指出记忆可能过时或与联网信息不一致的地方。` },
      { role: "user", content: topic },
    ]);
    return { reply, memory_hits: memory ? 1 : 0, web_sources: web.length };
  }

  async function fetchCmd(url) {
    if (!url || !/^https?:\/\//i.test(url)) return { reply: "用法：/fetch <https://...>" };
    const result = await fetchUrl(url);
    if (!result.ok) return { reply: `抓取失败：${result.status ? `HTTP ${result.status}` : result.error}` };
    const summary = await llm.chat([{ role: "system", content: "你是信息核验助手：用 3-5 句话总结这个网页的核心信息，并标注事实性要点。" }, { role: "user", content: `网页内容：\n${result.text.slice(0, 4000)}` }]);
    return { reply: `已抓取 ${url}（${result.text.length} 字符）：\n${summary}`, fetched: true };
  }

  async function learnTopic(topic, search, principal = null) {
    if (!topic) return { reply: "用法：/learn:topic <主题名>" };
    const existing = await learning.getPlan(topic, principal);
    if (existing) return { reply: `主题「${topic}」已有学习地图（${existing.map.modules.length} 个模块）。输入 /learn:status ${topic} 查看进度，或 /learn:review ${topic} 复习。` };
    const context = search ? await collectContext(search, topic) : "";
    const draft = await llm.chat([{ role: "system", content: "你是学习计划设计师。根据主题设计 3-6 个学习模块，只输出一个 JSON 对象，格式：{\"modules\":[{\"id\":\"m1\",\"title\":\"模块名\",\"weight\":1,\"difficulty\":\"low|medium|high\",\"dependencies\":[]}]}}" }, { role: "system", content: context ? `相关记忆：\n${context}` : "" }, { role: "user", content: topic }]);
    let modules;
    try { modules = JSON.parse(extractJson(draft)).modules; } catch { modules = [{ id: "m1", title: topic, weight: 1, difficulty: "medium", dependencies: [] }]; }
    const plan = await learning.putPlan(topic, { modules });
    return { reply: `已为「${topic}」创建学习地图（${modules.length} 个模块）。输入 /learn:status ${topic} 查看，或 /learn:explain ${topic} <概念> 开始学习。`, plan };
  }

  async function learnStatus(topic, principal = null) {
    if (!topic) return { reply: "用法：/learn:status <主题名>" };
    const plan = await learning.getPlan(topic, principal);
    if (!plan) return { reply: `主题「${topic}」还没有学习地图，先用 /learn:topic ${topic} 创建。` };
    const progress = await learning.getProgress(topic, principal);
    const modules = plan.map.modules;
    const rows = modules.map((m) => { const p = progress?.modules?.[m.id]; const status = p?.status ?? "not_started"; const mastery = Math.round((p?.mastery ?? 0) * 100); return `  ${m.id} ${m.title} [${status}] 掌握度 ${mastery}%`; }).join("\n");
    const done = modules.filter((m) => (progress?.modules?.[m.id]?.mastery ?? 0) >= 1).length;
    return { reply: `「${topic}」进度：${done}/${modules.length} 完成\n${rows}` };
  }

  async function learnReview(topic, principal = null) {
    if (!topic) return { reply: "用法：/learn:review <主题名>" };
    const review = await learning.getReview(topic, principal);
    if (!review.due.length) return { reply: `「${topic}」当前没有到期的复习项（间隔重复：答对后 1/7/16/35 天复习）。` };
    const items = review.due.map((d) => `  ${d.module_id}（第 ${d.round} 轮，到期 ${d.next_due.slice(0, 10)}）`).join("\n");
    return { reply: `「${topic}」有 ${review.due.length} 项待复习：\n${items}`, due: review.due };
  }

  async function learnQuiz(topic, principal = null) {
    if (!topic) return { reply: "用法：/learn:quiz <主题名>" };
    const plan = await learning.getPlan(topic, principal);
    if (!plan) return { reply: `主题「${topic}」还没有学习地图。` };
    const titles = plan.map.modules.map((m) => m.title).join("、");
    const quiz = await llm.chat([{ role: "system", content: "你是出题老师。根据模块清单出 3 道选择题，只输出 JSON：{\"questions\":[{\"q\":\"题目\",\"options\":[\"A. ..\",\"B. ..\"],\"answer\":\"A\",\"explain\":\"解析\"}]}" }, { role: "user", content: `模块：${titles}` }]);
    return { reply: `「${topic}」小测验：\n${quiz}`, raw_quiz: quiz };
  }

  async function learnExplain(topic, concept, search) {
    if (!topic || !concept) return { reply: "用法：/learn:explain <主题> <概念>" };
    const context = search ? await collectContext(search, `${topic} ${concept}`) : "";
    const explain = await llm.chat([{ role: "system", content: "你是耐心、准确的私人教师：先给一句话定义，再用类比解释，最后给一个例子。" }, { role: "system", content: context ? `相关记忆：\n${context}` : "" }, { role: "user", content: `在主题「${topic}」中解释概念：${concept}` }]);
    return { reply: explain };
  }

  async function learnPractice(topic, search) {
    if (!topic) return { reply: "用法：/learn:practice <主题名>" };
    const hits = search ? await search({ query: topic, limit: 5 }).catch(() => []) : [];
    const sources = hits.length ? hits.map((h) => `  - ${String(h.path ?? "").split(/[\\/]/).pop()}`).join("\n") : "  (暂无相关记忆)";
    return { reply: `「${topic}」实践建议：\n1. 从学习地图第一个模块开始，先理解概念再做练习。\n2. 相关记忆材料：\n${sources}\n3. 完成模块后用 /learn:quiz ${topic} 自测，用 /learn:review ${topic} 按间隔复习。`, material_hits: hits.length };
  }

  async function collectContext(search, query) {
    const hits = await search({ query, limit: 4 }).catch(() => []);
    return hits.map((h) => `[${h.sourceType}] ${String(h.excerpt ?? "").slice(0, 200)}`).join("\n");
  }

  async function* handleCommandStream(args) {
    const { input, mode = "companion", search, history, signal, roleId, principal, onRemember, onDraft, onPersona } = args;
    const text = String(input ?? "").trim();
    if (!text || text.startsWith("/") || detectRememberIntent(text) || detectPersonaInstruction(text) || typeof llm.chatStream !== "function") {
      const result = await handleCommand({ input: text, mode, search, history, signal, roleId, principal, onRemember, onDraft, onPersona });
      yield { text: String(result.reply ?? ""), context_hits: result.context_hits ?? result.memory_hits ?? 0, done: true, result };
      return;
    }
    const semanticMode = normalizePetMode(mode).mode ?? "companion";
    const { context, contextHits } = await getMemoryContext(search, text);
    const persona = await loadPersona(semanticMode, principal?.role_id ?? roleId);
    const messages = buildMessages({ mode: semanticMode, persona, context, history, text });
    for await (const delta of llm.chatStream(messages, { signal })) yield { text: delta, context_hits: contextHits, done: false };
    yield { text: "", context_hits: contextHits, done: true };
  }

  function buildMessages({ mode, persona, context, history, text }) {
    const personaText = [`Persona角色：${persona?.role_id ?? mode}`, `Persona名称：${persona?.name ?? mode}`, `表达方式：${persona?.tone ?? "简洁、诚实"}`, persona?.background ? `背景：${persona.background}` : "", Array.isArray(persona?.memoryRules) && persona.memoryRules.length ? `记忆规则：${persona.memoryRules.join("；")}` : ""].filter(Boolean).join("\n");
    const messages = [{ role: "system", content: MODE_PROMPTS[mode] ?? MODE_PROMPTS.companion }, { role: "system", content: personaText }, { role: "system", content: `记忆上下文：\n${context || "(无匹配记忆)"}` }];
    const hist = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of hist) if (h?.role === "user" || h?.role === "assistant") messages.push({ role: h.role, content: String(h.content ?? "") });
    messages.push({ role: "user", content: text });
    return messages;
  }

  return { handleCommand, handleCommandStream };
}

export function detectRememberIntent(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  let content = "";
  let explicit = false;
  if (/^\/remember(?:\s+|$)/iu.test(text)) { explicit = true; content = text.replace(/^\/remember\s*/iu, "").trim(); }
  else {
    const match = text.match(/^(?:请|请你|帮我)?\s*(?:记住|记下|别忘了|不要忘记|帮我记住)\s*(?:这个|这件事|一下)?\s*[:：,，]?\s*(.+)$/iu);
    if (match) { explicit = true; content = match[1].trim(); }
    else if (/(?:我喜欢|我偏好|我的(?:名字|姓名|生日|身份|称呼)|以后(?:请|要)|下次(?:请|要)|对我来说很重要)/u.test(text) && text.length <= 320) content = text;
  }
  if (!content) return explicit ? { content: "", explicit, importance: "ordinary" } : null;
  const importance = /--critical\b|\bcritical\b|重要|必须|身份|名字|姓名|生日|电话|邮箱|住址|我喜欢|我偏好|以后(?:请|要)/iu.test(content) ? "critical" : "ordinary";
  content = content.replace(/^--critical\s*/iu, "").trim();
  if (!content) return null;
  return { content: content.slice(0, 4000), explicit, importance, confidence: explicit ? "high" : "medium" };
}

export function detectPersonaInstruction(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (/^\/persona(?:\s+|$)/iu.test(text)) { const preference = text.replace(/^\/persona\s*/iu, "").trim(); return preference ? { preference: preference.slice(0, 1000), explicit: true } : null; }
  if (/(?:以后|今后|从现在起|请你).*(?:说话|回答|回复|表达|语气|自称|称呼|叫我|简短|详细|中文|英文|不要用|用词)/u.test(text) && text.length <= 300) return { preference: text.slice(0, 1000), explicit: false };
  return null;
}

function parseDraftCommand(text) {
  if (/^\/draft:clear(?:\s+all)?$/iu.test(text)) return { action: "clear", all: /\sall$/iu.test(text) };
  if (/^\/draft:list$/iu.test(text)) return { action: "list" };
  if (/^\/draft(?:\s+|$)/iu.test(text)) { const content = text.replace(/^\/draft\s*/iu, "").trim(); return content ? { action: "put", content: content.slice(0, 4000), kind: "conversation" } : { action: "list" }; }
  return null;
}

function rememberReply(result) {
  if (!result) return "已收到，但记忆候选写入失败。";
  if (result.autoReviewed) return `已记入候选（${result.id}），这是日常事项，管家已完成初审；仍需用户在治理入口确认后才会进入正式记忆。`;
  return `已记入候选（${result.id}），这条内容涉及重要信息或偏好，留给你人工审核；尚未写入正式记忆。`;
}
function draftReply(result, draft) {
  if (draft.action === "list") return `草稿区共有 ${result?.count ?? result?.drafts?.length ?? 0} 条未过期草稿。`;
  if (draft.action === "clear") return `已清理 ${result?.count ?? 0} 条草稿。`;
  return `已保存到草稿区（${result?.id ?? "draft"}），7 天未升级会自动清理。`;
}

async function searchMemoryContext(search, text) {
  const queries = [text];
  if (/(最近|当前|目前|近来).*(研究|进展|项目|在做)|研究什么|在研究什么/.test(text)) queries.push("最近研究进展", "当前项目进展", "最近在做什么");
  const seen = new Set(); const out = [];
  for (const query of queries) {
    const hits = await search({ query, limit: 5 }).catch(() => []);
    for (const hit of hits) { const key = `${hit?.path ?? ""}\n${hit?.excerpt ?? ""}`; if (seen.has(key)) continue; seen.add(key); out.push(hit); if (out.length >= 8) return out; }
  }
  return out;
}

function extractJson(text) { const m = String(text).match(/\{[\s\S]*\}/); return m ? m[0] : text; }
function buildMessagesForTest() { return []; }
