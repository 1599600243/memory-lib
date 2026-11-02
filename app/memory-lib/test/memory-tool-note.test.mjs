import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolsMemory, TOOL_SECTIONS } from "../src/tools-memory.mjs";

const PRINCIPAL = {
  tenant_id: "default", framework_id: "f", agent_id: "admin-01", role_id: "librarian-admin",
  group_id: "home-circle", user_id: "user-owner",
};

function sections(overrides = {}) {
  const base = {
    用途: "把代码库变成可查询的符号图",
    接入方式: "uv tool install graphifyy; graphify extract <repo> --code-only --no-cluster",
    关键参数: "extract --code-only 不调 LLM；update 增量约 8s",
    已知坑: "中文自然语言 query 基本无效",
    验证方式: "graphify god-nodes 能列出枢纽",
  };
  return { ...base, ...overrides };
}

async function fixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tool-note-"));
  return { dataRoot, tools: createToolsMemory({ dataRoot }) };
}

test("writes a tool note with all five sections and lists it", async () => {
  const { dataRoot, tools } = await fixture();
  const result = await tools.putToolNote({
    tool_name: "graphify", kind: "cli", env: "win-local",
    sections: sections(), evidence_refs: ["conversation-a"], principal: PRINCIPAL,
  });
  assert.equal(result.tool_name, "graphify", JSON.stringify(result));
  assert.equal(result.status, "active", JSON.stringify(result));
  const file = path.join(dataRoot, "tools-memory", "graphify.md");
  const text = await fs.readFile(file, "utf8");
  for (const heading of TOOL_SECTIONS) assert.match(text, new RegExp(`## ${heading}`), `missing section ${heading}`);
  assert.match(text, /visibility: "platform"/u);
  const listed = await tools.listTools({ principal: PRINCIPAL });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tool_name, "graphify");
});

test("rejects a note missing one of the five sections", async () => {
  const { tools } = await fixture();
  const bad = sections();
  delete bad["已知坑"];
  await assert.rejects(
    () => tools.putToolNote({ tool_name: "broken", sections: bad, evidence_refs: ["conversation-a"], principal: PRINCIPAL }),
    /section "已知坑" is required/u,
  );
});

test("same tool name merges instead of creating a duplicate file", async () => {
  const { dataRoot, tools } = await fixture();
  await tools.putToolNote({ tool_name: "dbx", sections: sections(), evidence_refs: ["conversation-a"], principal: PRINCIPAL });
  await tools.putToolNote({ tool_name: "dbx", sections: sections({ 已知坑: "连接超时要用 127.0.0.1 而不是 localhost" }), evidence_refs: ["conversation-b"], principal: PRINCIPAL });
  const files = await fs.readdir(path.join(dataRoot, "tools-memory"));
  assert.deepEqual(files.filter((name) => name.endsWith(".md")), ["dbx.md"]);
  const listed = await tools.listTools({ principal: PRINCIPAL });
  assert.equal(listed.length, 1);
});
