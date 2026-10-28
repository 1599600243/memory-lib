// 部署后：看清 INDEX-1 的走哪条路（candidate_source/候选数/scan_ms）+ 5 种问法位次
import fs from "node:fs";

const y = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = y.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = y.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const ANS = "curated-shared-466787238d86faef";
const QS = [
  "记忆库几层", "记忆库是几层", "记忆库有几层？", "我们记忆库分几层", "记忆库一共几层",
  "昨天做了什么", "8层", "验收", "提炼", "完全无关的问题测试",
];

const ask = async (q) => {
  const t0 = performance.now();
  const r = await fetch("http://127.0.0.1:8787/v1/recall/brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential_ref: ref, secret,
      principal: { agent_id: "pilot-01", role_id: "reader" },
      format: "prompt", query: q, memory_only: true, memory_limit_chars: 600,
    }),
  });
  const j = await r.json();
  return { ms: Math.round(performance.now() - t0), j };
};

console.log("问句".padEnd(20) + "耗时  source  候选  scan_ms  命中  8层位次");
for (const q of QS) {
  const { ms, j } = await ask(q);
  const inc = j.included ?? [];
  const pos = inc.findIndex((m) => m.id === ANS) + 1;
  console.log(
    q.padEnd(20) +
      String(ms).padStart(4) + "ms  " +
      String(j.candidate_source ?? "-").padEnd(6) + "  " +
      String(j.candidate_files ?? "-").padStart(4) + "  " +
      String(j.scan_ms ?? "-").padStart(7) + "  " +
      String(inc.length).padStart(4) + "  " +
      (pos || "未进"),
  );
  if (j.candidate_reason) console.log(`                      reason=${j.candidate_reason}`);
}
