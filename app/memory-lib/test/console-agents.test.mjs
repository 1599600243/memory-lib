import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { aggregateAgents } from "../web/console-agents.mjs";

const consoleHtml = await fs.readFile(new URL("../web/console.html", import.meta.url), "utf8");
const agentsModule = await fs.readFile(new URL("../web/console-agents.mjs", import.meta.url), "utf8");

test("Agents tab renders explicit states, selectable windows, and denied badges", () => {
  assert.match(consoleHtml, /data-tab="agents"[^>]*>Agents</u);
  assert.match(consoleHtml, /统计范围（最近 N 条审计事件）/u);
  assert.match(consoleHtml, /改它会改变所有计数/u);
  assert.match(consoleHtml, /id="agentsLimit"[\s\S]*value="200"[\s\S]*value="1000"/u);
  assert.doesNotMatch(consoleHtml, /value="5000"/u);
  assert.match(consoleHtml, /请求 \$\{requestedLimit\} 条，实际返回 \$\{summary\.total\} 条/u);
  assert.match(consoleHtml, /当前身份不能查看审计日志/u);
  assert.match(consoleHtml, /没有事件/u);
  assert.match(consoleHtml, /badge\(`拒绝 \$\{row\.denied\}`[\s\S]*"b-deny"/u);
  assert.match(consoleHtml, /deniedActions/u);
  assert.match(consoleHtml, /import\("\.\/console-agents\.mjs"\)/u);
  assert.match(consoleHtml, /post\("\/v1\/admin\/audit", \{ limit \}\)/u);
});
const events = [
  { ts: "2026-10-27T00:00:00.000Z", channel: "mcp", framework: "deepseek-harness", agent: "pilot-01", role: "reader", action: "search", allow: true },
  { ts: "2026-10-27T00:05:00.000Z", channel: "localhost", framework: "deepseek-harness", agent: "pilot-01", role: "reader", action: "recall_brief", allow: true },
  { ts: "2026-10-27T00:10:00.000Z", channel: "mcp", framework: "deepseek-harness", agent: "pilot-01", role: "reader", action: "search", allow: false },
  { ts: "2026-10-26T23:00:00.000Z", channel: "mcp", framework: "cursor", agent: "worker-2", role: "capture-ingest", action: "write", allow: true },
  { ts: "not-a-date", channel: "mcp", framework: "cursor", agent: "worker-2", role: "capture-ingest", action: "write", allow: true },
];

test("the console embeds the exact tested LF-only ES module because the fixed server has no asset route", () => {
  assert.doesNotMatch(agentsModule, /\r\n/u, "console-agents.mjs line-ending mismatch: expected LF-only text; check .gitattributes and git add --renormalize");
  const match = consoleHtml.match(/"\.\/console-agents\.mjs":"data:text\/javascript;base64,([A-Za-z0-9+/=]+)"/u);
  assert.ok(match, "console must map the module specifier to a no-request data module");
  assert.equal(Buffer.from(match[1], "base64").toString("utf8"), agentsModule, "embedded module must exactly match the LF-only source file");
});

test("the existing 18 console tabs remain present beside Agents", () => {
  const tabs = [...consoleHtml.matchAll(/<button data-tab="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(tabs.length, 19);
  assert.deepEqual(tabs.filter((tab) => tab !== "agents"), [
    "health", "search", "episodes", "tools", "projects", "plans", "profile", "roles", "graph", "ingest",
    "pet", "runtime", "learning", "knowledge", "evidence", "recovery", "registry", "audit",
  ]);
});

test("aggregateAgents groups identities and exposes exact sample coverage", () => {
  const result = aggregateAgents(events);
  assert.equal(result.total, 5);
  assert.equal(result.denied, 1);
  assert.equal(result.from, "2026-10-26T23:00:00.000Z");
  assert.equal(result.to, "2026-10-27T00:10:00.000Z");
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(({ framework, agent, role, calls }) => ({ framework, agent, role, calls })), [
    { framework: "deepseek-harness", agent: "pilot-01", role: "reader", calls: 3 },
    { framework: "cursor", agent: "worker-2", role: "capture-ingest", calls: 2 },
  ]);
});

test("aggregateAgents counts denied actions, top three actions, and channels", () => {
  const result = aggregateAgents(events);
  const reader = result.rows[0];
  assert.equal(reader.denied, 1);
  assert.equal(reader.last, "2026-10-27T00:10:00.000Z");
  assert.deepEqual(reader.topActions, [
    { action: "search", count: 2 },
    { action: "recall_brief", count: 1 },
  ]);
  assert.deepEqual(reader.deniedActions, [{ action: "search", count: 1 }]);
  assert.deepEqual(reader.channels, [
    { channel: "mcp", count: 2 },
    { channel: "localhost", count: 1 },
  ]);
});

test("aggregateAgents separates identity-free system events from unauthenticated denials", () => {
  const input = [
    { ts: "2026-10-27T01:00:00.000Z", channel: "refinement", action: "refinement_alert", allow: true },
    { ts: "2026-10-27T01:01:00.000Z", channel: "localhost", action: "/health", allow: false },
  ];
  const before = structuredClone(input);
  const result = aggregateAgents(input);
  assert.deepEqual(input, before);
  assert.equal(result.rows.length, 2);

  const system = result.rows.find((row) => row.agent === "系统事件（无身份）");
  assert.deepEqual(system, {
    framework: "-", agent: "系统事件（无身份）", role: "-", calls: 1, denied: 0,
    last: "2026-10-27T01:00:00.000Z",
    topActions: [{ action: "refinement_alert", count: 1 }],
    deniedActions: [],
    channels: [{ channel: "refinement", count: 1 }],
  });

  const unauthenticated = result.rows.find((row) => row.agent === "未认证/被拒请求");
  assert.deepEqual(unauthenticated, {
    framework: "-", agent: "未认证/被拒请求", role: "-", calls: 1, denied: 1,
    last: "2026-10-27T01:01:00.000Z",
    topActions: [{ action: "/health", count: 1 }],
    deniedActions: [{ action: "/health", count: 1 }],
    channels: [{ channel: "localhost", count: 1 }],
  });
});
