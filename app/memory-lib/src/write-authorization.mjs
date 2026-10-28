// WRITE-DENY-1：**写入侧的唯一一把尺子** —— 一次写入需要什么权限，由"这条记忆写出来之后的
// 可见性"决定，而不是由入口、层名或调用方自称决定。
//
// 背景（证据在 reports/WRITE-DENY-1-AUDIT-reject*-dev-report.md 与 reports/WRITE-DENY-1-AUDIT-*）：
// /v1/write 对**显式** visibility=platform 会拒（非 admin），但调用方**不写 visibility** 时用的是
// write-memory 的容器默认值 —— document⇒knowledge⇒platform、tool⇒platform。于是同一份输入：
//   · 走提炼提交 ⇒ 403 PLATFORM_REQUIRES_ADMIN（门禁看的是"写出来的可见性"）
//   · 走 /v1/write ⇒ 200，落 platform，另一个 group 能读到
// MEMORY-LOOP-1 已经为提交门禁做了正确示范（conclusionWriteTarget/Denial）。这里把同一套口径
// 抽成**一个**共享模块，供 REST 与 MCP（两条传输）以及导入类入口调用，避免两处各写一套再漂移。
//
// 判据（与 MEMORY-LOOP-1 完全一致，不新增任何可见性判据）：
//   platform              ⇒ 需要 admin 动作
//   project               ⇒ 需要该 project 的项目作用域（与捕获写入口同一条规则）
//   private / role / agent / user / shared ⇒ **WRITE-DENY-1-REJECT1（F4）起要真的匹配身份位**：
//       这条写入最终会带上 principal 的哪些身份字段，"谁能读"就由那些字段决定
//       （读侧唯一真值源 principalAllowsContainer，本模块不复制、不改）。所以写侧要求：
//         · 调用方**不得自报别人的身份**（claimed ≠ 认证身份 ⇒ IDENTITY_MISMATCH）；
//         · 这条可见性赖以成立的字段必须在认证身份上真实存在且不是 "unknown"
//           （user⇒user_id / role⇒role_id / agent⇒agent_id / shared⇒group_id /
//            private、daily⇒至少一个 owner 位）。
//       旧实现把这几档**直接放行**，于是"写 private 但落到 platform"这类旁路查不出来。
// 可见性的**默认值**仍然只有一处真值源：write-memory 的 containerDefaultVisibility()。
import { normalizeContainer } from "./container-policy.mjs";
import { containerDefaultVisibility } from "./write-memory.mjs";
import { resolveRequestScopes } from "./identity-registry.mjs";

