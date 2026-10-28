#!/usr/bin/env node
// MAINT10 附带 / MAINT11 升级：扫"被调用但从未定义"的标识符（buildFrontmatter、getStewardBatch 这一类死路径）。
//
// 做法（启发式，非编译器）：
//   1. 先做**轻量词法清理**：剥掉注释（// 与 /* */）与字符串字面量（'…' "…" `…`，含跨行模板），
//      避免把 SQL 里的 `fts5(...)`、提示语里的 `submitting (state: …)`、正则文本当成调用；
//   2. 再在同一份语料里找**调用点** `name(`，排除：成员调用 `a.name(`、关键字、全局内建、
//      方法/函数**定义**（`async name() {`、`name() {`、`function name(`）；
//   3. 统计该标识符在整份语料里出现的总次数（词边界）；若总次数 == 调用点数（≤1），
//      说明它既没被 import、也没被声明/赋值 —— 判为"调用未定义"。
//
// 判据精度高、召回保守（宁可漏报，也不要每天被误报淹没）。这条守卫抓的是"名字只在调用处出现"，
// 而 D29 删实现留下的死路径恰好都是这个形状。
//
// 用法：node scripts/maint10-undefined-called-identifiers.mjs [--root <memory-lib 根>]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "await", "do", "else", "try", "finally", "throw", "delete", "void", "yield", "super", "import", "export", "case", "with", "in", "of", "instanceof"]);

// 运行时/语言内建（这些"被调用但不在本仓定义"是正常的）
const GLOBALS = new Set([
  "Response", "Request", "Headers", "FormData", "Blob", "File", "fetch", "AbortController", "AbortSignal",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "queueMicrotask", "structuredClone",
  "console", "process", "Buffer", "globalThis", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
  "atob", "btoa", "crypto", "performance", "require", "module", "exports", "__dirname", "__filename",
  "Promise", "Object", "Array", "JSON", "Math", "Date", "Number", "String", "Boolean", "Symbol", "BigInt",
  "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "Map", "Set", "WeakMap", "WeakSet", "Intl",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
]);

async function collectMjs(dir, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) { await collectMjs(absolute, out); continue; }
    if (!entry.name.endsWith(".mjs")) continue;
    out.push({ file: absolute, text: await fs.readFile(absolute, "utf8") });
  }
}

// 轻量词法清理：把注释、字符串字面量、正则字面量替换成空格（保留换行，便于报行号）。
// 正则字面量必须识别，否则像 /['"]/ 这种会让我们误以为进了字符串，把整段代码当成"字符串"吞掉
// （第一版就踩了这个坑：定义处被吞，于是"只在调用处出现"的判断全部误报）。
// `/` 是除号还是正则：看前一个非空白字符 —— `(,=:[!&|?{};+-*%~^<>` 或行首 ⇒ 正则。
export function stripCommentsAndStrings(text) {
  let out = "";
  let i = 0;
  let state = "code";
  let lastSignificant = ""; // 上一个非空白代码字符，用于区分 / 是除号还是正则
  const prevIsRegexStart = () => lastSignificant === "" || "(,=:[!&|?{};+-*%~^<>".includes(lastSignificant);
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line-comment"; out += "  "; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block-comment"; out += "  "; i += 2; continue; }
      if (ch === "/" && prevIsRegexStart()) { state = "regex"; out += " "; i += 1; continue; }
      if (ch === "'") { state = "single"; out += " "; i += 1; continue; }
      if (ch === '"') { state = "double"; out += " "; i += 1; continue; }
      if (ch === "`") { state = "template"; out += " "; i += 1; continue; }
      if (!/\s/u.test(ch)) lastSignificant = ch;
      out += ch; i += 1; continue;
    }
    if (state === "line-comment") {
      if (ch === "\n") { state = "code"; out += "\n"; i += 1; continue; }
      out += " "; i += 1; continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += ch === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (state === "regex") {
      if (ch === "\\") { out += "  "; i += 2; continue; }
      if (ch === "[") { state = "regex-class"; out += " "; i += 1; continue; }
      if (ch === "/") { state = "code"; out += " "; i += 1; lastSignificant = "/"; continue; }
      out += ch === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (state === "regex-class") {
      if (ch === "\\") { out += "  "; i += 2; continue; }
      if (ch === "]") { state = "regex"; out += " "; i += 1; continue; }
      out += ch === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      if (ch === "\\") { out += "  "; i += 2; continue; }
      if (ch === quote) { state = "code"; out += " "; i += 1; lastSignificant = quote; continue; }
      out += ch === "\n" ? "\n" : " "; i += 1; continue;
    }
    // template
    if (ch === "\\") { out += "  "; i += 2; continue; }
    if (ch === "`") { state = "code"; out += " "; i += 1; lastSignificant = "`"; continue; }
    out += ch === "\n" ? "\n" : " "; i += 1; continue;
  }
  return out;
}

