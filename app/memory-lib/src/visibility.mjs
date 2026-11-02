// visibility.mjs —— 记忆可见性的**唯一判定入口**
//
// 背景（2026-10-30）：读侧判定原本写在 memory-lib.mjs 里，写侧写在 write-authorization.mjs 里，
// 另有 9 处零散的 visibility 字符串比较。分散的后果已经出现过两次：
//   ① 控制台按身份筛记忆筛出空（调用方各自解释 scope）
//   ② 写回 403（写侧要求 user_id，读侧不要求）
//
// 本模块只做一件事：给定 principal + 文件 + frontmatter，回答"能不能看"。
// 语义与抽取前**完全一致**（差分测试 test/visibility-equivalence.test.mjs 保证）。

import { pathContainer, principalAllowsContainer } from "./container-policy.mjs";

/** 与 memory-lib.mjs 原实现逐字一致：去引号（frontmatter 里的值可能是 JSON 字符串） */
export function unquoteFrontmatter(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

/**
 * 读侧可见性判定（同步版）。
 * @param {object}   opts
 * @param {object}   opts.principal  { user_id, agent_id, role_id, group_id, framework_id }
 * @param {string}   opts.dataRoot   数据根（用于从路径推断 container）
 * @param {string}   opts.filePath   绝对路径
 * @param {object}   opts.frontmatter 已解析的 frontmatter（调用方负责读文件并解析）
 * @returns {boolean}
 */
export function canSeePath({ principal, dataRoot, filePath, frontmatter = null }) {
  if (!principal) return true; // 无 principal = 无限制实例（仅服务端内部使用）
  const fm = frontmatter ?? {};
  const container = pathContainer(dataRoot, filePath);
  if (!container) return false;

  // evidence 是特例：必须 group + user 同时匹配（原文层不参与普通检索，但按 id 取要判）
  if (container === "evidence") {
    const group = unquoteFrontmatter(fm.group_id ?? fm.groupId);
    const user = unquoteFrontmatter(fm.user_id ?? fm.userId);
    const principalGroup = principal.group_id;
    const principalUser = principal.user_id;
    return Boolean(
      group && user && group !== "unknown" && user !== "unknown" &&
      principalGroup && principalUser && group === principalGroup && user === principalUser
    );
  }

  const metadata = {
    ...fm,
    container,
    project: unquoteFrontmatter(fm.project),
    group_id: unquoteFrontmatter(fm.group_id),
    user_id: unquoteFrontmatter(fm.user_id),
    agent_id: unquoteFrontmatter(fm.agent_id),
    role_id: unquoteFrontmatter(fm.role_id),
    visibility: unquoteFrontmatter(fm.visibility) || (
      container === "project" ? "project"
        : container === "tool" || container === "knowledge" ? "platform"
          : container === "role" ? "role"
            : "private"
    ),
  };

  // 无任何身份标记的文件：按 container 给默认
  if (!metadata.group_id && !metadata.user_id && !metadata.agent_id && !metadata.role_id) {
    if (container === "role") {
      const parts = filePath.split(/[\\/]/);
      const curatedIdx = parts.lastIndexOf("curated");
      metadata.agent_id = curatedIdx >= 0 && parts[curatedIdx + 1] === "agents" ? parts[curatedIdx + 2] ?? null : null;
    }
    if (container === "project") return true;
    if (container === "long-term" || container === "tool" || container === "knowledge") return true;
  }

  return principalAllowsContainer(principal, metadata);
}
