// 一次性修复：把被转义弄坏的 SCENARIO-1 条目区块重写为正确内容
import fs from "node:fs";
const F = "D:\\MemoryLib\\CHANGELOG.md";
let t = fs.readFileSync(F, "utf8");

const correct = [
  "---",
  "",
  "## 2026-10-16",
  "",
  "### 🎯 SCENARIO-1 复核：**场景门在\"平台侧 + 参考接入\"上通了**（真实读数被独立复现）",
  "",
  "- **被验 sha**：`17eea8e`（6 提交）· 材料 `reports\\SCENARIO-1-recheck-RECORD.md` · 探针 `scripts\\verify-scenario-1.mjs`",
  "- **我的独立判据（用我自己的夹具直接调它的参考实现）**：",
  "  ```text",
  "  零模型 ✔（import 列表为空、不 import 模型客户端、不碰写接口）",
  "  正题「10/10 我们聊了什么」→ 取回该日全部 4/4（含正好本地 00:00:00.000 那条）· 邻居不串 · complete=true",
  "  摘要确实来自库里 excerpt ✔",
  "  「随便聊聊」→ 明确拒绝（no-match）且**一条都没检索** ✔",
  "  「10/11」(locale 未知) → 拒绝并给候选（含 rationale 与候选范围），**不合并两天** ✔",
  "  「昨天聊了什么」→ 取回昨天那条 ✔",
  "  ```",
  "- **真实读数被我用两条独立路子复现**：生产既有 `since/until` 自己翻页取全（10/10=9/9、10/14=62/62、",
  "  10-13..10-15=101/101）+ 文件系统按本地日数 `capturedAt`（9/26/62/12，三天合计 100 条原文）⇒ 完全吻合。",
  "- **⚠️ 运维事实（必须记）**：拿 demo 直接打**生产** → 四个场景全 `NOT_FOUND: unknown route` ——",
  "  因为生产仍是 DEPLOY-12 的 `84fc27b`，**没有 `/v1/date/resolve`**。⇒ **要\"随口问\"在生产上真可用，必须部署。**",
  "- **未覆盖**：生产未部署 · 契约文档只抽查 · 大日子（>100 条）在接入方那侧的分批未验（已排 SCENARIO-2）。",
  "- **结论**：能力层+真实数据层通过；**不宣布验收通过**（未部署 + 未覆盖项）。",
  "",
  "## 2026-10-16",
  "",
].join("\n");

// 定位：从 "---\n" 之后那段坏区块 起，到 紧跟其后的 "## 2026-10-16\n" 之前
const startMarker = "---\n";
const startIdx = t.indexOf(startMarker) + startMarker.length;
const head = t.slice(0, startIdx);
const rest = t.slice(startIdx);
const endMarker = "\n## 2026-10-16\n";
const endIdx = rest.indexOf(endMarker);
if (startIdx <= 0 || endIdx < 0) { console.error("定位失败，未改动"); process.exit(2); }
const tail = rest.slice(endIdx + 1);            // 保留后面的 "## 2026-10-16\n…"
const fixed = head + "\n" + correct + tail.slice(tail.indexOf("\n") + 1);
fs.writeFileSync(F, fixed, "utf8");
console.log("已修复。前 26 行：");
console.log(fixed.split("\n").slice(0, 26).map((l, i) => `${String(i + 1).padStart(3)}: ${l}`).join("\n"));
