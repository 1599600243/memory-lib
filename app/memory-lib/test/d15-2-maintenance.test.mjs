import { test } from "node:test";
import assert from "node:assert/strict";
import { createMaintenanceScheduler } from "../src/maintenance-scheduler.mjs";

test("daily and monthly use configured retention defaults while allowing one-shot cold overrides", async () => {
  const calls = [];
  const scheduler = createMaintenanceScheduler({ retentionDays: { daily: 90, monthly: 60 }, now: () => Date.parse("2026-10-14T12:00:00Z"), librarian: { run: async (options) => { calls.push(options); return { status: "completed", cold: 0 }; } } });
  await scheduler.run("daily");
  await scheduler.run("monthly");
  await scheduler.run("daily", { force: true, cold: { olderThanDays: 12 } });
  assert.equal(calls[0].cold.olderThanDays, 90);
  assert.equal(calls[1].cold.olderThanDays, 60);
  assert.equal(calls[2].cold.olderThanDays, 12);
});

test("daily and monthly are independently triggerable and idempotent per period", async () => {
  let calls = [];
  const scheduler = createMaintenanceScheduler({ now: () => Date.parse("2026-10-14T12:00:00Z"), librarian: { run: async (options) => { calls.push(options); return { status: "completed", cold: 1 }; } } });
  const daily = await scheduler.run("daily");
  assert.equal(daily.mode, "daily");
  assert.equal((await scheduler.run("daily")).reason, "maintenance-period-already-completed");
  const monthly = await scheduler.run("monthly");
  assert.equal(monthly.mode, "monthly");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].patrol_type, "daily");
  assert.equal(calls[1].patrol_type, "monthly");
});