/** frontmatter 里的值可能是带引号/带空白的字符串 —— 判权前必须归一，否则 "platform" ≠ platform。 */
function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().replace(/^["']|["']$/g, "").trim();
  return text === "" ? null : text;
}

/** 这条写入最终会写成什么（container + visibility）。显式给了 visibility 就用它。 */
export function resultingWriteTarget({ layer = null, container = null, visibility = null } = {}) {
  const normalized = normalizeContainer(clean(container) ?? clean(layer));
  if (!normalized) return null;
  const explicit = clean(visibility);
  return { container: normalized, visibility: explicit ?? containerDefaultVisibility(normalized), explicit: explicit !== null };
}

/** 调用方可以在请求体里自报的身份位（服务端一律以认证身份为准）。 */
export const CLAIMABLE_IDENTITY_SLOTS = Object.freeze(["group_id", "user_id", "agent_id", "role_id"]);

/** 从请求体里取出"自报身份位"（agent 兼容 agent / agent_id 两种写法）。 */
export function claimedIdentityOf(body = {}) {
  const claimed = {};
  for (const slot of CLAIMABLE_IDENTITY_SLOTS) {
    const value = slot === "agent_id" ? body?.agent_id ?? body?.agent : body?.[slot];
    if (value !== undefined && value !== null && String(value).trim() !== "") claimed[slot] = String(value).trim();
  }
  return claimed;
}

const USABLE = (value) => typeof value === "string" && value.trim() !== "" && value.trim() !== "unknown";

/** 该可见性赖以成立的字段（缺失 ⇒ 这条写入没有受众，必须拒）。 */
function identitySlotForVisibility(visibility) {
  if (visibility === "user") return "user_id";
  if (visibility === "role") return "role_id";
  if (visibility === "agent") return "agent_id";
  if (visibility === "shared") return "group_id";
  return null; // private / daily ⇒ owner 位，单独判
}

/**
 * F4：身份位判定（纯函数）。
 *   · claimed 里的每一项都必须等于认证身份上的同一项（不许替别人写）；
 *   · 该可见性要求的字段必须在认证身份上可用；
 *   · private / daily 要求至少有一个 owner 位（读侧正是按 user/agent/role 认人的）。
 */
export function identityDenialForWrite({ target, principal = null, claimed = null, entry = "/v1/write" } = {}) {
  if (!target) return null;
  if (!principal) {
    // 没有服务端身份就没有"身份位"可言：身份类可见性一律拒（不给"跳过判定"留口子）。
    return {
      code: "IDENTITY_REQUIRED",
      message: `${entry}: writing with visibility "${target.visibility}" requires a server-bound principal`,
    };
  }
  const own = {
    group_id: principal.group_id ?? null,
    user_id: principal.user_id ?? null,
    agent_id: principal.agent_id ?? null,
    role_id: principal.role_id ?? null,
  };
  for (const [slot, value] of Object.entries(claimed ?? {})) {
    if (!USABLE(own[slot]) || String(own[slot]) !== String(value)) {
      return {
        code: "IDENTITY_MISMATCH",
        message: `${entry}: a write must carry the authenticated identity, but ${slot}=${JSON.stringify(value)} does not match the server-bound principal`,
      };
    }
  }
  const slot = identitySlotForVisibility(target.visibility);
  if (slot) {
    if (!USABLE(own[slot])) {
      return {
        code: `MISSING_${slot.toUpperCase()}`,
        message: `${entry}: visibility "${target.visibility}" is scoped to ${slot}, but the authenticated principal has no usable ${slot}`,
      };
    }
  } else if (["private", "daily"].includes(target.visibility)) {
    if (![own.user_id, own.agent_id, own.role_id].some(USABLE)) {
      return {
        code: "MISSING_PRIVATE_OWNER",
        message: `${entry}: visibility "${target.visibility}" needs an owner (user/agent/role) on the authenticated principal, but none is usable`,
      };
    }
  }
  return null;
}

/**
 * 写授权判定（纯函数，不碰磁盘）。返回 null = 放行；否则返回 { code, message }。
 * role 形状与 identity-registry 的 role 一致（actions / scopes），MCP 侧传同样的形状。
 * principal = 服务端认证出来的身份（F4 起必需）；claimed = 调用方自报的身份位。
 */
export function writeAuthorizationDenial({ target, role = {}, project = null, entry = "/v1/write", principal = null, claimed = null, identityUnchecked = false } = {}) {
  if (!target) return { code: "UNKNOWN_LAYER", message: `${entry}: the layer cannot be mapped to a container` };
  const actions = Array.isArray(role?.actions) ? role.actions : [];
  if (target.visibility === "platform") {
    if (!actions.includes("admin")) {
      return {
        code: "PLATFORM_REQUIRES_ADMIN",
        message: `${entry}: this write lands in container "${target.container}" with visibility "platform" (readable by everyone), so it requires the admin action`,
      };
    }
  }
  if (target.visibility === "project") {
    const scopeRes = resolveRequestScopes(role, [{ layer: "memory", visibility: "project", project: project ?? null }]);
    if (!scopeRes.ok) {
      return {
        code: `PROJECT_SCOPE_${scopeRes.reason}`,
        message: `${entry}: this write lands with visibility "project" in project ${JSON.stringify(project ?? null)}, so the role must hold that project scope`,
      };
    }
  }
  // 身份位判据只对**身份类可见性**（private/role/agent/user/shared/daily）成立：
  //   · platform 没有身份位（受众是所有人），它的门是 admin；
  //   · project 的受众由项目作用域决定（既有契约：项目写入里带 group_id 是被**忽略**的，
  //     服务端身份为准 —— m1-4-http-writer-e2e 就是这么用的，不能把它改成 403）。
  // identityUnchecked 只给纯规划函数（没有 principal 可用）用；真正的写入口默认"没身份不放行"。
  const identityBearing = !["platform", "project"].includes(target.visibility);
  const identityDenial = identityUnchecked || !identityBearing ? null : identityDenialForWrite({ target, principal, claimed, entry });
  if (identityDenial) return identityDenial;
  return null;
}

/** 便捷封装：给一条 layer/visibility/project 直接判定。 */
export function denialForWrite({ layer = null, container = null, visibility = null, project = null, role = {}, entry = "/v1/write", principal = null, claimed = null } = {}) {
  return writeAuthorizationDenial({ target: resultingWriteTarget({ layer, container, visibility }), role, project, entry, principal, claimed });
}

/**
 * F2：取代（supersede）的门 —— 取代会**同时**改动新旧两条记录，所以必须在写之前按
 * **旧记录真实的 container/visibility/project** 走同一把尺子。旧记录缺可见性时按容器默认值。
 */
export function supersedeDenialFor({ oldRecord = {}, layer = null, role = {}, entry = "/v1/memory/supersede", principal = null, claimed = null } = {}) {
  const frontmatter = oldRecord?.frontmatter ?? oldRecord ?? {};
  // layerHint：调用方想写在哪个层（writer 实际用的也是这个优先级：input.layer ?? 旧记录 layer）。
  // 旧记录的 frontmatter 不一定带 layer/container，所以优先用调用方声明的层，再退回旧记录。
  const candidateLayer = clean(layer) ?? clean(frontmatter.layer);
  const container = clean(frontmatter.container);
  const visibility = clean(frontmatter.visibility);
  const project = clean(frontmatter.project) ?? clean(frontmatter.project_id);
  const base = { visibility, project, role, entry, principal, claimed };
  // container 与 layer 任一能映射到容器即可（container 优先）；两者都映不出来才算 UNKNOWN_LAYER。
  let denial = denialForWrite({ layer: candidateLayer, container, ...base });
  if (denial?.code === "UNKNOWN_LAYER") denial = denialForWrite({ layer: candidateLayer, container: null, ...base });
  return denial;
}
