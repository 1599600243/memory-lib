import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.mjs";

const modes = ["daily", "monthly"];

export function createMaintenanceScheduler({ librarian, dataRoot = null, now = () => Date.now(), retentionDays = {} } = {}) {
  const configuredRetention = {
    daily: Number.isInteger(retentionDays.daily) && retentionDays.daily > 0 ? retentionDays.daily : 90,
    monthly: Number.isInteger(retentionDays.monthly) && retentionDays.monthly > 0 ? retentionDays.monthly : 60,
  };
  if (!librarian || typeof librarian.run !== "function") throw new Error("maintenance scheduler requires librarian");
  let running = false;
  const lastRun = { daily: null, monthly: null };
  const reportDir = dataRoot ? path.join(dataRoot, "runtime", "maintenance") : null;
  const currentPeriod = (mode, at = now()) => new Date(at).toISOString().slice(0, mode === "monthly" ? 7 : 10);
  const runIdFor = (mode, period) => `librarian-${mode}-${period}`;
  function nextPeriod(mode, period) {
    if (mode === "daily") return new Date(Date.parse(`${period}T00:00:00.000Z`) + 86_400_000).toISOString();
    const [year, month] = period.split("-").map(Number);
    return new Date(Date.UTC(year, month, 1)).toISOString();
  }
  async function readReport(mode, period) {
    if (!reportDir) return null;
    const run_id = runIdFor(mode, period);
    try {
      const report = JSON.parse(await fs.readFile(path.join(reportDir, `${run_id}.json`), "utf8"));
      return report?.status === "completed" ? { ...report, run_id, mode, period } : null;
    } catch { return null; }
  }
  async function latestReport(mode, period) {
    const current = await readReport(mode, period);
    if (current) return current;
    if (!reportDir) return null;
    let names;
    try { names = await fs.readdir(reportDir); } catch { return null; }
    const prefix = `librarian-${mode}-`;
    const candidates = names.filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort().reverse();
    for (const name of candidates) {
      try {
        const report = JSON.parse(await fs.readFile(path.join(reportDir, name), "utf8"));
        if (report?.status === "completed") return { ...report, mode, run_id: name.slice(0, -5), period: report.period ?? name.slice(prefix.length, -5) };
      } catch { /* ignore incomplete/corrupt reports */ }
    }
    return null;
  }
  async function status(mode = "daily", at = now()) {
    if (!modes.includes(mode)) throw new Error("maintenance mode must be daily or monthly");
    const period = currentPeriod(mode, at);
    const report = await readReport(mode, period);
    const last = report ?? await latestReport(mode, period);
    const due = report ? nextPeriod(mode, period) : `${period}${mode === "monthly" ? "-01" : ""}T00:00:00.000Z`;
    return {
      mode, period, run_id: runIdFor(mode, period),
      last_success_at: last?.finished_at ?? last?.completed_at ?? null,
      last_run_at: last?.started_at ?? last?.finished_at ?? null,
      next_due_at: due,
      overdue: !report,
      completed: Boolean(report),
    };
  }
  async function writeReport(mode, run_id, period, result) {
    if (!reportDir) return null;
    const reportPath = path.join(reportDir, `${run_id}.json`);
    // ATOMICWRITE-1：收敛到统一助手（含建目录）。
    await atomicWriteFile(reportPath, JSON.stringify({ ...result, mode, run_id, period }, null, 2));
    return reportPath;
  }
  async function run(mode = "daily", options = {}) {
    if (!modes.includes(mode)) throw new Error("maintenance mode must be daily or monthly");
    if (running) return { status: "skipped", reason: "maintenance-run-in-progress", mode };
    running = true;
    try {
      const period = currentPeriod(mode);
      const run_id = options.run_id ?? runIdFor(mode, period);
      if (!options.force && (lastRun[mode] === run_id || await readReport(mode, period))) return { status: "skipped", reason: "maintenance-period-already-completed", mode, run_id, period };
      let result = await librarian.run({ ...options, patrol_type: mode, run_id, cold: { ...(options.cold ?? {}), olderThanDays: options.cold?.olderThanDays ?? configuredRetention[mode] } });
      const reportPath = await writeReport(mode, run_id, period, result);
      if (result.status === "completed") lastRun[mode] = run_id;
      return { ...result, mode, run_id, period, ...(reportPath ? { report_path: reportPath } : {}) };
    } finally { running = false; }
  }
  async function runDue(mode = "daily", options = {}) {
    const state = await status(mode);
    if (!state.overdue) return { status: "skipped", reason: "maintenance-period-already-completed", mode, run_id: state.run_id, period: state.period };
    return run(mode, options);
  }
  return { run, runDue, status, lastRun, retentionDays: { ...configuredRetention } };
}
