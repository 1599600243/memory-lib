---
name: project-graph-workflow
description: Use when indexing or querying a code project's Graphify-derived graph, including deciding whether to initialize, update, or query it.
---

# Project Graph Workflow

For a code project, run the status command the first time you enter its directory in a session:

```sh
node scripts/project-graph.mjs status --json
```

Use the reported state as the deterministic branch:

- `NEW`: run `node scripts/project-graph.mjs init --name "<project name>"`.
- `STALE`: run `node scripts/project-graph.mjs update`.
- `EXISTING`: query the current graph directly.

Before changing code, locate relevant symbols with `explain` or `affected`:

```sh
node scripts/project-graph.mjs query <symbol> --mode explain
node scripts/project-graph.mjs query <symbol> --mode affected --depth 2
```

Use `path --a A --b B` to inspect a connection between two symbols. Use Graphify's `query` mode only for keyword-oriented BFS: Chinese natural-language questions usually produce poor matches. A positional query is required, such as `node scripts/project-graph.mjs query "cache invalidation" --mode query`.

After changing code, run `node scripts/project-graph.mjs update` for the incremental graph refresh (typically about eight seconds), then use MCP `memory_write` to record one `project-decision` with the decision, reason, impact, and required nonempty `evidence_refs`.

The graph is derived data; code does not enter the memory library. Project memory consists of decisions and progress.

## CLI reference

- `status [--path <dir>] [--json]`: exit `0` for `EXISTING`, `10` for `NEW`, and `11` for `STALE`.
- `init [--path <dir>] [--name <name>] [--graph <graph.json>]`: register a project once; a duplicate exits `12`.
- `update [--path <dir>]`: incrementally refresh a registered project. Missing Graphify exits `13`; install it with `uv tool install graphifyy`.
- `query <symbol|question> [--mode explain|affected|path|query] [--a A --b B] [--depth N]`: invoke the selected Graphify query mode.
- `PROJECT_GRAPH_REGISTRY` overrides the ignored default registry at `memory-lib/var/project-graphs.json`.
