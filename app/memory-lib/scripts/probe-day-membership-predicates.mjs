#!/usr/bin/env node
// SCENARIO-2-FOLLOWUP 探针 9：把四个嫌疑判据**逐个**排除，只留一个。
//   isSearchableText / importedDocumentAuthorized / principalAuthorizesPath / resolvedRoots
// 做法：对**有资格的**身份（role_id 与条目相同）跑一个极宽的时间窗。
// 若条目在内 ⇒ 可检索性（isSearchableText）与日期语义都没问题，
// 排除只可能发生在"这个身份能不能看"（principalAuthorizesPath / resolvedRoots）。
// 注：isSearchableText 是模块私有函数，不能直接 import；宽窗枚举已包含它的效果。
import fs from "node:fs/promises";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";

const COPY = process.argv[2] ?? "D:\\MemoryLib\\sc2-realdata-copy";
const dataRoot = path.join(COPY, "memory");
const target = path.join(dataRoot, "curated", "agents", "pilot-01", "role-7c963da877417294.md");

const out = { target: path.relative(dataRoot, target) };

for (const [label, roleId] of [["researcher（与条目同 role）", "researcher"], ["reader（压测/生产读身份）", "reader"]]) {
  const principal = { framework_id: "deepseek-harness", agent_id: "pilot-01", role_id: roleId, group_id: "home-circle", user_id: "user-owner" };
  const scopes = roleId === "reader"
    ? [{ layer: "memory", visibility: "shared" }, { layer: "memory", visibility: "episodic" }]
    : [{ layer: "memory", visibility: "shared" }, { layer: "knowledge", visibility: "shared" }, { layer: "memory", visibility: "project", project: "pilot" }, { layer: "memory", visibility: "episodic" }];
  const lib = createMemoryLib({ dataRoot, workspaceRoot: COPY, principal, scopes, agentId: "pilot-01", roleId, vectorLane: { probe: false } });

  // 极宽时间窗：如果"日期语义"有问题，条目在这里也会不见。
  // ⚠️ 必须翻页取全：单页上限 100，而这里有 1000+ 条，
  //    只看第一页会得到 containsTarget=false 的**假读数**（曾经差点据此下错结论）。
  const wideSeen = [];
  let cursor = null;
  let wideTotal = null;
  for (let guard = 0; guard < 60; guard += 1) {
    const page = await lib.timeline({ since: "2000-01-01T00:00:00.000Z", until: "2100-01-01T00:00:00.000Z", cursor });
    wideTotal = page.total_count;
    wideSeen.push(...page.results);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  // 该条目所属的本地日
  const day = await lib.timeline({ since: "2026-09-23T16:00:00.000Z", until: "2026-09-24T15:59:59.999Z", calendarTimezone: "Asia/Shanghai", limit: 100 });
  out[label] = {
    wideWindow: {
      total_count: wideTotal,
      retrieved: wideSeen.length,
      complete: wideSeen.length === wideTotal,
      containsTarget: wideSeen.some((i) => i.path === target),
    },
    itsLocalDay: { total_count: day.total_count, containsTarget: day.results.some((i) => i.path === target) },
  };
}
console.log(JSON.stringify(out, null, 2));
