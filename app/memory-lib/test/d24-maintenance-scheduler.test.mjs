import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMaintenanceScheduler } from "../src/maintenance-scheduler.mjs";

async function fixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-d24-"));
  return { dataRoot, reportDir: path.join(dataRoot, "runtime", "maintenance") };
}
const writeReport = async (reportDir, runId, extra = {}) => {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, `${runId}.json`), JSON.stringify({ status: "completed", finished_at: "2026-10-02T01:00:00.000Z", ...extra }));
};

test("scheduler restores today's completed report and does not rerun after restart", async () => {
  const { dataRoot, reportDir } = await fixture();
  await writeReport(reportDir, "librarian-daily-2026-10-02");
  let calls = 0;
  const scheduler = createMaintenanceScheduler({ dataRoot, now: () => Date.parse("2026-10-02T10:00:00Z"), librarian: { run: async () => { calls += 1; return { status: "completed" }; } } });
  const status = await scheduler.status("daily");
  assert.equal(status.overdue, false);
  assert.equal(status.last_success_at, "2026-10-02T01:00:00.000Z");
  assert.equal((await scheduler.runDue("daily")).status, "skipped");
  assert.equal(calls, 0);
});

test("missing current report is overdue and runDue runs once", async () => {
  const { dataRoot } = await fixture();
  let calls = 0;
  const scheduler = createMaintenanceScheduler({ dataRoot, now: () => Date.parse("2026-10-02T10:00:00Z"), librarian: { run: async () => { calls += 1; return { status: "completed", finished_at: "2026-10-02T10:01:00.000Z" }; } } });
  assert.equal((await scheduler.status("daily")).overdue, true);
  const [first, second] = await Promise.all([scheduler.runDue("daily"), scheduler.runDue("daily")]);
  assert.equal(calls, 1);
  assert.equal([first.status, second.status].filter((value) => value === "completed").length, 1);
});

test("daily and monthly due periods follow UTC boundaries", async () => {
  const { dataRoot, reportDir } = await fixture();
  await writeReport(reportDir, "librarian-daily-2026-09-30");
  await writeReport(reportDir, "librarian-monthly-2026-09");
  const scheduler = createMaintenanceScheduler({ dataRoot, now: () => Date.parse("2026-10-01T00:00:01Z"), librarian: { run: async () => ({ status: "completed" }) } });
  assert.equal((await scheduler.status("daily")).overdue, true);
  assert.equal((await scheduler.status("monthly")).overdue, true);
  const next = await scheduler.status("daily");
  assert.equal(next.next_due_at, "2026-10-01T00:00:00.000Z");
});
