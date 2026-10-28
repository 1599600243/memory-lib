#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createIndexStore } from "../src/index-store.mjs";
import { cosineSimilarity, summarizePairScores, summarizeRetrieval } from "../src/embedding-benchmark-metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const DEFAULT_DATA_ROOT = process.env.MEMORY_DATA_ROOT || "I:\\OpenClaw\\memory-data\\memory";
const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://127.0.0.1:11434";
const PAIRS_FILE = path.join(HERE, "fixtures", "embedding-pairs.json");
const GOLD_FILE = path.join(HERE, "fixtures", "retrieval-gold.json");
const REPORT_ROOT = path.join(REPO_ROOT, "reports");
const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const reportBase = path.join(REPORT_ROOT, `embedding-bench-${today}`);

const CANDIDATE_BASES = ["nomic-embed-text", "bge-m3", "multilingual-e5-large", "qwen3-embedding"];
const DEFAULT_DIMENSIONS = { "nomic-embed-text": 768, "bge-m3": 1024, "multilingual-e5-large": 1024, "qwen3-embedding": 1024 };

function usage() {
  console.log(`Usage: node scripts/embedding-benchmark.mjs [options]\n\nOptions:\n  --data-root PATH   Production memory root to read (default: ${DEFAULT_DATA_ROOT})\n  --endpoint URL     Ollama endpoint (default: ${ENDPOINT})\n  --no-pull          Do not run ollama pull for missing candidates\n  --models LIST      Comma-separated model bases/tags to test\n  --help             Show this help`);
}
function parseArgs(argv) {
  const out = { dataRoot: DEFAULT_DATA_ROOT, endpoint: ENDPOINT, pull: true, models: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    if (arg === "--no-pull") { out.pull = false; continue; }
    if (arg === "--data-root") out.dataRoot = argv[++i];
    else if (arg === "--endpoint") out.endpoint = argv[++i];
    else if (arg === "--models") out.models = String(argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}
function safeName(value) { return String(value).replaceAll(/[^a-zA-Z0-9._-]/gu, "_"); }
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }
function modelBase(tag) { return String(tag).split(":", 1)[0].toLowerCase(); }
function isE5(model) { return modelBase(model).includes("e5"); }
function prepareText(text, model, kind) { return isE5(model) ? `${kind}: ${text}` : text; }
function formatPct(value) { return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`; }
function formatNum(value) { return value === null || value === undefined ? "n/a" : Number(value).toFixed(4); }

async function jsonFetch(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(`${response.status} ${body?.error ?? response.statusText ?? "request failed"}`);
  return body;
}
async function listTags(endpoint, fetchImpl) {
  const data = await jsonFetch(fetchImpl, `${endpoint}/api/tags`);
  return Array.isArray(data?.models) ? data.models.map((item) => ({ name: item.name, size: Number(item.size ?? item.size_vram ?? 0) || null })) : [];
}
function chooseTags(bases, tags) {
  const selected = [];
  for (const base of bases) {
    const matches = tags.filter((tag) => modelBase(tag.name) === base || tag.name === base);
    if (!matches.length && tags.some((tag) => tag.name === base)) matches.push(tags.find((tag) => tag.name === base));
    if (base === "qwen3-embedding") {
      const scale = matches.filter((tag) => /:(?:0\.6b|4b)(?:$|@)/iu.test(tag.name));
      selected.push(...(scale.length ? scale : matches));
    } else if (matches[0]) selected.push(matches[0]);
  }
  return [...new Map(selected.map((tag) => [tag.name, tag])).values()];
}
function pullModel(model) {
  const result = spawnSync("ollama", ["pull", model], { encoding: "utf8", timeout: 30 * 60 * 1000, windowsHide: true });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `ollama pull exited ${result.status}`).replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replaceAll(/\s+/gu, " ").trim().slice(-1000);
    throw new Error(detail);
  }
}
async function embed(text, model, endpoint, fetchImpl, latency) {
  const prompt = String(text);
  const started = performance.now();
  let lastError = null;
  for (const route of ["/api/embeddings", "/api/embed"]) {
    try {
      const body = await jsonFetch(fetchImpl, `${endpoint}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(route === "/api/embed" ? { model, input: prompt } : { model, prompt }) });
      const vector = route === "/api/embed" ? (Array.isArray(body?.embeddings) ? body.embeddings[0] : body?.embedding) : body?.embedding;
      if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(Number(value)))) throw new Error("response has no numeric embedding");
      latency.push(performance.now() - started);
      return vector.map(Number);
    } catch (error) { lastError = error; }
  }
  throw new Error(`embedding API failed: ${lastError?.message ?? "unknown error"}`);
}
async function copyGoldFiles(sourceRoot, gold, destination) {
  const copied = [];
  for (const item of gold.queries) {
    const relative = item.expected.replaceAll("/", path.sep);
    const source = path.join(sourceRoot, relative);
    const target = path.join(destination, relative);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      copied.push(relative);
    } catch (error) { throw new Error(`gold file unavailable: ${item.expected}: ${error.message}`); }
  }
  return [...new Set(copied)];
}
function readIndexedDocuments(db, dataRoot) {
  const rows = db.prepare("SELECT c.id AS chunk_id,c.text,f.path,e.vector_blob,e.dimension FROM chunks c JOIN files f ON f.id=c.file_id JOIN embeddings e ON e.chunk_id=c.id WHERE f.status='active' AND e.vector_status='active' ORDER BY f.path,c.chunk_index").all();
  return rows.map((row) => ({ ...row, vector: row.vector_blob ? Array.from(new Float32Array(row.vector_blob.buffer, row.vector_blob.byteOffset, Number(row.dimension))) : null, absolute: path.join(dataRoot, ...String(row.path).split("/")) }));
}
async function runModel(model, options, pairs, gold) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `memory-embedding-bench-${safeName(model)}-`));
  const dataRoot = path.join(tempRoot, "memory");
  const latency = [];
  try {
    const copied = await copyGoldFiles(options.dataRoot, gold, dataRoot);
    const firstVector = await embed(prepareText(pairs.pairs[0].left, model, "query"), model, options.endpoint, options.fetchImpl, latency);
    const dimension = firstVector.length;
    const indexFetch = async (url, request = {}) => {
      let body = request.body;
      if (isE5(model) && body) {
        const payload = JSON.parse(body);
        body = JSON.stringify({ ...payload, prompt: `passage: ${String(payload.prompt ?? "")}` });
      }
      return options.fetchImpl(url, { ...request, body });
    };
    const store = createIndexStore({ dataRoot, ollama: { endpoint: options.endpoint, model, dimension }, fetchImpl: indexFetch });
    const indexResult = await store.index({ rebuild: true });
    const db = new DatabaseSync(store.dbPath, { readOnly: true });
    try {
      const docs = readIndexedDocuments(db, dataRoot);
      const pairRows = [];
      for (const pair of pairs.pairs) {
        const left = await embed(prepareText(pair.left, model, "query"), model, options.endpoint, options.fetchImpl, latency);
        const right = await embed(prepareText(pair.right, model, "passage"), model, options.endpoint, options.fetchImpl, latency);
        pairRows.push({ id: pair.id, label: pair.label, score: cosineSimilarity(left, right) });
      }
      const retrievalRows = [];
      for (const item of gold.queries) {
        const queryVector = await embed(prepareText(item.query, model, "query"), model, options.endpoint, options.fetchImpl, latency);
        const bestByPath = new Map();
        for (const document of docs) {
          const score = cosineSimilarity(queryVector, document.vector) ?? -1;
          if (!bestByPath.has(document.path) || score > bestByPath.get(document.path).score) bestByPath.set(document.path, { path: document.path, score });
        }
        const scored = [...bestByPath.values()];
        scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        retrievalRows.push({ id: item.id, query: item.query, expected: item.expected, ranked: scored.map((row) => row.path), top: scored.slice(0, 5) });
      }
      const pairMetrics = summarizePairScores(pairRows);
      const retrievalMetrics = summarizeRetrieval(retrievalRows);
      const latencyMedianMs = median(latency);
      const size = options.tags.find((tag) => tag.name === model)?.size ?? null;
      const chunksPerFile = copied.length ? Number(indexResult.chunks ?? 0) / copied.length : 0;
      const estimatedReembedSeconds = latencyMedianMs === null ? null : Number(((686 * chunksPerFile * latencyMedianMs) / 1000).toFixed(1));
      return { model, status: "ok", dimension, latencyMedianMs, modelSizeBytes: size, prefix: isE5(model) ? "query:/passage:" : "none", estimatedReembed: { files: 686, chunksPerGoldFile: Number(chunksPerFile.toFixed(3)), seconds: estimatedReembedSeconds, hours: estimatedReembedSeconds === null ? null : Number((estimatedReembedSeconds / 3600).toFixed(2)) }, index: { ...indexResult, sqlitePath: store.dbPath, copiedFiles: copied.length }, pairs: pairMetrics, pairScores: pairRows, retrieval: retrievalMetrics, retrievalRows };
    } finally { db.close(); }
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
}
function renderReport(report) {
  const rows = report.models.filter((item) => item.status === "ok");
  const table = rows.map((item) => `| ${item.model} | ${item.dimension} | ${formatNum(item.pairs.gap)} | ${formatPct(item.pairs.bestThresholdAccuracy)} | ${formatNum(item.pairs.auc)} | ${formatNum(item.retrieval.mrr)} | ${formatPct(item.retrieval.recallAt1)} | ${formatPct(item.retrieval.recallAt3)} | ${formatPct(item.retrieval.recallAt5)} | ${formatPct(item.retrieval.top3FalsePositiveRate)} | ${formatNum(item.latencyMedianMs)} | ${item.modelSizeBytes ? `${(item.modelSizeBytes / 1e9).toFixed(2)} GB` : "n/a"} | ${item.prefix} |`).join("\n");
  const baseline = rows.find((item) => modelBase(item.model) === "nomic-embed-text");
  const recommendations = rows.map((item) => {
    const qualifies = item.model !== baseline?.model && item.pairs.gap > 0.25 && item.retrieval.mrr >= (baseline?.retrieval.mrr ?? Infinity);
    const cost = item.estimatedReembed?.hours === null || item.estimatedReembed?.hours === undefined ? "预计耗时不可用" : `686 文件预计约 ${item.estimatedReembed.seconds} 秒（${item.estimatedReembed.hours} 小时，按 gold 文件平均 chunk 数估算）`;
    return `- **${item.model}**: ${qualifies ? "扩样本指标达到切换安全阀" : "作为对照"}。gap=${formatNum(item.pairs.gap)}，MRR=${formatNum(item.retrieval.mrr)}；${qualifies ? `本次用户决策为切换 bge-m3；部署代价：${cost}。` : "扩样本结果仅用于和生产基线对照。"}`;
  }).join("\n");
  const skipped = report.models.filter((item) => item.status !== "ok").map((item) => `- ${item.model}: 跳过，${item.reason}`).join("\n") || "- 无";
  return `# D19 Expanded Embedding Benchmark (${report.date})\n\n扩样本只读复核；生产切换由独立部署步骤执行。基准本身未修改生产模型、生产索引或生产 sqlite。生产 dataRoot：\`${report.dataRoot}\`。每个候选模型使用独立临时 dataRoot 和 sqlite。\n\n## 数字总表\n\n| 模型 | 维度 | gap | 最佳阈值准确率 | AUC | MRR | recall@1 | recall@3 | recall@5 | 前 3 假阳性率 | 延迟中位数(ms) | 体积 | 前缀 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${table || "| 无可用模型 | | | | | | | | | | | | |"}\n\n## 运行信息\n\n- 句对：${report.pairCount}（同义 ${report.synonymCount}，无关 ${report.unrelatedCount}）。\n- 检索 gold：${report.queryCount} 条，目标覆盖 curated/shared、project-state、plans、evidence/documents；原 D18 的 24 条全部保留。\n- E5 使用 query: 和 passage: 前缀；其它候选使用原文，未臆加官方指令前缀。\n- 模型体积来自 Ollama tag metadata；延迟为本次 HTTP 嵌入调用中位数。\n\n## 跳过模型\n\n${skipped}\n\n## 建议\n\n${recommendations || "- 没有完成的模型，建议先补齐 Ollama 模型后重跑。"}\n\n重嵌代价说明：本次生产实测 691 个文件、3617 个 chunks，bge 全量重嵌耗时 145621 ms。生产索引从 28872704 字节增至 37142528 字节。回滚步骤：停止服务，恢复 backups/memory-lib-index-pre-bge-m3-20261001.sqlite 到 indexes/sqlite/memory-lib-index.sqlite，将启动参数改回 nomic-embed-text/768，重启并确认 /v1/health 与 embeddings 分组。\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pairs = JSON.parse(await fs.readFile(PAIRS_FILE, "utf8"));
  const gold = JSON.parse(await fs.readFile(GOLD_FILE, "utf8"));
  const fetchImpl = globalThis.fetch;
  const report = { version: 1, date: today, dataRoot: options.dataRoot, endpoint: options.endpoint, pairCount: pairs.pairs.length, synonymCount: pairs.pairs.filter((p) => p.label === "synonym").length, unrelatedCount: pairs.pairs.filter((p) => p.label === "unrelated").length, queryCount: gold.queries.length, models: [] };
  let tags = [];
  let tagsError = null;
  try { tags = await listTags(options.endpoint, fetchImpl); } catch (error) { tagsError = error; report.tagsError = error.message; }
  const requested = options.models ?? CANDIDATE_BASES;
  if (tagsError) {
    for (const requestedModel of requested) report.models.push({ model: requestedModel, status: "skipped", reason: `Ollama /api/tags 不可用：${tagsError.message}` });
  } else {
    if (options.pull) {
      const pullFailures = new Map();
      for (const base of requested) {
        const pullTargets = base === "qwen3-embedding" ? ["qwen3-embedding:0.6b", "qwen3-embedding:4b"] : [base];
        if (pullTargets.some((target) => tags.some((tag) => tag.name === target || modelBase(tag.name) === base))) continue;
        for (const target of pullTargets) {
          if (tags.some((tag) => tag.name === target)) continue;
          try { pullModel(target); } catch (error) { pullFailures.set(target, `ollama pull 失败：${error.message}`); }
        }
      }
      for (const [model, reason] of pullFailures) report.models.push({ model, status: "skipped", reason });
      try { tags = await listTags(options.endpoint, fetchImpl); } catch (error) { tagsError = error; report.tagsError = error.message; }
    }
    if (!tagsError) {
      const selected = options.models
        ? requested.flatMap((name) => tags.filter((tag) => tag.name === name))
        : chooseTags(CANDIDATE_BASES, tags);
      const selectedBases = new Set(selected.map((tag) => modelBase(tag.name)));
      for (const requestedModel of requested) {
        const candidates = selected.filter((tag) => options.models ? tag.name === requestedModel : modelBase(tag.name) === requestedModel);
        if (!candidates.length && !selectedBases.has(requestedModel)) report.models.push({ model: requestedModel, status: "skipped", reason: "pull 后仍未在 Ollama /api/tags 中找到；未进行生产操作" });
        for (const tag of candidates) {
          try {
            report.models.push(await runModel(tag.name, { ...options, fetchImpl, tags }, pairs, gold));
          } catch (error) { report.models.push({ model: tag.name, status: "skipped", reason: error.message }); }
        }
      }
    }
  }
  await fs.mkdir(REPORT_ROOT, { recursive: true });
  await fs.writeFile(`${reportBase}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(`${reportBase}.md`, renderReport(report), "utf8");
  console.log(JSON.stringify({ report: `${reportBase}.md`, json: `${reportBase}.json`, models: report.models.map(({ model, status, reason }) => ({ model, status, reason })) }, null, 2));
}

main().catch((error) => { console.error(`embedding benchmark failed: ${error.message}`); process.exitCode = 1; });
