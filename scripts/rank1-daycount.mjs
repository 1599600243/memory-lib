#!/usr/bin/env node
/**
 * RANK-1：按天条数（只读）。用空 query + calendarDate 把**整天**翻页取全，
 * 打印 total_count 与实取条数 —— 用于对齐"按天问不得显著恶化"的口径。
 *
 *   node scripts/rank1-daycount.mjs --api http://127.0.0.1:8787 --days 2026-10-04,2026-10-19
 *   node scripts/rank1-daycount.mjs --api http://127.0.0.1:8788 --days 2026-10-19 --search-mode formal
 *
 * 只调 /v1/search，不写任何东西。口径说明写在报告的 §九。
 */
import fs from "node:fs/promises";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const API = String(arg("api", "http://127.0.0.1:8787")).replace(/\/+$/, "");
const DAYS = String(arg("days", "2026-10-04,2026-10-19")).split(",").map((s) => s.trim()).filter(Boolean);
const TZ = String(arg("timezone", "Asia/Shanghai"));
const LIMIT = Number(arg("limit", 100));
const MAX_PAGES = Number(arg("max-pages", 200));
const MODE = arg("search-mode", null);
const PATCH = arg("patch", "C:\\Users\\admin\\.dsh\\profiles\\web\\cordis.patch.yml");
const AGENT = String(arg("agent", "pilot-01"));
const ROLE = String(arg("role", "reader"));

const yml = await fs.readFile(PATCH, "utf8");
const ref = yml.match(/X-MCP-Credential-Ref:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
const secret = yml.match(/X-MCP-Secret:\s*['"]?([^'"\r\n]+)/)?.[1]?.trim();
if (!ref || !secret) throw new Error(`拿不到凭据（${PATCH}）`);

console.log(`api=${API}  timezone=${TZ}  limit=${LIMIT}  searchMode=${MODE ?? "(默认)"}`);
for (const day of DAYS) {
  let cursor = null;
  let got = 0;
  let total = null;
  let pages = 0;
  do {
    const body = {
      credential_ref: ref,
      secret,
      principal: { agent_id: AGENT, role_id: ROLE },
      query: "",
      calendarDate: day,
      calendarTimezone: TZ,
      limit: LIMIT,
      ...(MODE ? { searchMode: MODE } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const res = await fetch(`${API}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`${day}: HTTP ${res.status} ${text.slice(0, 200)}`);
      break;
    }
    const j = JSON.parse(text);
    total = j.total_count ?? j.total ?? null;
    const items = Array.isArray(j.results) ? j.results : Array.isArray(j.items) ? j.items : [];
    got += items.length;
    pages += 1;
    cursor = j.nextCursor ?? j.next_cursor ?? null;
    if (!items.length) break;
  } while (cursor && pages < MAX_PAGES);
  console.log(`${day}: total_count=${total}  实取=${got}  页数=${pages}  ${total != null && total !== got ? "⚠️ 未取全" : ""}`);
}