/**
 * 扫描一个 memory-lib 根下的"被调用但从未定义"的标识符。
 * @param {{ root: string, scanDirs?: string[] }} options
 * @returns {Promise<Array<{ file: string, line: number, name: string, occurrences: number }>>}
 */
export async function scanUndefinedCalledIdentifiers({ root, scanDirs = ["src", "mcp"] } = {}) {
  if (!root) throw new Error("scanUndefinedCalledIdentifiers requires root");
  const files = [];
  for (const dir of scanDirs) await collectMjs(path.join(root, dir), files);
  const cleaned = files.map((f) => ({ file: f.file, text: stripCommentsAndStrings(f.text) }));
  const corpus = cleaned.map((f) => f.text).join("\n");
  const countOf = (name) => (corpus.match(new RegExp(`\\b${name.replace(/[$]/gu, "\\$")}\\b`, "gu")) ?? []).length;

  const findings = [];
  for (const { file, text } of cleaned) {
    const lines = text.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const match of line.matchAll(/([.]{0,2}\??\.?)\s*\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
        const prefix = match[1] ?? "";
        const name = match[2];
        if (prefix.includes(".")) continue;               // 成员/可选链调用
        if (KEYWORDS.has(name) || GLOBALS.has(name)) continue;
        // 函数/方法**定义**（不是调用）：`function name(`、`async name(`、`name(...) {`、`get/set/static name(`
        const before = line.slice(0, match.index);
        const afterCall = line.slice(match.index + match[0].length);
        if (/(?:^|[\s;{}])(?:async|static|get|set)\s+$/u.test(before) && /\{\s*$/u.test(afterCall)) continue;
        if (/^\s*$/u.test(before) && /\{\s*$/u.test(afterCall)) continue;
        if (/\bfunction\s*$/u.test(before)) continue;
        if (new RegExp(`\\b(function|class|const|let|var)\\s+${name}\\b`, "u").test(corpus)) continue;
        if (new RegExp(`\\bimport\\s*\\{[^}]*\\b${name}\\b`, "u").test(corpus)) continue;
        if (new RegExp(`\\b${name}\\s*[:=]\\s*(async\\s*)?(\\(|function)`, "u").test(corpus)) continue;
        if (new RegExp(`\\b(?:async\\s+)?\\*?${name}\\s*\\([^)]*\\)\\s*\\{`, "u").test(corpus)) continue; // 方法简写定义
        if (countOf(name) <= 1) {
          findings.push({ file: path.relative(root, file).replaceAll("\\", "/"), line: i + 1, name, occurrences: countOf(name) });
        }
      }
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const i = process.argv.indexOf("--root");
  const root = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(here, "..");
  const findings = await scanUndefinedCalledIdentifiers({ root });
  if (!findings.length) {
    console.log(`OK: no called-but-never-defined identifier found under ${path.join(root, "src")} or ${path.join(root, "mcp")}`);
  } else {
    console.log(`FOUND ${findings.length} suspicious call site(s):`);
    for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.name}(...)  occurrences=${f.occurrences}`);
  }
  process.exit(findings.length ? 1 : 0);
}
