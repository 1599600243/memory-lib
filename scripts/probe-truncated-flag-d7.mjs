// 复现 inject1-brief-memories 的 truncated 失败，并打印 dropped 的真实 reason
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SRC = "file:///D:/MemoryLib/app/memory-lib/src/recall.mjs";
const { createRecall } = await import(SRC + "?v=" + Date.now());

const PRINCIPAL = { agent_id: "pilot-01", role_id: "reader" };
const memoryFile = ({ id, calendarDate, fact }) => `---
id: ${id}
layer: "curated-shared"
visibility: "shared"
calendarDate: "${calendarDate}"
updated_at: "${calendarDate}T00:00:00.000Z"
---
${fact}
`;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-trunc-"));
const dataRoot = path.join(root, "memory");
const shared = path.join(dataRoot, "curated", "shared");
await fs.mkdir(shared, { recursive: true });

for (let i = 0; i < 20; i += 1) {
  const name = `curated-shared-${String(i).padStart(3, "0")}`;
  const fact = `第${i}条事实：`.padEnd(120, "很长的正文内容用来把预算撑爆");
  await fs.writeFile(path.join(shared, `${name}.md`), memoryFile({ id: name, calendarDate: `2026-10-${String(i + 1).padStart(2, "0")}`, fact }), "utf8");
}

const recall = createRecall({ dataRoot, workspaceRoot: root });
const brief = await recall.recallBrief({ principal: PRINCIPAL, format: "prompt", memory_limit_chars: 600 });

console.log("memory_truncated =", brief.memory_truncated);
console.log("段落长度 =", brief.sections["近期记忆"].length);
console.log("included 条数 =", brief.included.length, " memory_used_chars =", brief.memory_used_chars);
console.log("dropped 条数 =", (brief.dropped ?? []).length);
for (const d of (brief.dropped ?? []).slice(0, 8)) console.log("  dropped:", JSON.stringify(d).slice(0, 160));
await fs.rm(root, { recursive: true, force: true });


