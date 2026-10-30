// Legacy scheduled-task entry point retained as a pure capture trigger.
// Candidate routing belongs exclusively to the memory-lib server.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = ["poll-capture.mjs", "capture.mjs"]
  .map((name) => path.join(here, name))
  .find((file) => fs.existsSync(file));

if (!target) {
  console.error("memory capture trigger: no capture adapter found");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) {
    console.error(`memory capture trigger failed: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
