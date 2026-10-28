# memory-lib D29 Protocol

## Scope

D29 is a direct-write memory service. The server stores conversation evidence separately and writes durable memory only through explicit, authenticated target-layer writes. There is no candidate queue or model-mediated review/promotion workflow.

## Authentication and authorization

Authenticated requests use the configured credential reference and secret plus claimed `agent_id`/`role_id`. API-key requests derive `role_id`, `user_id`, and `group_id` from the canonical key binding; request-body identity fields are not authorization input. The server resolves framework identity, checks role action and scope, validates `evidence_refs`, and writes an audit record before responding. Learning storage remains a separate assistant API and is not a memory-lib search root.

ID1 status semantics are fixed: missing or invalid credentials return `401`; a valid credential whose role lacks the requested action returns `403`; a valid credential with sufficient action but a resource outside its visible principal scope returns `404` so resource existence is not disclosed. In particular, `/v1/project/get` returns `404` for an invisible or nonexistent project, while non-admin access to `/v1/admin/*` returns `403`.

## Identity is the authority; `mode` is a sub-dimension (product ruling, 2026-10-17)

This is a product ruling and it is normative for every read/write path in memory-lib:

1. **Identity is resolved server-side from the credential only.** `role_id`, `agent_id`, `group_id` and `user_id` come from the verified credential (or the canonical API-key binding), never from the request body. The same fields supplied by a client may only be **ignored or used to narrow**; they must never widen what the caller can see.
2. **`mode` (`companion` / `assistant` / `steward` / `learner` / `governance`) is a content sub-dimension of one identity — a sub-key or tag — not an authorization dimension.** A caller may choose a mode, but only *inside* the data that already belongs to its identity. A mode must never let a caller read another identity's data.
3. **Therefore the authoritative key of a persona is `(role_id resolved by the server, mode)`, and the authoritative key of a pet draft is `(role_id resolved by the server)`;** `mode` is only a label on a draft (`pet_mode`). Persona lookup is by identity first — a mode name is never used as a persona key, and a missing persona falls back to that identity's own built-in default, never to another identity's data.
4. **Anything fed to a model must use the persona of the identity the request was authenticated as.** No path may substitute a hard-coded or default persona for a real identity's persona.

The shared root cause of the visibility defects this contract closes is "identity became an optional parameter": a check written as `if (principal && ...)` silently *skips* ownership instead of refusing. Every such path must now **refuse** (`401` when unauthenticated, `403` when identity is missing where a scope is required, `MISSING_PRINCIPAL`/`MISSING_SCOPE` are `403`) rather than proceed unscoped.

## ID1 bootstrap sequence

A canonical role binding requires both sides: the framework registry must declare the `framework_id -> agent_id -> role_id` with its `actions` and `scopes`, and `api-keys.json` must contain the matching `role_id -> user_id -> group_id` binding. Either side alone cannot authenticate an API key.

For a new deployment, use the product bootstrap CLI against an explicit temporary or production-approved registry and key file:

```powershell
node scripts/bootstrap-api-key.mjs --registry <identity.json> --api-keys <api-keys.json> --framework <framework-id> --credential-ref <credential-ref> --agent <agent-id> --role <role-id> --group <group-id> --group-name <group-name> --user <user-id> --user-name <user-name> --role-name <role-name> --pepper <key-pepper> --dry-run
node scripts/bootstrap-api-key.mjs --registry <identity.json> --api-keys <api-keys.json> --framework <framework-id> --credential-ref <credential-ref> --agent <agent-id> --role <role-id> --group <group-id> --group-name <group-name> --user <user-id> --user-name <user-name> --role-name <role-name> --pepper <key-pepper>
```

All named arguments are required. Dry-run prints the planned registry declaration, group/user/role binding, and key path without writing. Execution is additive and idempotent for matching existing declarations; conflicting existing ids fail without changing the registry. The first key secret is returned once; the key file stores only its hash. The bootstrap does not alter existing framework credentials or historical roles.

## Active endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET/POST | `/v1/health` | Health and index status |
| POST | `/v1/search` | Search authorized D29 roots; graph expansion is enabled by default and can be disabled with `graphExpand: false` |
| POST | `/v1/search/joint` | Joint index/vector/graph retrieval with graph provenance |
| POST | `/v1/graph/query` | Read the principal-visible project graph |
| POST | `/v1/get` | Read one authorized item |
| POST | `/v1/memory/list` | List authorized items |
| POST | `/v1/write` | Direct write to a D29 layer |
| POST | `/v1/conversations/capture` / `/complete` | Storage-only conversation evidence |
| POST | `/v1/tools/note` | Direct tools-memory write |
| POST | `/v1/project/state` / `/decision` | Direct project writes |
| POST | `/v1/project/progress` | Deduplicated project progress write |
| POST | `/v1/plan/put` | Direct plan write |
| POST | `/v1/profile/confirm` | Direct profile confirmation |
| POST | `/v1/admin/*` | Administrative health, audit, registry and cold-layer operations |

Retired proposal, inbox, review, promote, knowledge-quarantine and graph workflow endpoints are not part of D29.

## Direct write contract

`POST /v1/write` accepts a validated layer and writes immediately. Supported layers are `curated-shared`, `agent`, `project-state`, `project-decision`, `project-progress`, `tool`, `plan`, `profile`, and `document`. Every write requires a non-empty `evidence_refs` array. The response identifies the layer, path, create/update result and index pending count.

Project progress uses `layer: "project-progress"`, a project name, and entries whose topics are one of the six canonical topics. Duplicate date/text entries are merged and their evidence references are combined.

## Conversation evidence

Conversation capture stores redacted source messages under `evidence/conversations`. This tree is storage-only: it is excluded from default search roots and ordinary retrieval. It does not create candidates, episodes, or durable memory. Durable facts, decisions, preferences and tasks must be written separately through `memory_write` or `/v1/write` with evidence references.

## Search roots

Default searchable roots are `curated/shared`, `curated/agents`, `project-state`, `tools-memory`, `plans`, `profile`, and `evidence/documents`. `evidence/conversations`, learning assets, runtime files, archives and live tools are excluded. File-first lexical fallback keeps a newly written item visible while the derived index catches up. Authenticated daily retrieval includes graph expansion by default and returns `matched_by`, `graph_path`, and `evidence_ids`; `graphExpand: false` disables that expansion. In parity mode without a principal, graph expansion is skipped because tenant and visibility boundaries are unavailable.

## MCP mapping

MCP `memory_search`, `memory_list`, `memory_get`, `memory_health`, `memory_write`, `memory_capture_conversation`, and `memory_capture_complete` map to the active service surface. The MCP server must not expose or emulate removed candidate/review/promotion operations.
