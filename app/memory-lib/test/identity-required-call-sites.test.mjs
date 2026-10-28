// VISIBILITY-FIX-1-REJECT5 —— **机械守卫**：需要身份的函数，不许有「没传身份的调用点」（**红先行**）。
//
// 为什么要有这个文件：同一类缺陷已**连续 5 次**复发 ——
//   recall_brief → 宠物草稿 → 宠物桥草稿 → persona 读路径 → MCP `pet_command`。
// 每次形态都一样：**把身份收紧 ⇒ 打断某个「没传身份」的老调用点**。
// 靠「穷举表人工发现」已被证明不够（第 5 次就是表里没有的那条通道）⇒ 改用**机械守卫**。
//
// 守卫规则：
//   ① 对每个「需要身份才能工作」的函数，扫出生产代码里对它的**限定调用点**（`x.foo(...)`）；
//   ② 一个调用点算「传了身份」，当且仅当满足三者之一：
//        a. 实参里出现身份关键字（`principal` / `roleId` / 条目里写的等价写法）；
//        b. 实参里出现**由身份派生的变量**（如 `const petScope = petPrincipal.role_id;` ⇒ `petScope` 算身份，
//           按**值**识别，不按变量名）；
//        c. 最近几行里出现过身份**构造函数** `authenticatedPrincipal(...)`（即这个调用点自己造身份）；
//      否则必须落在 ALLOW 清单里（写成「哪个文件的哪一类调用点，为什么允许」，附预期条数）；
//   ③ 新增调用点若「既没传身份、又不在清单里」⇒ **本测试红**。清单里预期条数对不上也红（防止清单变成"一票全放行"）。
//
// 判别力（不许恒真空跑）：
//   `runGuard` 是**纯函数**，可以喂人造源码。用例 ② 把人造源码喂进去，守卫**必须**报出那两条
//   "没传身份"的调用点，且**必须不**报那两条"传了身份"的 —— 两头都断。
//   用例 ① 另外断言「每个守卫条目都真的扫到了调用点」，防止函数改名后守卫静默失效。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.join(ROOT, "..");

