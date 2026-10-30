#!/usr/bin/env node
/**
 * migration-readiness.mjs —— 迁移前体检（只读，不改任何东西）
 *
 * 目的：把"搬到服务器"需要的东西**从活系统里数出来**，而不是照文档猜。
 *   · 要搬哪些目录、多大
 *   · 密钥在哪、能不能换文件
 *   · 哪些是 Windows 专属件（Linux 上必须替换）
 *   · 嵌入模型（ollama）是否可用
 *   · 身份/密钥注册表是否齐全
 *
 * 用法：node migration-readiness.mjs [dataRoot]   （默认 D:\MemoryLib\data）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DATA = process.argv[2] ?? "D:\\MemoryLib\\data";
const out = { checked_at: new Date().toISOString(), data_root: DATA, findings: [], blockers: [], warnings: [] };

const sizeOf = (dir) => {
  let n = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let es = [];
    try { es = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { n++; try { bytes += fs.statSync(full).size; } catch {} }
    }
  }
  return { files: n, mb: Number((bytes / 1048576).toFixed(1)) };
};

// 1) 运行环境
out.node = process.version;
out.platform = process.platform;
const major = Number(String(process.version).replace(/^v/u, "").split(".")[0]);
if (major < 22) out.blockers.push(`Node ${process.version} 太旧：本产品用 node:sqlite（内置 SQLite），需要 Node 22+（生产在跑 v24）`);
else out.findings.push(`Node ${process.version} ✔（内置 SQLite 可用）`);

// 2) 数据目录：哪些是核心、哪些可省
const plan = [
  ["memory", "核心", "Markdown 真相（curated/evidence/project-state/…）+ 派生 SQLite 索引与图谱"],
  ["runtime", "核心", "identity.json（身份注册表）、api-keys.json、secrets/（密钥文件）、audit/（访问审计）"],
  ["recovery", "建议", "策略/计划/快照清单（服务会读）"],
  ["learning", "建议", "学习助手的计划/进度（若在用学习助手）"],
  ["imports", "可选", "外部导入的原始素材（搬过去可省，但省了要重导）"],
  ["backups", "可选", "历史备份（搬过去通常不需要，留原地即可）"],
];
out.directories = [];
for (const [name, cls, why] of plan) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) { out.directories.push({ name, class: cls, exists: false, why }); continue; }
  const s = sizeOf(p);
  out.directories.push({ name, class: cls, exists: true, files: s.files, mb: s.mb, why });
}
const core = out.directories.filter((d) => d.class === "核心" && d.exists);
out.core_bytes_mb = Number(core.reduce((a, d) => a + d.mb, 0).toFixed(1));
out.findings.push(`核心要搬的两块：${core.map((d) => `${d.name}(${d.mb}MB/${d.files}文件)`).join(" + ")}`);

// 3) 密钥：文件是否就位、能否切换
const credRef = "memory-lib/deepseek-harness";
const secretFile = path.join(DATA, "runtime", "secrets", `${credRef.replace(/[\\/]/gu, "_")}.secret`);
out.secret = { expected_file: secretFile, exists: fs.existsSync(secretFile), usable_for_file_store: false };
if (out.secret.exists) {
  const st = fs.statSync(secretFile);
  out.secret.bytes = st.size;
  // 文件存储要求：服务运行身份能读；同时**不该**让普通用户读
  out.secret.usable_for_file_store = st.size > 8;
  out.findings.push(`密钥文件已存在（${st.size} 字节）⇒ 切 --secret-store file 不需要重新灌密钥`);
  out.warnings.push("上线前必须收紧该文件权限（当前 Windows 上 BUILTIN\\Users 可读；Linux 上应 0600 且属主=服务账号）");
} else {
  out.blockers.push("找不到密钥文件：切 --secret-store file 之前必须先从 wincred 导出一份");
}

// 4) 身份注册表
for (const f of ["runtime/identity.json", "runtime/api-keys.json"]) {
  const p = path.join(DATA, ...f.split("/"));
  const ok = fs.existsSync(p);
  out.findings.push(`${f}: ${ok ? "存在 ✔" : "**不存在**"}`);
  if (!ok && f.includes("identity")) out.blockers.push("identity.json 缺失：没有它服务认不出任何 credential");
}

// 5) Windows 专属件（Linux 上必须替换）
out.windows_specific = [];
try {
  const line = execFileSync("powershell", ["-NoProfile", "-Command",
    "$t=Get-ScheduledTask -TaskName 'memory-lib-core','Memory-Archive-Daily' -ErrorAction SilentlyContinue; $t | ForEach-Object { $_.TaskName + '|' + $_.Principal.LogonType + '|' + (($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join '+') }",
  ], { encoding: "utf8", timeout: 20000 }).trim();
  out.windows_specific.push({ kind: "scheduled-task", detail: line });
  out.findings.push(`计划任务（Linux 用 systemd 替代）：${line.replace(/\r?\n/gu, " ; ")}`);
} catch (e) {
  out.warnings.push(`读计划任务失败（非 Windows 或权限不足）：${String(e.message).slice(0, 80)}`);
}
out.windows_specific.push({ kind: "secret-store", detail: "wincred（Windows 凭据管理器）→ 必须换 --secret-store file；注意 --secret-fallback-file **不能救**（wincred 后端故障不降级）" });
out.windows_specific.push({ kind: "archive-script", detail: "D:\\MemoryArchive\\live\\snapshot.ps1（PowerShell）→ 换跨平台脚本 + systemd timer" });
out.windows_specific.push({ kind: "self-heal", detail: "每 5 分钟兜底触发的计划任务 → systemd Restart=always 替代" });

// 6) 嵌入模型
try {
  const r = await fetch("http://127.0.0.1:11434/api/tags");
  const j = await r.json();
  const names = (j.models ?? []).map((m) => m.name);
  const has = names.some((n) => n.startsWith("bge-m3"));
  out.ollama = { reachable: true, has_bge_m3: has, models: names.slice(0, 6) };
  out.findings.push(`ollama 可达，bge-m3 ${has ? "已就位 ✔" : "**缺失**（语义检索会弱化，只剩字面检索）"}`);
  if (!has) out.warnings.push("目标机需要先 pull bge-m3（ollama pull bge-m3）");
} catch (e) {
  out.ollama = { reachable: false, error: String(e.message).slice(0, 80) };
  out.warnings.push("ollama 当前不可达（迁移后必须可用，否则语义检索不工作）");
}

console.log(JSON.stringify(out, null, 2));
console.log("");
console.log(out.blockers.length ? `⛔ 阻塞项 ${out.blockers.length} 条：\n- ` + out.blockers.join("\n- ") : "✅ 没有阻塞项");
console.log(out.warnings.length ? `⚠️ 注意 ${out.warnings.length} 条：\n- ` + out.warnings.join("\n- ") : "");
