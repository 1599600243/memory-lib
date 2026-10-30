// 诊断：为什么 scopeCarriesIdentity 在 mcp-server.mjs:462 处没认出身份参数
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = await fs.readFile(path.join(ROOT, "mcp", "mcp-server.mjs"), "utf8");
const lines = text.split(/\r?\n/u);
const target = 462;
for (let i = target - 1; i >= 0; i -= 1) {
  const line = lines[i];
  if (/^\s*(?:export\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:async\s+)?function\s*\*|^\s*[A-Za-z_$][\w$]*\s*\(.*\)\s*=>/u.test(line)) {
    const head = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
    const cut = head.indexOf(")");
    console.log("found signature at line", i + 1, "::", JSON.stringify(cut >= 0 ? head.slice(0, cut + 1) : head.slice(0, 200)));
    console.log("has principal:", /(?:^|[^A-Za-z0-9_$])principal(?![A-Za-z0-9_$])/u.test(cut >= 0 ? head.slice(0, cut + 1) : head));
    break;
  }
}
