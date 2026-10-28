// SCENARIO-1 —— 参考接入实现：把「用户原话」接到平台上（**零模型**）。
//
// 它回答的是产品第一判据那句场景：
//   「过了几天我随口问『10/10 我们聊了什么』，你要告诉我具体聊了什么」
//
// 平台侧零件已经齐全（都是纯规则、零模型）：
//   /v1/date/resolve  人话 → 绝对范围
//   /v1/search        范围 → 取全那一天（半开区间 + keyset 翻页）
//
// 本模块**只做搬运与核对**，三件必须做对的事：
//   ① **先 resolve 再检索**。拿原话去关键词检索正是"当天 0 条"的病根。
//   ② **失败与歧义如实处理**：认不出时间表达就明说"这句话里没有时间范围"；
//      有歧义就把候选列出来请用户确认 —— **不许替用户猜、不许合并两天**。
//   ③ **取全**：翻页到 nextCursor 为 null，并核对条数 == total_count；
//      对不上就**如实说没取全**，不许把"少给了"说成"那天就这些"。
//
// 它**不调用任何模型**：输出素材里只有"库里已有的"时间 + excerpt，
// 最终措辞由外部接入方/模型自己做（平台只负责把素材备齐）。

/**
 * 把「一天的全部条目」切成接入方可直接喂的批次（**只切分，不摘要、不改写、不生成**）。
 *
 * 切块依据（写死并测住）：**按累计字符数**贪心装填，预算由调用方显式给出。
 * 为什么用字符数而不是"按会话分组"：条目级枚举结果里**没有**可靠的会话归组字段
 * （`conversationId` 只出现在 `/v1/get` 的 frontmatter 上，按会话分组会变成 N 次额外往返），
 * 而"塞不塞得进上下文"最直接的量纲就是字符数。会话归组留给接入方在拿到块之后做。
 *
 * 三条不许破的规矩：
 *   ① **不许丢条目**：所有块的条目并集 == 输入集合（顺序一致、不重复）；
 *   ② **单条超预算不许截断**：单独成块并标 `oversized: true`，让接入方自己决定；
 *   ③ **空输入不产生空块**（`[]` 就是 `[]`）。
 *
 * @param {Array<object>} items 取全后的条目（需带 id/capturedAt/excerpt）
 * @param {object} [options]
 * @param {number} [options.maxCharsPerChunk] 每块字符预算（默认 8000，约合中文 4000 字）
 */
export function chunkItems(items, { maxCharsPerChunk = 8_000 } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const budget = Number.isFinite(maxCharsPerChunk) && maxCharsPerChunk > 0 ? Math.floor(maxCharsPerChunk) : 8_000;

  // 内部状态：{ entries, chars, oversized }
  const groups = [];
  let current = null;
  const closeCurrent = () => { if (current) { groups.push(current); current = null; } };

  for (const entry of list) {
    const size = charsOf(entry);
    if (size > budget) {
      // 单条就超预算：**单独成块并标注**，绝不截断（截断会静默改变素材）。
      closeCurrent();
      groups.push({ entries: [entry], chars: size, oversized: true });
      continue;
    }
    if (current && current.chars + size > budget) closeCurrent();
    if (!current) current = { entries: [], chars: 0, oversized: false };
    current.entries.push(entry);
    current.chars += size;
  }
  closeCurrent();

  // 收尾：结算每块的统计字段；正常块**不带** oversized 键（只有超限块才带）。
  return groups.map((group) => ({
    items: group.entries,
    count: group.entries.length,
    chars: group.chars,
    since: group.entries[0].capturedAt ?? null,
    until: group.entries.at(-1).capturedAt ?? null,
    ...(group.oversized ? { oversized: true } : {}),
  }));
}

function charsOf(entry) {
  return typeof entry?.excerpt === "string" ? entry.excerpt.length : 0;
}

/**
 * @param {object} input
 * @param {string} input.text        用户原话（如「10/10 我们聊了什么」）
 * @param {string} input.now         ISO 瞬时（**调用方给**，平台不猜"现在"）
 * @param {string} input.timezone    IANA 时区名
 * @param {string} input.baseUrl     平台地址，如 http://127.0.0.1:8787
 * @param {object} [input.credentials] { credential_ref, secret } 或 { bearer }
 * @param {string} [input.locale]    如 zh-CN；显式 null = locale 未知
 * @param {number} [input.pageSize]  每页条数（只影响翻页次数，不影响"取全"）
 * @param {number} [input.maxPages]  安全上界，防止服务端游标异常导致死循环
 * @param {Function} [input.fetchImpl] 注入点（测试用）
 */
