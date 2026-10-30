// VISIBILITY-FIX-1 —— 读路径的身份绑定守卫。
//
// 病根（用户已裁决修）：多个读入口把归属判定写成 `if (principal && …)`，
// 即"**拿不到身份就跳过判定**"而不是拒绝 —— 看着有防线，实际无身份时直接放行。
// 行业旁证：Mem0/OpenMemory issue #6080（未认证跨用户读取）、AWS CVE-2026-19111（记忆工具 IDOR）。
//
// 本文件提供唯一一处"必须给出身份"的判据：拿不到合格身份 ⇒ **抛错拒绝**，
// **绝不放行、也绝不静默返回空**（静默返回空会把"我没给你看"伪装成"库里没有"）。
//
// 只收紧：有身份时行为完全不变；只在**完全缺身份**时从"跳过"改为"拒绝"。

export class MissingPrincipalError extends Error {
  constructor(what) {
    super(`${what} requires an authenticated principal (framework_id, agent_id, role_id); refusing rather than returning unfiltered results`);
    this.name = "MissingPrincipalError";
    this.code = "MISSING_PRINCIPAL";
    this.status = 403;
  }
}

// 合格的 principal = 服务端由凭据解析出来的那个（framework_id/agent_id/role_id 三者齐备）。
// 注意：**不接受调用方自报** —— 调用方给的 `agent_id`/`role_id` 参数只允许作为
// "在已授权范围内的进一步过滤"，不能替代 principal 本身。
export function hasBoundIdentity(principal) {
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) return false;
  return ["framework_id", "agent_id", "role_id"].every((key) => typeof principal[key] === "string" && principal[key].trim().length > 0);
}

// 在仓储读方法开头调用：拿不到身份就拒绝。
// `what` 用于错误信息（例如 "roleMemory.listRoleNotes"）。
export function requirePrincipal(principal, what) {
  if (!hasBoundIdentity(principal)) throw new MissingPrincipalError(what);
  return principal;
}

// 归一化容器可见性判定的默认值。
// 起因：读路径把条目交给 principalAllowsContainer 时**没有传 visibility** ⇒ 该函数用 "private" 兜底，
// 与写路径（按 container 推导 visibility）不一致 —— 这是**收紧方向**的不一致，本次保留原样以免放宽；
// 这里只把"默认取 private"这件事显式写出来，避免下一个人误以为是遗漏。
export function visibilityOrDefault(item) {
  return item?.visibility ?? "private";
}
