import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryLib } from "../src/memory-lib.mjs";
import { createStewardBatch } from "../src/steward-batch.mjs";

const repoRoot = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d15-e6-"));
const dataRoot = path.join(tempRoot, "memory");
const scopes = [{ layer: "memory", visibility: "shared" }];
const principal = { framework_id: "deepseek-harness", agent_id: "admin-01", role_id: "librarian-admin" };
const writer = createMemoryLib({ dataRoot, workspaceRoot: tempRoot, scopes, principal });
for (let index = 0; index < 15; index += 1) {
  await writer.propose({ content: `D15 scheduled acceptance candidate ${index}: retain auditable evidence and provenance.`, scope: scopes[0], source: "d15-e6-artifact", evidenceRefs: [`evidence:d15-e6-${index}`], confidence: "high" });
}
const runtime = {
  run: async ({ input }) => {
    const parsed = JSON.parse(input);
    return {
      run_id: "run-d15-e6-scheduled-batch-15",
      input_count: parsed.candidates.length,
      model_calls: 1,
      output: { decisions: parsed.candidates.map((candidate) => ({ id: candidate.id, relation: "neither", target_id: null, reason: "scheduled acceptance" })) },
    };
  },
};
const result = await createStewardBatch({ dataRoot, memoryFactory: () => createMemoryLib({ dataRoot, workspaceRoot: tempRoot, scopes: null }), runtime, batchSize: 15, includeLowQuality: true }).run({ trigger: "scheduled", limit: 15 });
const artifact = {
  objective: "D15 E6.1 scheduled steward acceptance",
  generated_at: new Date().toISOString(),
  trigger: result.trigger,
  batch_size: result.batch_size,
  input_count: result.input_count,
  processed: result.processed,
  status: result.status,
  runtime_run_id: result.runtime_run_id,
  log_path: result.log_path,
  candidate_count: result.candidate_count,
  valid_decision_count: result.valid_decision_count,
};
const artifactDir = path.join(repoRoot, "artifacts");
const artifactPath = path.join(artifactDir, "d15-e6-scheduled-batch-15.json");
const persistentLogPath = path.join(artifactDir, "d15-e6-scheduled-batch-15-runtime.json");
await fs.mkdir(artifactDir, { recursive: true });
if (result.log_path) await fs.copyFile(result.log_path, persistentLogPath);
artifact.log_path = persistentLogPath;
await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
console.log(JSON.stringify(artifact));
await fs.rm(tempRoot, { recursive: true, force: true });
