// ATOMICWRITE-1 —— 统一原子写助手。
//
// 为什么需要它（产品岗在 DAYRECALL-1 复核里实测到的平台级缺陷）：
//   Windows 上 `fs.rename(tmp, target)` **偶发** `EPERM: operation not permitted`。
//   典型成因是杀毒/索引/同步进程在极短窗口内持有目标文件句柄 —— 这类占用是**瞬时**的。
//   在此之前全仓有 20 处左右"写 tmp → rename"的原子写，**没有任何一处重试**，
//   于是一次瞬时占用就变成一次对调用方的失败（HTTP 侧表现为 `400 WRITE_REJECTED`，
//   用户侧表现为"刚才那次没写进去"）。重试几毫秒即可跨过这个窗口。
//
// 边界（刻意保持很窄）：
//   - **只重试 rename 的瞬时错误**（EPERM / EACCES / EBUSY）。其它错误立即抛出，
//     不做无谓重试，更不把真实错误换成别的错误。
//   - **重试用尽仍然抛错**，绝不吞错、绝不假装写成功。
//   - 失败时清掉临时文件（调用方也可通过 `cleanup` 自行处理）。
//   - 本模块**不 import 任何仓库内模块**：它是叶子节点，任何写入口都能安全依赖它。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// 文档化的重试预算：共 5 次重试（首次之外），退避 10/25/50/100/200ms + 抖动。
// 总等待 ≈ 385ms 量级 —— 足够跨过"文件被短暂占用"的窗口，又不会让请求明显变慢。
export const RENAME_RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100, 200]);
// 抖动比例：实际等待落在 [base, base * (1 + jitter)] 内，避免多个写入方同步重试。
export const RENAME_RETRY_JITTER = 0.5;

// 只有这几个错误码是"重试可能就好了"的。其余（ENOENT/ENOTDIR/EISDIR/ENOSPC/EROFS/EEXIST…）
// 重试多少次都不会变 —— 立即失败，别浪费时间。
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export function isRetryableRenameError(error) {
  return RETRYABLE_RENAME_CODES.has(error?.code);
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function jitteredDelay(baseMs, jitter) {
  if (!(baseMs > 0)) return 0;
  const extra = jitter > 0 ? Math.random() * baseMs * jitter : 0;
  return Math.round(baseMs + extra);
}

/**
 * 只做「带重试的 rename」。给**移动已存在文件**的场景用（如归档搬到 _legacy 目录）——
 * 那种场景没有"写临时文件"这一步，但同样怕瞬时 EPERM。
 * 重试用尽后抛**原始错误**。
 */
export async function renameWithRetry(from, to, options = {}) {
  const {
    retryDelaysMs = RENAME_RETRY_DELAYS_MS,
    jitter = RENAME_RETRY_JITTER,
    rename = fs.rename,
    sleep = defaultSleep,
  } = options;

  const attempts = (Array.isArray(retryDelaysMs) ? retryDelaysMs.length : 0) + 1;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to);
      return { from, to, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error)) break;
      if (attempt === attempts - 1) break;
      await sleep(jitteredDelay(retryDelaysMs[attempt], jitter));
    }
  }
  throw lastError;
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 * rename 遇瞬时错误会自动退避重试；重试用尽后抛出**原始错误**。
 *
 * @param {string} targetPath   目标文件
 * @param {string|Buffer} content
 * @param {object} [options]
 * @param {number[]} [options.retryDelaysMs] 退避序列（默认 RENAME_RETRY_DELAYS_MS）
 * @param {number} [options.jitter]          抖动比例（默认 RENAME_RETRY_JITTER）
 * @param {(error: Error) => any} [options.cleanup] 最终失败时的清理回调（默认删掉临时文件）
 * @param {(from: string, to: string) => Promise<any>} [options.rename] 注入点，仅测试用
 * @param {(from: string, to: string) => Promise<any>} [options.unlink] 注入点，仅测试用
 * @param {(ms: number) => Promise<any>} [options.sleep] 注入点，仅测试用
 * @param {string} [options.tmpSuffix] 临时文件后缀（默认 .<randomUUID>.tmp）
 * @param {number} [options.mode] 临时文件的创建权限（如 0o600，供凭据/会话这类敏感文件使用）
 */
export async function atomicWriteFile(targetPath, content, options = {}) {
  const {
    cleanup = null,
    rename = fs.rename,
    unlink = fs.unlink,
    open = fs.open,
    sleep = defaultSleep,
    tmpSuffix = `.${crypto.randomUUID()}.tmp`,
    mode = undefined,
  } = options;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}${tmpSuffix}`;
  // 权限走 fs.open 的 mode（与各调用点原有的 writeFile({ mode }) 语义一致）。
  // 注意：在 Windows 上 POSIX 位不可表达（该平台只有只读属性），mode 实际上被忽略 ——
  // 这是平台事实，不是本助手的缺陷；POSIX 上该 mode 会正常生效。
  const handle = await open(temporary, "w", mode === undefined ? 0o666 : mode);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }

  try {
    const renamed = await renameWithRetry(temporary, targetPath, options);
    return { targetPath, temporary, attempts: renamed.attempts };
  } catch (error) {
    // 失败清理。清理本身失败**不许**盖掉真正的错误（否则排查会被误导）。
    try {
      if (typeof cleanup === "function") await cleanup(error);
      else await unlink(temporary).catch(() => {});
    } catch {
      // 刻意吞掉：下面抛的必须是原始 rename 错误。
    }
    throw error;
  }
}

/**
 * 轻量原子写：只写 JSON，供 registry / 配置这类小文件使用。
 * 与 atomicWriteFile 共用同一套重试语义。
 */
export async function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
