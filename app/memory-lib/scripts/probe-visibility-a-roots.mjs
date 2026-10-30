#!/usr/bin/env node
// VISIBILITY-AUDIT-1 / 线 A —— 检索根与九层容器的对照 + role 层到底怎么到达。
//
// 全部只读、纯函数调用（不起服务、不碰生产）。
//   ① 每个 scope 组合 → resolveRootsForScopes 给出哪些根
//   ② 九个容器名 → 哪些能由某个 scope 到达（有根），哪些根本没有根
//   ③ role 层的到达方式：self-root（D4F1） vs memory/agent 作用域 vs 无
import path from "node:path";
import { CONTAINERS, pathContainer } from "../src/container-policy.mjs";
import { resolveRootsForScopes, createMemoryLib } from "../src/memory-lib.mjs";

const dataRoot = path.join("D:\\MemoryLib", "sc2-realdata-copy", "memory");
const workspaceRoot = path.join("D:\\MemoryLib", "sc2-realdata-copy");
const rel = (r) => {
  const p = typeof r === "string" ? r : r?.path;
  const relative = path.relative(dataRoot, p);
  return relative === "" ? "(dataRoot 顶层)" : relative.replaceAll("\\", "/");
};

const out = {};

// ───────── ① 逐个 scope 分支 ─────────
const scopeCases = [
  ["memory/shared", { layer: "memory", visibility: "shared" }],
  ["memory/project(pilot)", { layer: "memory", visibility: "project", project: "pilot" }],
  ["memory/project(*)", { layer: "memory", visibility: "project", project: "*" }],
  ["memory/agent(pilot-01)", { layer: "memory", visibility: "agent", project: "pilot-01" }],
  ["memory/agent(*)", { layer: "memory", visibility: "agent", project: "*" }],
  ["memory/user(project=u)", { layer: "memory", visibility: "user", project: "u" }],
  ["memory/platform", { layer: "memory", visibility: "platform" }],
  ["memory/daily", { layer: "memory", visibility: "daily" }],
  ["memory/episodic", { layer: "memory", visibility: "episodic" }],
  ["role(layer=role)", { layer: "role", visibility: "role" }],
  ["role(visibility=role)", { layer: "memory", visibility: "role" }],
  ["knowledge/shared", { layer: "knowledge", visibility: "shared" }],
  ["tool", { layer: "tool" }],
  ["plan", { layer: "plan" }],
  ["graph", { layer: "graph", visibility: "project", project: "p" }],
  ["temporary", { layer: "temporary", visibility: "private" }],
  ["unknown/recovery", { layer: "recovery", visibility: "shared" }],
];
out["① 每个 scope 解析出的根"] = scopeCases.map(([label, scope]) => ({
  scope: label,
  roots: resolveRootsForScopes([scope], dataRoot, workspaceRoot).map(rel),
}));

// ───────── ② 九个容器 ← 哪个 scope 能给到根 ─────────
// 用一个"探针路径"落进各容器，看哪些 scope 的根集合**包含**它。
const probe = {
  temporary: path.join(dataRoot, "temporary", "x.md"),
  evidence: path.join(dataRoot, "evidence", "conversations", "x.md"),
  "long-term": path.join(dataRoot, "curated", "shared", "x.md"),
  project: path.join(dataRoot, "project-state", "p", "x.md"),
  tool: path.join(dataRoot, "tools-memory", "x.md"),
  graph: path.join(dataRoot, "graph", "x.md"),
  plan: path.join(dataRoot, "plans", "x.md"),
  role: path.join(dataRoot, "curated", "agents", "someone", "x.md"),
  knowledge: path.join(dataRoot, "evidence", "documents", "x.md"),
};
const allScopes = scopeCases.filter(([label]) => !label.startsWith("unknown")).map(([label, scope]) => [label, scope]);
out["② 容器 → 哪些 scope 能给出覆盖它的根"] = Object.entries(probe).map(([container, filePath]) => {
  const covering = allScopes.filter(([, scope]) => {
    const roots = resolveRootsForScopes([scope], dataRoot, workspaceRoot);
    return roots.some((root) => {
      const rootPath = typeof root === "string" ? root : root.path;
      return filePath.startsWith(rootPath + path.sep) || filePath === rootPath;
    });
  }).map(([label]) => label);
  return { container, pathContainer: pathContainer(dataRoot, filePath), 有根的scope: covering, 无任何scope: covering.length === 0 };
});

// ───────── ③ role 层的到达方式 ─────────
// 三问：自己 agent 的 role 记忆靠谁到达；别的 agent 的；同 agent 不同 role 的。
const baseScopes = [{ layer: "memory", visibility: "shared" }];
const rootsFor = (scopes, agentId) => {
  const lib = createMemoryLib({ dataRoot, workspaceRoot, scopes, agentId, vectorLane: { probe: false } });
  return lib.roots.map(rel);
};
out["③ role 层到达方式（memory/shared 作用域下）"] = {
  "无 agentId": rootsFor(baseScopes, undefined),
  "agentId=pilot-01（D4F1 self-root）": rootsFor(baseScopes, "pilot-01"),
  "agentId=someone-else": rootsFor(baseScopes, "someone-else"),
  "memory/agent 作用域（显式授权别人的目录）": resolveRootsForScopes([{ layer: "memory", visibility: "agent", project: "other-agent" }], dataRoot, workspaceRoot).map(rel),
  "memory/agent(*) （全部 agent 目录）": resolveRootsForScopes([{ layer: "memory", visibility: "agent", project: "*" }], dataRoot, workspaceRoot).map(rel),
};

console.log(JSON.stringify({ containers: CONTAINERS, ...out }, null, 2));
