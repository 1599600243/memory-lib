// RANK-1 部署后验证：新字段 + 5 种问法下"8 层"那条的位次 + 注入块
import fs from "node:fs";

const yml = fs.readFileSync("C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml", "utf8");
const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();

const ask = async (q) => {
  const r = await fetch("http://127.0.0.1:8787/v1/recall/brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credential_ref: ref,
      secret,
      principal: { agent_id: "pilot-01", role_id: "reader" },
      format: "prompt",
      query: q,
      memory_only: true,
      memory_limit_chars: 600,
    }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, j, t };
};

const QS = ["记忆库几层", "记忆库是几层", "记忆库有几层？", "我们记忆库分几层", "记忆库一共几层"];
const ANS = "curated-shared-466787238d86faef";
let first = true;
for (const q of QS) {
  const { status, j } = await ask(q);
  if (!j) { console.log(`${q}: HTTP ${status} 无 JSON`); continue; }
  const inc = j.included ?? j.memories ?? [];
  const pos = inc.findIndex((m) => m.id === ANS) + 1;
  const keys = Object.keys(j).join(",");
  const incKeys = inc[0] ? Object.keys(inc[0]).join(",") : "-";
  console.log(`${q}`);
  console.log(`   HTTP ${status}  命中 ${inc.length}  8层位次=${pos || "未进"}  dropped=${j.dropped ?? "-"} answer_first=${j.answer_first ?? "-"} count_unit=${j.count_unit ?? "-"} used=${j.memory_used_chars ?? "-"}`);
  console.log(`   响应字段: ${keys}`);
  console.log(`   included[0] 字段: ${incKeys}`);
  if (first) {
    first = false;
    const block = j.block ?? j.text ?? "";
    console.log(`   ── 注入文本（${String(block).length} 字）──`);
    console.log(String(block).split("\n").map((l) => "   " + l).join("\n"));
  }
  console.log("");
}
