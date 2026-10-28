import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createLearningAssistant } from "../src/learning-agent.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d6-learning-"));
const dataRoot = path.join(root, "memory");
const learningRoot = path.join(dataRoot, "learning");
const memory = createMemoryLib({ dataRoot, workspaceRoot: root, scopes: null });
const calls = [];
const configPath = path.join(root, "agents.json");
await fs.writeFile(configPath, JSON.stringify({ learning: { agent_id: "pilot-01", role_id: "learning", scopes: [{ layer: "memory", visibility: "shared" }], tools: ["search", "get", "learning_get_plan", "learning_get_progress", "learning_list_due", "learning_get_profile"], prompt: "configured learning", model: { provider: "learning-local", model: "learning-model" }, stopWhen: 3 } }), "utf8");
const assistant = await createLearningAssistant({
  dataRoot, workspaceRoot: root, learningRoot, memoryFactory: () => memory,
  agentConfigPath: configPath,
  model: { provider: "ignored", model: "ignored" },
  llmFactory: (config) => ({ provider: config.provider, model: config.model, async run({ tools }) {
    calls.push({ provider: this.provider, model: this.model });
    const plan = await tools.learning_get_plan.execute({ topic: "JavaScript" });
    const due = await tools.learning_list_due.execute({});
    return JSON.stringify({ plan, due });
  } }),
});
await assistant.learning.putPlan("JavaScript", { modules: [{ id: "m1", title: "基础" }] });

after(async () => fs.rm(root, { recursive: true, force: true }));

test("learning assistant uses shared runtime with learning-specific tools and logs", async () => {
  const result = await assistant.run("安排今天的学习");
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { provider: "learning-local", model: "learning-model" });
  const runs = await assistant.runtime.listRuns({ agent: "learning" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agent, "learning");
  assert.equal(runs[0].role_id, "learning");
  assert.deepEqual(runs[0].tools, ["search", "get", "learning_get_plan", "learning_get_progress", "learning_list_due", "learning_get_profile"]);
  assert.match(result.output, /JavaScript/);
});
