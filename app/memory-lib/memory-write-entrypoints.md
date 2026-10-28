# Markdown Memory Write Entrypoints

This inventory is the contract for durable Markdown writers. Any new Markdown writer must add one row here and one case to `test/m1-4-write-entrypoints.test.mjs`.

| Source | Entry | Layer/container | Real triggers | tenant_id |
|---|---|---|---|---|
| `src/write-memory.mjs` | `createMemoryWriter().write` | curated-shared -> long-term; agent -> role; project-progress -> project | HTTP `/v1/memory/write`, MCP `memory_write`, internal writer | yes, `principal.tenant_id ?? "default"` |
| `src/write-memory.mjs` | `createMemoryWriter().writeProgress` | project | HTTP `/v1/write` with `layer=project-progress`, internal project progress and learning/project flows | yes, through project writer frontmatter preservation |
| `src/write-memory.mjs` | `createMemoryWriter().mergeEvidenceRefs` | rewrite in place: keeps the existing memory's layer/container and unions `evidence_refs` | HTTP `/v1/refinement/jobs/submit` (same `stable_key` + equivalent body); internal callers | preserves `tenant_id` (in-place rewrite of an existing file) |
| `src/refinement-jobs.mjs` | `submit` | job target layer -> project layers (`project-state` / `project-decision` / `project-progress`) or `curated-shared`; delegates to the writer below | HTTP `/v1/refinement/jobs/submit` (write / merge / supersede by `stable_key`); internal submit callers | yes, through the delegated writer (`principal.tenant_id ?? "default"`) |
| `src/project-memory.mjs` | `putCurrentState` | project | HTTP `/v1/project/state`, MCP/project service, internal | yes, `principal.tenant_id ?? "default"` |
| `src/project-memory.mjs` | `appendDecision` | project | HTTP `/v1/project/decision`, MCP/project service, internal | yes, `principal.tenant_id ?? "default"` |
| `src/plans-memory.mjs` | `writePlan` | plan | HTTP `/v1/plan/write`, MCP `memory_plan_put`, internal | yes, `principal.tenant_id ?? "default"` |
| `src/plans-memory.mjs` | `transition` | plan | `confirm`, `done`, `abandon` are internal/MCP service calls; no localhost HTTP route exists | preserves/defaults `tenant_id`; each variant is tested |
| `src/tools-memory.mjs` | `putToolNote` | tool | HTTP `/v1/tools/note`, MCP `memory_tool_note`, internal | yes, `principal.tenant_id ?? "default"` |
| `src/tools-memory.mjs` | `refreshStatus` | tool | maintenance/internal only; no localhost HTTP route exists | preserves/defaults `tenant_id`; no real HTTP trigger exists |
| `src/role-memory.mjs` | `putRoleNote` | role | HTTP `/v1/roles/note`, MCP `memory_role_note`, internal; near-duplicate HTTP writes trigger merge rewrite | yes, `tenant_id ?? "default"` |
| `src/role-memory.mjs` | `evidence merge/supersede rewrites` | role | role writer dedupe/supersedes | preserves/defaults `tenant_id` |
| `src/profile-memory.mjs` | `confirm` | long-term | HTTP `/v1/profile/confirm` with admin key, MCP profile confirmation, internal | preserves/defaults `tenant_id` and long-term container |
| `src/migrate-memory.mjs` | `applyMigration` | migration of legacy roots | CLI only, never HTTP | writes explicit default tenant |

Storage-only Markdown operations are intentionally separate from searchable memory writers: `src/evidence-recovery.mjs` writes evidence storage, and `src/conversation-memory.mjs`, `src/transcript-importer.mjs`, and `src/memory-ingest.mjs` write event/ingest artifacts or imported documents with their own contracts. They are not silently treated as the nine-layer durable memory writer contract.
