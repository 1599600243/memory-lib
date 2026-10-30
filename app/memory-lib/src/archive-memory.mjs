import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles, readTextFile, parseFrontmatter } from "./read-only-core.mjs";
import { readTimestamp } from "./time-util.mjs";
import { unquote } from "./frontmatter-util.mjs";
import { renameWithRetry } from "./atomic-write.mjs";

const DAY_MS = 86400_000;

export function createMemoryArchiver({ dataRoot, countFor = async () => 0, audit = null, now = () => Date.now(), recallCountsPath = path.join(dataRoot ?? "", "runtime", "recall-counts.json") } = {}) {
  if (!dataRoot) throw new Error("memory archiver requires dataRoot");

  async function archive({ olderThanDays = 90, maxRecallCount = 2, requireRecallCounts = true } = {}) {
    const cutoff = now() - Math.max(1, Number(olderThanDays) || 90) * DAY_MS;
    if (requireRecallCounts) {
      let parsed;
      try { parsed = JSON.parse(await fs.readFile(recallCountsPath, "utf8")); } catch { throw new Error(`recall counts are unavailable; run recall-stats --update before archive (${recallCountsPath})`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("recall counts are invalid; archive is disabled");
    }
    const items = [];
    let active = 0;
    let eligible = 0;
    const roots = ["curated", "project-state", "tools-memory", "plans", "profile", "inbox"].map((root) => path.join(dataRoot, root));
    for (const root of roots) for (const filePath of await walkFiles(root)) {
      const normalized = filePath.replaceAll("\\", "/");
      if (normalized.includes("/_legacy-") || !filePath.endsWith(".md")) continue;
      const text = await readTextFile(filePath);
      if (!text) continue;
      const { frontmatter } = parseFrontmatter(text);
      const status = String(frontmatter.status ?? "active").replace(/["']/gu, "").toLowerCase();
      const reviewState = String(frontmatter.reviewState ?? "").replace(/["']/gu, "").toLowerCase();
      const quality = Number(frontmatter.quality_score ?? 1);
      const inboxNoise = normalized.includes("/inbox/") && (reviewState === "rejected" || (quality < 0.5 && reviewState === "pending"));
      if (status !== "active" && !inboxNoise) continue;
      active += 1;
      const updatedAt = (await readTimestamp(frontmatter, filePath)).value;
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) continue;
      eligible += 1;
      const recallCount = Number(await countFor(filePath)) || 0;
      if (!inboxNoise && recallCount > maxRecallCount) continue;
      const legacyDir = path.join(path.dirname(filePath), `_legacy-${new Date(now()).toISOString().slice(0, 10)}`);
      const target = path.join(legacyDir, path.basename(filePath));
      await fs.mkdir(legacyDir, { recursive: true });
      // ATOMICWRITE-1：这是**移动已存在的文件**（不是"写 tmp 再 rename"），
      // 所以走 renameWithRetry —— 同样能跨过瞬时的 EPERM/EACCES/EBUSY。
      await renameWithRetry(filePath, target);
      const event = { id: unquote(frontmatter.id) || path.basename(filePath, ".md"), from: filePath, to: target, reason: "updated_at older than retention and low recall", updatedAt: new Date(updatedAt).toISOString(), recallCount };
      if (audit?.record) await audit.record({ channel: "memory-archive", action: "archive", resourceId: event.id, allow: true, rule: event.reason, recallCount });
      items.push(event);
    }
    return { archived: items.length, items, active, eligible, eligibilityRate: active ? Number((eligible / active).toFixed(4)) : 0 };
  }

  return { archive };
}
