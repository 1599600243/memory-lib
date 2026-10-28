import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function snapshotAndExtract(sourcePath, tmpDir, sessionId, {
  sevenZip,
  copyFile = fs.copyFileSync,
  runExtractor = (executable, inputPath, outputDir) => execFileSync(executable, ["e", inputPath, `-o${outputDir}`, "-y", "-aoa"], { stdio: "ignore" }),
  exists = fs.existsSync,
  mkdir = fs.mkdirSync,
  remove = fs.rmSync,
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  wait = sleep,
  pid = process.pid,
  now = Date.now,
} = {}) {
  if (!sevenZip) throw new Error("未找到 7z.exe，无法解压会话日志");
  const runDir = path.join(tmpDir, `${sessionId}-${pid}-${now()}`);
  mkdir(runDir, { recursive: true });
  const snapshotPath = path.join(runDir, "session.jsonl.zstd");
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      copyFile(sourcePath, snapshotPath);
      runExtractor(sevenZip, snapshotPath, runDir);
      const jsonlPath = path.join(runDir, "session.jsonl");
      if (!exists(jsonlPath)) throw new Error("解压产物缺失");
      return { runDir, jsonl: jsonlPath };
    } catch (error) {
      lastError = error;
      try { remove(snapshotPath, { force: true }); } catch {}
      if (attempt + 1 < retries) await wait(backoffMs * (2 ** attempt));
    }
  }
  try { remove(runDir, { recursive: true, force: true }); } catch {}
  throw lastError ?? new Error("会话快照失败");
}
