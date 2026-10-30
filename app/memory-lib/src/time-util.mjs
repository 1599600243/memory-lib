import fs from "node:fs/promises";

const FIELDS = ["updatedAt", "updated_at", "createdAt", "created_at", "occurred_at", "occurredAt", "eventAt", "event_at", "validFrom", "valid_from", "captured_at", "capturedAt"];

export function parseTimestamp(value) {
  const text = String(value ?? "").trim().replace(/^["']|["']$/gu, "");
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function timestampValue(frontmatter = {}, fallback = null) {
  for (const field of FIELDS) {
    const parsed = parseTimestamp(frontmatter?.[field]);
    if (Number.isFinite(parsed)) return { value: parsed, field };
  }
  const mtimeMs = typeof fallback === "number" ? fallback : fallback?.mtimeMs;
  if (Number.isFinite(mtimeMs)) return { value: mtimeMs, field: "mtime" };
  return { value: NaN, field: null };
}

// 事件时钟（REFINE-LOOP-2）：一条记录"讲的是**什么时候**的事"，与"这条记录什么时候被写/被改"
// 是**两条时间轴**，不能混用。
//   · capturedAt/occurred_at/valid_from 属事件轴：问"某一天聊了什么"该用它们；
//   · updated_at 属记录轴：随每次重写而变（提炼产物写入时就是提炼时刻）。
// FIELDS 里 updated_at 排在最前（排序/新鲜度要它），所以"按天分档"必须**显式**走这个函数，
// 否则提炼记忆会被分到提炼那天、把别的日子的事端上来（REFINE-LOOP-2 的实测缺陷）。
const EVENT_FIELDS = ["capturedAt", "captured_at", "occurred_at", "occurredAt", "eventAt", "event_at", "validFrom", "valid_from"];

export function eventClockValue(frontmatter = {}, fallback = null) {
  for (const field of EVENT_FIELDS) {
    const parsed = parseTimestamp(frontmatter?.[field]);
    if (Number.isFinite(parsed)) return { value: parsed, field };
  }
  return timestampValue(frontmatter, fallback);
}

export async function readTimestamp(frontmatter = {}, filePath = null) {
  const parsed = timestampValue(frontmatter);
  if (Number.isFinite(parsed.value)) return parsed;
  if (filePath) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat && Number.isFinite(stat.mtimeMs)) return { value: stat.mtimeMs, field: "mtime" };
  }
  return { value: NaN, field: null };
}

export const TIMESTAMP_FIELDS = FIELDS;
