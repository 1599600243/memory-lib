// scope → 检索根目录（从 memory-lib.mjs 拆出来，避免 graph-retrieval ←→ memory-lib 循环依赖）。
// 语义与 memory-lib 里原来的 resolveRootsForScopes 逐字一致。
import path from "node:path";

export function resolveRootsForScopes(scopes, dataRoot, workspaceRoot) {
  if (!Array.isArray(scopes)) return null; // null = unrestricted
  if (scopes.length === 0) return []; // explicit empty scope = deny all
  const roots = [];
  for (const scope of scopes ?? []) {
    const layer = scope?.layer;
    const visibility = scope?.visibility;
    const project = scope?.project;
    if (layer === "memory" && visibility === "shared") {
      roots.push(path.join(dataRoot, "curated", "shared"));
      roots.push(path.join(dataRoot, "project-state"));
      roots.push(path.join(dataRoot, "tools-memory"));
      roots.push(path.join(dataRoot, "plans"));
      roots.push(path.join(dataRoot, "profile"));
      roots.push(path.join(dataRoot, "evidence", "documents"));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "memory" && visibility === "project" && typeof project === "string" && project) {
      roots.push(project === "*" ? path.join(dataRoot, "project-state") : path.join(dataRoot, "project-state", project));
      roots.push(path.join(dataRoot, "evidence", "documents"));
    } else if (layer === "memory" && visibility === "agent" && typeof project === "string" && project) {
      roots.push(project === "*" ? path.join(dataRoot, "curated", "agents") : path.join(dataRoot, "curated", "agents", project));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "tool") {
      roots.push(path.join(dataRoot, "tools-memory"));
    } else if (layer === "plan") {
      roots.push(path.join(dataRoot, "plans"));
    } else if (layer === "memory" && visibility === "user") {
      roots.push(path.join(dataRoot, "curated", "shared"));
      roots.push(path.join(dataRoot, "profile"));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "memory" && visibility === "user" && typeof project === "string" && project) {
      roots.push(path.join(dataRoot, "curated", "agents"));
      roots.push(path.join(dataRoot, "plans"));
      roots.push(path.join(dataRoot, "profile"));
      roots.push(path.join(dataRoot, "evidence", "conversations"));
    } else if (layer === "memory" && visibility === "platform") {
      roots.push(path.join(dataRoot, "tools-memory"));
      roots.push(path.join(dataRoot, "evidence", "documents"));
    } else if (layer === "memory" && visibility === "daily") {
      roots.push({ path: dataRoot, type: "daily" });
    }
  }
  return [...new Set(roots)];
}

/** 把 roots 统一成绝对路径数组（daily 的 {path,type} 也要能过）。 */
export function rootPaths(roots) {
  if (roots === null) return null;
  return roots.map((root) => (typeof root === "string" ? root : root?.path)).filter(Boolean);
}
