// Deterministic librarian maintenance. Tidy work never invokes a consolidator or model.
// Recall counters are optionally flushed/read, then archival and cold-layer maintenance run.
export function createLibrarianBatch({ archiver = null, coldLayer = null, recallStats = null, countFor = null, audit = null } = {}) {
  let running = false;

  const emptyArchive = { archived: 0, items: [] };
  const emptyCold = { cold: 0, items: [], refresh_candidates: [] };

  async function inventory() {
    if (typeof coldLayer?.inventory === "function") return await coldLayer.inventory();
    return { cold: 0, byLayer: {} };
  }

  async function recallCounts() {
    if (typeof recallStats?.listCounts === "function") return await recallStats.listCounts();
    return {};
  }

  async function run(options = {}) {
    if (running) return { status: "skipped", reason: "librarian-run-in-progress" };
    running = true;
    const startedAt = new Date().toISOString();
    try {
      const recallUpdate = typeof recallStats?.update === "function" && options.updateRecall !== false
        ? await recallStats.update()
        : null;
      const counts = await recallCounts();
      const before = await inventory();

      const archived = typeof archiver?.archive === "function"
        ? await archiver.archive(options.archive ?? {})
        : emptyArchive;
      const cold = typeof coldLayer?.cold === "function"
        ? await coldLayer.cold(options.cold ?? {})
        : emptyCold;

      const after = await inventory();
      const cleanupCandidates = typeof coldLayer?.cleanupCandidates === "function"
        ? await coldLayer.cleanupCandidates(options.cleanup ?? {})
        : [];
      const borrowedTop = Object.entries(counts)
        .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
        .slice(0, Number(options.topN ?? 10))
        .map(([path, count]) => ({ path, count }));
      const coldItems = Array.isArray(cold?.items) ? cold.items : [];
      const retired = (archived?.archived ?? 0) + (cold?.cold ?? 0);
      const visibleDelta = (after?.visible ?? 0) - (before?.visible ?? 0);
      const finishedAt = new Date().toISOString();
      const report = {
        type: options.patrol_type ?? "daily",
        started_at: startedAt,
        finished_at: finishedAt,
        new_items: [],
        borrowed_top: borrowedTop,
        zero_recall: coldItems.filter((item) => Number(item.recallCount ?? item.recall_count ?? 0) === 0).length,
        cold_added: cold?.cold ?? 0,
        cold_total: after?.cold ?? 0,
        cold_skipped: cold?.skipped ?? {},
        cleanup_candidates: cleanupCandidates.length,
      };
      const result = {
        status: "completed",
        partial: false,
        failed_batches: [],
        retries: 0,
        batches: 0,
        rejected: {},
        kind_mapped: 0,
        batch_details: [],
        model: null,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Date.now() - Date.parse(startedAt),
        run_id: options.run_id ?? `librarian-${Date.now()}`,
        trigger: options.trigger ?? "manual",
        recall_update: recallUpdate,
        produced: 0,
        merged: 0,
        staled: 0,
        archived: archived?.archived ?? 0,
        cold: cold?.cold ?? 0,
        refreshed: 0,
        deprecated: 0,
        superseded: 0,
        archived_items: archived,
        cold_items: cold,
        cleanup_candidates: cleanupCandidates,
        report,
        inventory_before: before,
        inventory_after: after,
        cold_inventory: after,
        audit_count: retired,
        compression: { input: 0, retired, produced: 0, visible_delta },
        count_for_available: typeof countFor === "function",
      };
      if (typeof audit?.record === "function") {
        await audit.record({
          channel: "librarian",
          action: "maintenance",
          allow: true,
          result: { archived: result.archived, cold: result.cold, visible_delta: visibleDelta, cleanup_candidates: cleanupCandidates.length },
        });
      }
      return result;
    } catch (error) {
      if (typeof audit?.record === "function") {
        await audit.record({ channel: "librarian", action: "maintenance", allow: false, denyReason: "LIBRARIAN_FAILED", error: String(error?.message ?? error).slice(0, 500) });
      }
      return {
        status: "failed",
        partial: false,
        failed_batches: [],
        retries: 0,
        batches: 0,
        rejected: {},
        kind_mapped: 0,
        batch_details: [],
        model: null,
        error: String(error?.message ?? error),
      };
    } finally {
      running = false;
    }
  }

  return { run };
}
