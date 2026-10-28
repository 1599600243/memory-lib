// 给 dsh-sandbox 打"空 justification 视为未请求"补丁（DSH 升级后会丢，重跑即可）
// 背景：gpt-5.6-sol 会给 pwsh/write/edit 填满可选字段，justification 填空串 ⇒
//      validateEscalationArgs 抛 "invalid justification: expected a non-empty sentence" ⇒ 模型原地重试。
// 0.2.1-rc.2 只修了"同档请求放行"，没修空 justification，所以这半个补丁仍需要。
// 用法: node scripts/patch-dsh-sandbox-justification.mjs [--check]
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:\\AI\\deepseek-harness\\node_modules\\.pnpm";
const MARK = "PATCH-IS-emptyjustify";

function findCopies(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (!e.isDirectory()) continue;
    if (e.name === "dsh-sandbox" && fs.existsSync(path.join(p, "lib", "index.js"))) out.push(path.join(p, "lib", "index.js"));
    if (e.name === "node_modules" || e.name.startsWith("@")) findCopies(p, out);
  }
  return out;
}

const files = findCopies(ROOT);
if (!files.length) { console.error("找不到 dsh-sandbox 副本"); process.exit(1); }
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const checkOnly = process.argv.includes("--check");

const NEEDLE =
  '\tif (sandboxPermissions !== void 0 && justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");';
const REPLACE =
  `\t// ${MARK}: 没有有效 justification 就当"没请求升权"（0.2.1-rc.2 仍会抛错，模型会原地重试）\n` +
  `\tif (typeof justification !== "string" || justification.trim().length === 0) { sandboxPermissions = void 0; justification = void 0; }`;

let patched = 0, already = 0, missing = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  if (src.includes(MARK)) { already++; continue; }
  if (!src.includes(NEEDLE)) {
    console.log(`✗ 目标代码未匹配（版本变了？）: ${path.relative(ROOT, f)}`);
    missing++;
    continue;
  }
  if (checkOnly) { console.log(`需要打补丁: ${path.relative(ROOT, f)}`); continue; }
  fs.copyFileSync(f, `${f}.bak-justify-${ts}`);
  fs.writeFileSync(f, src.replace(NEEDLE, REPLACE), "utf8");
  patched++;
  console.log(`✓ ${path.relative(ROOT, f)}  (备份 .bak-justify-${ts})`);
}
console.log(`\n副本 ${files.length} 份：新打补丁 ${patched} / 已有补丁 ${already} / 未匹配 ${missing}（checkOnly=${checkOnly}）`);