export async function recallScenario({
  text,
  now,
  timezone,
  baseUrl,
  credentials = {},
  locale,
  // 默认按服务端上限取（100）。服务端 limit 上限就是 100，翻页本身不改变"取全"，
  // 只影响往返次数 —— 实测：101 条在 pageSize=3 下要 34 次串行往返（一次约 100ms ⇒ 3 秒以上），
  // 在 100 下只要 2 次。接入方若要在"取全"与"延迟"之间取舍，**这里就是取舍点**；
  // 但**不许**因为延迟而少取（那要靠 total_count 核对出来，见下面的完整性问题）。
  pageSize = 100,
  /** 每块的字符预算（分批素材用）。默认 8000 ≈ 中文 4000 字，一个"能塞进上下文"的增量。 */
  chunkChars = 8_000,
  maxPages = 200,
  principal = null,
  onRequest = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const problems = [];
  const envelope = () => ({
    ...(credentials.credential_ref ? { credential_ref: credentials.credential_ref, secret: credentials.secret } : {}),
    ...(principal ? { principal } : {}),
  });
  const headers = () => ({
    "content-type": "application/json",
    ...(credentials.bearer ? { authorization: `Bearer ${credentials.bearer}` } : {}),
  });
  const post = async (route, body) => {
    const response = await fetchImpl(`${baseUrl}${route}`, { method: "POST", headers: headers(), body: JSON.stringify({ ...envelope(), ...body }) });
    const payload = await response.json().catch(() => ({}));
    // 可选诊断回调：把**原始**状态码与响应体交出去。排查时不要靠猜。
    if (typeof onRequest === "function") onRequest({ route, status: response.status, payload });
    return { status: response.status, payload };
  };

  const base = { modelCalls: 0, problems };

  // ① 人话 → 范围
  const resolved = await post("/v1/date/resolve", {
    text,
    now,
    timezone,
    ...(locale === undefined ? {} : { locale }),
  });
  const resolution = resolved.payload ?? {};

  if (resolution.ok !== true) {
    // ② 失败与歧义：如实回报，**一次检索都不发**
    if (resolution.reason === "ambiguous") {
      const candidates = resolution.ambiguous?.candidates ?? resolution.error?.ambiguous?.candidates ?? [];
      return {
        ...base,
        ok: false,
        kind: "ambiguous",
        reason: "ambiguous",
        text,
        message: resolution.message ?? resolution.error?.message ?? "这句话里的时间有两种读法",
        candidates,
        notice: "这个时间表达有两种读法，请用户确认是哪一天（我没有替他选，也没有把两天并起来查）。",
      };
    }
    if (resolution.reason === "no-match" || resolution.error?.code === "NO_MATCH") {
      return {
        ...base,
        ok: false,
        kind: "no-time-range",
        reason: "no-match",
        text,
        message: resolution.message ?? resolution.error?.message ?? "unrecognised time expression",
        notice: "这句话里没有时间范围，所以没有检索任何内容（没有瞎猜一个日期）。",
      };
    }
    return {
      ...base,
      ok: false,
      kind: "error",
      reason: resolution.reason ?? resolution.error?.code ?? "unknown",
      text,
      message: resolution.message ?? resolution.error?.message ?? `date resolve failed with status ${resolved.status}`,
      notice: "时间没有解析成功，因此没有检索任何内容。",
    };
  }

  // ③ 范围 → 取全
  const range = {
    since: resolution.range?.since ?? resolution.resolvedRange?.since ?? null,
    untilExclusive: resolution.range?.untilExclusive ?? resolution.resolvedRange?.untilExclusive ?? null,
    calendarTimezone: resolution.timezone ?? timezone,
  };
  const query = {
    query: "",
    calendarTimezone: range.calendarTimezone,
    limit: pageSize,
    ...(resolution.calendarDate ? { calendarDate: resolution.calendarDate } : { since: range.since, until: resolution.resolvedRange?.until ?? range.untilExclusive }),
  };

  const items = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let totalCount = null;
  let duplicateDetected = false;

  do {
    const { payload } = await post("/v1/search", { ...query, ...(cursor ? { cursor } : {}) });
    pages += 1;
    const pageItems = payload?.results ?? [];
    if (Number.isInteger(payload?.total_count)) totalCount = payload.total_count;
    for (const entry of pageItems) {
      const key = entry.id ?? entry.path;
      if (seen.has(key)) { duplicateDetected = true; continue; }
      seen.add(key);
      items.push({ id: entry.id ?? null, path: entry.path ?? null, capturedAt: entry.capturedAt ?? entry.updatedAt ?? null, excerpt: entry.excerpt ?? "" });
    }
    cursor = payload?.nextCursor ?? null;
    if (pages >= maxPages) { problems.push(`paging stopped at maxPages=${maxPages}; the day may not be fully enumerated`); break; }
  } while (cursor);

  // ④ 取全核对：只有条数与总数对得上、且没有重复，才允许说"取全"
  const complete = !duplicateDetected && totalCount !== null && items.length === totalCount;
  if (duplicateDetected) problems.push("duplicate entry returned across pages (possible paging defect)");
  if (totalCount !== null && items.length !== totalCount) problems.push(`fetched ${items.length} of total_count ${totalCount} (incomplete)`);
  if (totalCount === null) problems.push("the service did not report total_count, so completeness cannot be asserted");

  const notice = items.length === 0
    ? "这个范围里，按我的可见范围**看不到**任何对话（不等于那段时间没有发生过事情）。"
    : null;

  // ④ 分批素材：**只切分**。`chunkChars` 给了才切 —— 默认也给，因为"一天可能上百条"
  // 是常态而不是例外（本机实测最大的一天 177 条 ≈ 7 万字符）。
  const chunks = chunkItems(items, { maxCharsPerChunk: chunkChars });
  const totalChars = items.reduce((sum, entry) => sum + (entry.excerpt?.length ?? 0), 0);

  return {
    ...base,
    ok: true,
    kind: "answer",
    text,
    calendarDate: resolution.calendarDate ?? null,
    yearInferred: Boolean(resolution.yearInferred),
    assumptions: resolution.assumptions ?? [],
    range,
    pages,
    count: items.length,
    totalCount,
    complete,
    totalChars,
    chunkChars,
    chunks,
    items,
    ...(notice ? { notice } : {}),
  };
}
