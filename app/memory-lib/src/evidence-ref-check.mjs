// 证据引用存在性检查：外部通道写入必须引用**真实存在**的证据，不能是合成 id。
// 只做最小解析：conversation-id 查 evidence/conversations/<id>.md；带路径的查 dataRoot/<ref>；
// 其他形式（例如 being:self-time:...）一律视为不可核。
import fs from "node:fs/promises";
import path from "node:path";

export async function missingEvidenceRefs({ dataRoot, refs = [] } = {}) {
  const missing = [];
  for (const raw of refs) {
    const ref = String(raw ?? "").trim();
    if (!ref) { missing.push(ref); continue; }
    const candidates = [];
    if (/^conversation-[0-9a-f]{8,}$/u.test(ref)) candidates.push(path.join(dataRoot, "evidence", "conversations", `${ref}.md`));
    if (ref.includes("/")) candidates.push(path.join(dataRoot, ref));
    candidates.push(path.join(dataRoot, "evidence", "conversations", `${ref}.md`));
    candidates.push(path.join(dataRoot, "evidence", "documents", `${ref}.md`));
    let found = false;
    for (const candidate of candidates) {
      if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) { found = true; break; }
    }
    if (!found) missing.push(ref);
  }
  return missing;
}
