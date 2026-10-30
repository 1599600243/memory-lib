// Generate the optional Chinese-summary sidecar from memory Markdown files.
// Sources are read-only; only --out and --checkpoint are written.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/read-only-core.mjs";
import { atomicWriteFile } from "../src/atomic-write.mjs";

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3:latest";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function optionsFromArgs(args) {
  const roots = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) roots.push(path.resolve(args[++index]));
  }
  const workspaceRoot = path.resolve(option(args, "--workspace-root", "I:\\OpenClaw\\memory-data"));
  const dataRoot = path.resolve(option(args, "--data-root", path.join(workspaceRoot, "memory")));
  return {
    roots: roots.length ? roots : [path.join(dataRoot, "curated"), path.join(dataRoot, "project-state")],
    out: path.resolve(option(args, "--out", path.join(workspaceRoot, "zh-summary.json"))),
    checkpoint: path.resolve(option(args, "--checkpoint", path.join(workspaceRoot, "runtime", "zh-summary.checkpoint.json"))),
    endpoint: option(args, "--ollama-endpoint", DEFAULT_ENDPOINT).replace(/\/+$/u, ""),
    model: option(args, "--model", DEFAULT_MODEL),
    maxBody: Number(option(args, "--max-body", "6000")),
    timeoutMs: Number(option(args, "--timeout-ms", "120000")),
  };
}

async function walkMarkdown(root, output = []) {
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await walkMarkdown(target, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(target);
  }
  return output;
}

function redact(text) {
  return String(text ?? "")
    .replace(/(password|passwd|secret|api[- ]?key|access[- ]?token|refresh[- ]?token|app[- ]?token|bearer|密码|口令)\s*(?:是|为|=|:|：)\s*([^\s,;，；。)）]+)/giu, "$1（已省略）")
    .replace(/(authorization\s*:\s*bearer)\s+([^\s,;，；]+)/giu, "$1（已省略）")
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "（凭证值已省略）")
    .replace(/\b[A-Za-z0-9+/=_-]{32,}\b/gu, "（凭证值已省略）");
}

function promptFor(body, maxBody) {
  return `你是记忆库的摘要助手。请用简体中文输出严格 JSON，不要 Markdown，不要解释过程：\n{"summaryZh":"一句话摘要，不超过40个汉字","keyPoints":["关键结论，不超过30个汉字"]}\n不得输出密码、token、secret、API key、App Token 或其他凭证值；不要编造。\n\n--- 记忆正文 ---\n${redact(body).slice(0, maxBody)}`;
}

function parseModelJson(content) {
  let text = String(content ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text);
  const summaryZh = redact(String(parsed.summaryZh ?? parsed.summary ?? "").trim());
  const keyPoints = Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map((value) => redact(String(value).trim())).filter(Boolean).slice(0, 3) : [];
  if (!summaryZh) throw new Error("model returned empty summaryZh");
  return { summaryZh, keyPoints };
}

async function summarize(body, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model: options.model, stream: false, think: false, options: { temperature: 0.1 }, messages: [{ role: "user", content: promptFor(body, options.maxBody) }] }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    return parseModelJson(payload?.message?.content);
  } finally {
    clearTimeout(timer);
  }
}

async function writeJsonAtomic(file, value) {
  // ATOMICWRITE-1：收敛到统一助手（含建目录 + rename 重试）。
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function generateZhSummary(options) {
  const files = (await Promise.all(options.roots.map((root) => walkMarkdown(root)))).flat().sort();
  const allowed = new Set(files);
  const previous = await fs.readFile(options.checkpoint, "utf8").then(JSON.parse).catch(() => ({ results: [] }));
  const completed = new Map((previous.results ?? []).filter((item) => allowed.has(item.path)).map((item) => [item.path, item]));
  const failures = [];
  const skipped = [];
  for (const file of files) {
    if (completed.has(file)) continue;
    const text = await fs.readFile(file, "utf8");
    const { frontmatter, body } = parseFrontmatter(text);
    if (body.trim().length < 20) {
      skipped.push({ path: file, reason: "body shorter than 20 characters" });
      continue;
    }
    try {
      const generated = await summarize(body, options);
      completed.set(file, { path: file, id: String(frontmatter.id ?? path.basename(file, ".md")), updatedAt: String(frontmatter.updatedAt ?? frontmatter.createdAt ?? ""), ...generated });
    } catch (error) {
      failures.push({ path: file, error: String(error?.message ?? error).slice(0, 240) });
    }
    await writeJsonAtomic(options.checkpoint, { model: options.model, roots: options.roots, results: [...completed.values()], failures, skipped });
  }
  const results = [...completed.values()].sort((left, right) => left.path.localeCompare(right.path));
  const report = { generatedAt: new Date().toISOString(), model: options.model, sourceRoots: options.roots, sourceCount: files.length, resultCount: results.length, failureCount: failures.length, skippedCount: skipped.length, results, failures, skipped };
  await writeJsonAtomic(options.out, report);
  return { sourceCount: files.length, resultCount: results.length, failureCount: failures.length, skippedCount: skipped.length, out: options.out, checkpoint: options.checkpoint };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateZhSummary(optionsFromArgs(process.argv.slice(2))).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