// ── 需要身份才能工作的函数（每加一格，守卫覆盖面就加一格）──────────────────────
// `declaredIn`：函数**定义**在哪个文件（用来断言"守卫条目没过期"）；
// `qualifier`：哪些限定名算「入口调用点」——只把**跨模块**调用算入口，模块内部的自调用不算。
const IDENTITY_REQUIRED = [
  {
    id: "pet.handleCommand",
    name: "handleCommand",
    declaredIn: "memory-lib/src/pet.mjs",
    declaration: /async function handleCommand\(/u,
    qualifiers: ["pet", "petApi"],
    identityKeys: ["principal", "roleId"],
    why: "喂给模型的那条路径：普通对话按身份取 persona（REJECT4）；缺身份直接 MISSING_PRINCIPAL",
  },
  {
    id: "pet.handleCommandStream",
    name: "handleCommandStream",
    declaredIn: "memory-lib/src/pet.mjs",
    declaration: /async function\* handleCommandStream\(/u,
    qualifiers: ["pet", "petApi"],
    identityKeys: ["principal", "roleId"],
    why: "同上（流式版），宠物桥 stream=true 走这条",
  },
  {
    id: "petStore.loadPersona",
    name: "loadPersona",
    declaredIn: "memory-lib/src/pet-runtime-store.mjs",
    declaration: /async function loadPersona\(/u,
    qualifiers: ["petStore", "personaStore"],
    identityKeys: ["principal", "roleId", "personaRole"],
    why: "persona 权威键 = 服务端身份；没身份必须拒绝，不许回退到 mode 或写死缺省",
  },
  {
    id: "petStore.putPersonaConfig",
    name: "putPersonaConfig",
    declaredIn: "memory-lib/src/pet-runtime-store.mjs",
    declaration: /async function putPersonaConfig\(/u,
    qualifiers: ["petStore", "probeStore", "seed"],
    identityKeys: ["petScope", "principal", "roleId"],
    why: "写 personas/<role_id>.json；写谁的身份必须是服务端解析出来的",
  },
  {
    id: "recall.recallBrief",
    name: "recallBrief",
    declaredIn: "memory-lib/src/recall.mjs",
    declaration: /async function recallBrief\(/u,
    qualifiers: ["recall"],
    identityKeys: ["principal"],
    why: "简报按归属过滤（默认拒绝），不接受调用方自报身份",
  },
  {
    id: "roleMemory.listRoleNotes",
    name: "listRoleNotes",
    declaredIn: "memory-lib/src/role-memory.mjs",
    declaration: /async function listRoleNotes\(/u,
    qualifiers: ["roleMemory", "roles", "repo"],
    identityKeys: ["principal"],
    why: "角色记忆读路径；无身份必须拒绝（VISIBILITY-FIX-1）",
  },
];

// ── 允许清单：**逐类**写明「哪一类调用点、为什么允许、预期几条」──────────────────
// 规则：`file` 是相对仓库根的 glob；`count` 是该类允许调用点的**预期条数**（对不上就是清单过期/过宽）。
const ALLOW = [
  {
    id: "probe-probes",
    ids: ["petStore.putPersonaConfig", "roleMemory.listRoleNotes"],
    file: "memory-lib/scripts/probe-*.mjs",
    count: 21,
    reason: "只读探针/审计脚本：它们**故意**用「没身份」的调用去量修前/修后行为（这正是审计手法），不是被守卫保护的调用点",
  },
];

// ── 扫描范围与文本工具 ──────────────────────────────────────────────────────
const SCAN_DIRS = ["memory-lib/src", "memory-lib/mcp", "memory-lib/scripts"];
// 调用点自己构造身份的标记：出现它就算"这个调用点掌握了身份"
const IDENTITY_BUILDER = /authenticatedPrincipal\s*\(/u;const BUILDER_LOOKBACK_LINES = 8;

async function collectMjs(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectMjs(p, out);
    else if (entry.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

// 取 `(` 之后配平的实参文本（跨行；字符串/模板/注释里的括号不参与配平）
function argsAfter(source, openParenIndex) {
  const openers = { "(": ")", "[": "]", "{": "}" };
  const closers = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let inString = null;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i += 1; continue; }
    if (ch === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i) + 1; continue; }
    if (openers[ch]) { stack.push(ch); continue; }
    if (closers[ch]) {
      stack.pop();
      if (stack.length === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex + 1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// 关键字按**标识符边界**匹配：`principal_id` 不算 `principal`
const hasKey = (text, key) => new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRe(key)}(?![A-Za-z0-9_$])`, "u").test(text);

// 身份派生变量：`const petPrincipal = authenticatedPrincipal(...)` / `const petScope = petPrincipal.role_id`
// ⇒ 按**值**把这些变量名认成身份（不按变量名猜），支持两级派生。
function identityVariablesIn(text, seedKeys) {
  const names = new Set();
  const assignments = [...text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu)].map((m) => ({ name: m[1], value: m[2] }));
  for (let round = 0; round < 2; round += 1) {
    const keys = [...seedKeys, ...names];
    for (const a of assignments) {
      if (names.has(a.name)) continue;
      if (keys.some((k) => hasKey(a.value, k)) || IDENTITY_BUILDER.test(a.value)) names.add(a.name);
    }
  }
  return [...names];
}

// 去注释（保留字符串字面量），避免把**注释里**的代码示例当成真实调用点。
// 本轮就踩过这个坑：`mcp-server.mjs:462` 是一条注释 `// 此前 recall.recallBrief(payload) …`。
function stripComments(source) {
  let out = "";
  let inString = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += source[i + 1] ?? ""; i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; out += ch; continue; }
    if (ch === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i += 1; out += "\n"; continue; }
    if (ch === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i); i = end < 0 ? source.length : end + 1; out += " "; continue; }
    out += ch;
  }
  return out;
}

const globToRe = (glob) => new RegExp(`^${escapeRe(glob).replace(/\\\*\\\*/gu, ".*").replace(/\\\*/gu, "[^/]*")}$`, "u");

// 离调用点最近的、**闭合后回到文件顶层作用域**（括号深度归零）的那个函数签名里是否拿着身份。
// 为什么需要：`coreFromLib(services, principal, …)` 里的 `x.foo(...)` 能拿到身份，
// 但 `recallBrief: (payload) => …` 这种**内层**箭头函数的签名里没有 principal
// —— 只看"最近一层"会把它误判成没身份（本轮就踩了这个坑）。
function braceBalance(line) {
  let n = 0;
  for (const ch of line) { if (ch === "{") n += 1; else if (ch === "}") n -= 1; }
  return n;
}
function scopeCarriesIdentity(lines, lineNo, keys) {
  let depth = 0;
  for (let i = lineNo - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const isFn = /^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:async\s+)?function\s*\*|^\s*[A-Za-z_$][\w$]*\s*\(.*\)\s*=>\s*$/u.test(line);
    if (isFn && depth === 0) {
      const head = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
      const cut = head.indexOf(")");
      const sig = cut >= 0 ? head.slice(0, cut + 1) : head;
      return keys.some((k) => hasKey(sig, k));
    }
    depth += braceBalance(line);
  }
  return false;
}

// 纯函数守卫：喂源码 → { violations, sites, declarations, allowedByRule }
export function runGuard({ files }) {
  const violations = [];
  const sites = [];
  const declarations = {};
  const allowedByRule = new Map();
  for (const spec of IDENTITY_REQUIRED) {
    declarations[spec.id] = [];
    for (const file of files) {
      const raw = file.text;
      const text = stripComments(raw);
      const lines = text.split(/\r?\n/u);
      const keys = [...new Set([...spec.identityKeys, ...identityVariablesIn(text, spec.identityKeys)])];
      for (let i = 0; i < lines.length; i += 1) {
        if (file.path === spec.declaredIn && spec.declaration.test(lines[i])) declarations[spec.id].push(`${file.path}:${i + 1}`);
      }
      const pattern = new RegExp(`([A-Za-z_$][\\w$]*)\\.${spec.name}\\s*\\(`, "gu");
      for (const m of text.matchAll(pattern)) {
        const qualifier = m[1];
        if (!spec.qualifiers.includes(qualifier)) continue;
        const openParen = m.index + m[0].length - 1;
        const args = argsAfter(text, openParen);
        const line = text.slice(0, m.index).split(/\r?\n/u).length;
        const viaArgs = keys.some((k) => hasKey(args, k));
        const window = lines.slice(Math.max(0, line - 1 - BUILDER_LOOKBACK_LINES), line).join("\n");
        const viaBuilder = IDENTITY_BUILDER.test(window) || IDENTITY_BUILDER.test(args);
        const viaScope = scopeCarriesIdentity(lines, line - 1, keys);
        const passed = viaArgs || viaBuilder || viaScope;
        const entry = { id: spec.id, qualifier, path: file.path, line, passed, viaArgs, viaBuilder, viaScope, args: args.replace(/\s+/gu, " ").trim().slice(0, 140) };
        const rule = ALLOW.find((a) => a.ids.includes(spec.id) && (!a.qualifiers || a.qualifiers.includes(qualifier)) && globToRe(a.file).test(file.path));
        if (rule) {
          entry.allowed = rule.reason;
          allowedByRule.set(rule.id, (allowedByRule.get(rule.id) ?? 0) + 1);
        }
        sites.push(entry);
        if (!passed && !rule) violations.push(entry);
      }
    }
  }
  return { violations, sites, declarations, allowedByRule };
}

async function loadProductionFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const p of await collectMjs(path.join(REPO, dir))) {
      files.push({ path: path.relative(REPO, p).split(path.sep).join("/"), text: await fs.readFile(p, "utf8") });
    }
  }
  return files;
}

test("① 生产代码里：每个「需要身份」的调用点要么传了身份，要么在允许清单里", async () => {
  const files = await loadProductionFiles();
  const { violations, sites, declarations, allowedByRule } = runGuard({ files });

  // 夹具前提：守卫必须真的扫到调用点，且每个条目都有效（否则「零违规」是空跑）
  assert.ok(sites.length >= 8, `守卫必须扫到调用点，实际只扫到 ${sites.length} 个：${JSON.stringify(sites.map((s) => `${s.id}:${s.path}:${s.line}`))}`);
  for (const spec of IDENTITY_REQUIRED) {
    assert.ok((declarations[spec.id] ?? []).length >= 1, `守卫条目 ${spec.id} 的**声明**没找到 ⇒ 函数改名了，请更新 IDENTITY_REQUIRED`);
    assert.ok(sites.filter((s) => s.id === spec.id).length >= 1, `守卫条目 ${spec.id} 一个调用点都没扫到 ⇒ 守卫已过期`);
  }
  // 允许清单必须"按预期条数"命中，否则清单可能过宽（静默放行新调用点）
  for (const rule of ALLOW) {
    assert.equal(
      allowedByRule.get(rule.id) ?? 0,
      rule.count,
      `允许规则 ${rule.id} 预期命中 ${rule.count} 条，实际 ${allowedByRule.get(rule.id) ?? 0} 条 ⇒ 清单过期或过宽，请复核后更新`,
    );
  }

  assert.deepEqual(
    violations.map((v) => `${v.id}@${v.path}:${v.line}`),
    [],
    `有「需要身份但没传身份」的调用点（新增调用点必须传 principal/roleId，或写进 ALLOW 并说明理由）：\n${violations.map((v) => `  · ${v.id} @ ${v.path}:${v.line}  实参：${v.args}`).join("\n")}`,
  );
});

test("② 反向用例：人造源码里「没传身份」的必须报、「传了身份」的不许报", () => {
  const synthetic = [{
    path: "memory-lib/mcp/fake-synthetic.mjs",
    text: [
      "export function make(x) {",
      "  const a = x.petApi.handleCommand({ input: 'hi', mode: 'companion' });",
      "  const b = x.petApi.handleCommand({ input: 'hi', principal: x.principal });",
      "  const c = x.petStore.loadPersona({ roleId: x.principal.role_id });",
      "  const d = x.petStore.loadPersona('companion');",
      "  return [a, b, c, d];",
      "}",
    ].join("\n"),
  }];
  const { violations, sites } = runGuard({ files: synthetic });
  assert.deepEqual(
    violations.map((v) => `${v.id}@${v.path}:${v.line}`),
    ["pet.handleCommand@memory-lib/mcp/fake-synthetic.mjs:2", "petStore.loadPersona@memory-lib/mcp/fake-synthetic.mjs:5"],
    `守卫必须恰好报那两条没传身份的；实际 violations=${JSON.stringify(violations.map((v) => `${v.id}:${v.line}`))}，全部调用点=${JSON.stringify(sites.map((s) => `${s.id}:${s.line}:passed=${s.passed}`))}`,
  );
  assert.equal(sites.filter((s) => s.passed).length, 2, "传了身份的两条（`principal` / `roleId`）必须被判为通过");

  // 边界 1：`principal_id` 这种「看着像身份」的字段不许算传了身份
  const sneaky = [{ path: "memory-lib/src/fake-sneaky.mjs", text: "const a = x.petApi.handleCommand({ input: 'hi', principal_id: 'x' });\n" }];
  assert.equal(runGuard({ files: sneaky }).violations.length, 1, "「像身份」的字段（principal_id）不许算作传了身份");

  // 边界 2：身份**派生变量**必须被认出来（否则每个中间变量都会误报）
  const derived = [{ path: "memory-lib/src/fake-derived.mjs", text: "const petPrincipal = authenticatedPrincipal(authed, agent, role);\nconst petScope = petPrincipal.role_id;\nconst a = x.petStore.loadPersona(petScope);\n" }];
  assert.equal(runGuard({ files: derived }).violations.length, 0, "由身份派生的变量（petScope ← petPrincipal ← authenticatedPrincipal）必须算传了身份");

  // 边界 3：调用点自己用 `authenticatedPrincipal(...)` 构造身份，也算传了身份
  const built = [{ path: "memory-lib/src/fake-built.mjs", text: "const a = x.recallBrief({ days: 7, principal: authenticatedPrincipal(authed, agent, role) });\n" }];
  assert.equal(runGuard({ files: built }).violations.length, 0, "自己构造身份（authenticatedPrincipal）必须算传了身份");
});

test("③ 允许清单必须是「活的」：命中条数按预期（防止清单变废纸或变成一票全放行）", () => {
  assert.ok(ALLOW.length >= 1, "本单必须留下一条明确的允许规则（探针脚本按设计故意不传身份）");
  for (const rule of ALLOW) {
    assert.ok(rule.reason && rule.reason.length > 10, `允许规则 ${rule.id} 必须写明理由`);
    assert.ok(Number.isInteger(rule.count) && rule.count > 0, `允许规则 ${rule.id} 必须写明预期条数`);
    assert.ok(Array.isArray(rule.ids) && rule.ids.length > 0, `允许规则 ${rule.id} 必须写明覆盖哪些守卫条目`);
  }
});
