// memory-lib — F6：离线中文摘要 sidecar 索引（只读、纯附加）。
//
// 背景：历史正式记忆多为英文，控制台看不懂。中文摘要是一份**离线产物**
// （形如 `{ results: [{ path, id, updatedAt, summaryZh, keyPoints[] }] }`），
// 不进记忆库 schema、不写 frontmatter、不改协议语义。
//
// 本模块只做三件事：
//   1. 把 sidecar 的条目按**规范化路径**建索引（不是 id —— id 可重名/可改）；
//   2. 安全加载：路径不存在 / JSON 损坏 / 形状不对 → 返回 null，静默英文回退，绝不抛错；
//   3. 纯附加：`attachZhSummary()` 只在命中时给已存在的响应对象**加** `summaryZh`
//      （有要点才加 `keyPoints`）；未命中时原样返回（连字段都不出现）。
//
// 任何消费者（REST / MCP / 控制台）拿到的都是同一份由 `createMemoryLib` 附加的结果，
// 因此不需要新增端点、不需要新协议字段、不需要兼容层。

import fs from "node:fs";
import path from "node:path";

// 明确关闭的写法（`--summary-index none` 之类），避免把 "none" 当文件名去 stat。
const DISABLED_SOURCES = new Set(["", "none", "off", "false", "0", "disabled"]);

// 已警告过的 (路径, 原因) 组合：sidecar 缺失时每个请求都读一次，
// 但只在第一次打印，避免刷日志（服务端也可用 onError: false 完全静默）。
const warned = new Set();

// 文件级缓存：absolutePath -> { mtimeMs, size, index }
const fileCache = new Map();

function defaultOnError(message) {
  console.error(`[memory-lib] zh summary sidecar: ${message}`);
}

// 规范化路径键：分隔符、盘符大小写、`.`/`..`、结尾分隔符都不敏感。
// Windows 语义（本服务部署在 Windows）：同一台机器上两条指向同一文件的路径必须同键。
// 说明：统一小写不做大小写敏感区分——两侧路径都来自同一宿主机的同一份文件树。
export function normalizeSummaryKey(filePath) {
  if (typeof filePath !== "string") return null;
  let value = filePath.trim();
  if (!value) return null;
  value = value.replace(/\\/g, "/");
  if (value.startsWith("//")) {
    // UNC：posix.normalize 会吃掉第二个斜杠，单独保留前缀
    value = `//${path.posix.normalize(value.slice(2))}`;
  } else if (value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) {
    value = path.posix.normalize(value);
  }
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value.toLowerCase();
}

function toSummaryEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const key = normalizeSummaryKey(entry.path);
  const summaryZh = typeof entry.summaryZh === "string" ? entry.summaryZh.trim() : "";
  if (!key || !summaryZh) return null;
  const keyPoints = Array.isArray(entry.keyPoints)
    ? entry.keyPoints.map((point) => (typeof point === "string" ? point.trim() : "")).filter(Boolean)
    : typeof entry.keyPoints === "string" && entry.keyPoints.trim()
      ? [entry.keyPoints.trim()]
      : [];
  return [key, { path: entry.path, summaryZh, keyPoints }];
}

// 接受多种来源形状：条目数组 / 容器对象（results|items|entries）/ Map / 以路径为键的普通对象。
function buildIndexFromEntries(entries, source) {
  const byKey = new Map();
  for (const entry of entries ?? []) {
    const parsed = toSummaryEntry(entry);
    if (parsed) byKey.set(parsed[0], parsed[1]);
  }
  return makeIndex(byKey, source);
}

function buildIndexFromSource(source) {
  if (Array.isArray(source)) return buildIndexFromEntries(source, "<array>");
  if (source instanceof Map) {
    const byKey = new Map();
    for (const [key, value] of source) {
      const parsed = toSummaryEntry({ ...(value && typeof value === "object" ? value : {}), path: value?.path ?? key });
      if (parsed) byKey.set(parsed[0], parsed[1]);
    }
    return makeIndex(byKey, "<map>");
  }
  const list = source.results ?? source.items ?? source.entries;
  if (Array.isArray(list)) return buildIndexFromEntries(list, "<object>");
  return null;
}

function makeIndex(byKey, source) {
  return {
    size: byKey.size,
    source,
    // 以原始绝对路径查询（内部自动规范化）；未命中返回 null
    get(filePath) {
      const key = normalizeSummaryKey(filePath);
      return key ? byKey.get(key) ?? null : null;
    },
    has(filePath) {
      const key = normalizeSummaryKey(filePath);
      return key ? byKey.has(key) : false;
    },
  };
}

function loadFromFile(absolutePath, onError) {
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    onError(`not found (English fallback): ${absolutePath}`);
    return null;
  }
  const cached = fileCache.get(absolutePath);
  // 按 mtime+size 复用：sidecar 重新生成后无需重启服务
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.index;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    onError(`unreadable JSON (English fallback): ${absolutePath}: ${error.message}`);
    return null;
  }
  const index = buildIndexFromSource(parsed);
  if (!index) {
    onError(`unexpected shape (English fallback; expect { results: [{ path, summaryZh }] }): ${absolutePath}`);
    return null;
  }
  fileCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, index });
  return index;
}

/**
 * 安全加载中文摘要索引。
 *
 * @param source sidecar 路径字符串 | 条目数组 | 容器对象 | Map | 已建好的索引 | null/false/'none'（= 关闭）
 * @param options.onError 出错回调；默认每个 (路径,原因) 只打印一次；传 false 完全静默
 * @returns 索引对象 { size, source, get(path), has(path) } 或 null（= 无摘要，英文回退）
 */
export function loadSummaryIndex(source, { onError } = {}) {
  if (source === null || source === undefined || source === false) return null;
  const report = onError === false ? () => {} : typeof onError === "function" ? onError : defaultOnError;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (DISABLED_SOURCES.has(trimmed.toLowerCase())) return null;
    const absolutePath = path.resolve(trimmed);
    const warnOnce = (message) => {
      const key = `${absolutePath}|${message}`;
      if (warned.has(key)) return;
      warned.add(key);
      report(message);
    };
    try {
      return loadFromFile(absolutePath, warnOnce);
    } catch (error) {
      warnOnce(`load failed (English fallback): ${absolutePath}: ${error.message}`);
      return null;
    }
  }
  try {
    if (typeof source.get === "function" && typeof source.size === "number") return source; // 已是索引
    return buildIndexFromSource(source);
  } catch (error) {
    report(`index build failed (English fallback): ${error.message}`);
    return null;
  }
}

// 纯附加：命中才加字段；`keyPoints` 仅在非空时出现；未命中/未注入索引时原样返回。
export function attachZhSummary(item, index) {
  if (!index || !item || typeof item !== "object" || Array.isArray(item)) return item;
  const summary = index.get(item.path);
  if (!summary) return item;
  const enriched = { ...item, summaryZh: summary.summaryZh };
  if (summary.keyPoints.length) enriched.keyPoints = [...summary.keyPoints];
  return enriched;
}

export function attachZhSummaries(items, index) {
  if (!index || !Array.isArray(items)) return items;
  return items.map((item) => attachZhSummary(item, index));
}
