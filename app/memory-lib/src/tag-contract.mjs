// 保留前缀 tag 的格式契约（place:/speaker:/speaker_id:/audience:）。
// 只校验这几个前缀，其它 tag 原样放行——避免把历史自由标签一刀切拒掉。
const RESERVED = ["place:", "speaker:", "speaker_id:", "audience:"];

export function reservedTagViolation(tag) {
  const value = String(tag ?? "").trim();
  const prefix = RESERVED.find((p) => value.startsWith(p));
  if (!prefix) return null;
  if (value.length > 120) return { tag: value, reason: "TOO_LONG" };
  if (/\s/u.test(value)) return { tag: value, reason: "CONTAINS_SPACE" };
  if (value !== value.toLowerCase() && !prefix.startsWith("speaker:")) return { tag: value, reason: "NOT_LOWERCASE" };
  if (prefix === "place:" && !/^place:(group|channel|dm):[a-z0-9_-]+$/u.test(value)) return { tag: value, reason: "PLACE_FORMAT" };
  if (prefix === "audience:" && !/^audience:(group|c2c|private|public)$/u.test(value)) return { tag: value, reason: "AUDIENCE_FORMAT" };
  if (prefix === "speaker_id:" && !/^speaker_id:[a-z0-9_.:-]+$/u.test(value)) return { tag: value, reason: "SPEAKER_ID_FORMAT" };
  return null;
}

export function invalidReservedTags(tags = []) {
  const out = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    const violation = reservedTagViolation(tag);
    if (violation) out.push(violation);
  }
  return out;
}
