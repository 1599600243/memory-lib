# RETRIEVAL-1 FIX4 Development Report

## 1. Scope and acceptance result

FIX4 only was implemented. The top-level `health` classification used by public `GET /v1/health` and authenticated `POST /v1/admin/health` now comes from one shared function in `src/localhost-server.mjs`.

The public endpoint's existing semantics were preserved exactly:

```js
(indexEstablished && indexCoverage < 0.98) || index.failed > 0
  ? "degraded"
  : baseHealth
```

Acceptance conclusion: **PASS**. 运维无论看哪个 health 端点，对“索引是否健康”得到的结论一致。

No deployment, production service restart, production data access, visibility-policy change, container-policy change, or unrelated route refactor was performed.

## 2. Baseline comparison

### Baseline

```text
Repository: app/memory-lib
Baseline HEAD: 5cbbebcff29e2e56f5cffcaf27e9513bb75fbd60
Baseline worktree: clean (`git status --short` produced no output)
Node.js: v24.18.0
Git: git version 2.52.0.windows.1
```

At baseline:

- Public `GET /v1/health` degraded when an established index had coverage below `0.98`, or when `index.failed > 0`.
- Authenticated `POST /v1/admin/health` degraded only when `index.failed > 0`.
- Therefore, with an established index at 1/3 coverage and `failed=0`, public returned `degraded` while admin returned `healthy`.

### After FIX4

- One shared `healthStatusFor(baseHealth, index)` implements the former public classification.
- Both health routes call that shared function.
- The existing shared `buildIndexSection()` remains the source of both routes' `index` section.
- A permanent real-HTTP regression test creates only temporary data, establishes a successful 1/3 index (`failed=0`), calls both routes, and checks:
  - identical top-level `health`;
  - both are `degraded`;
  - identical complete `index` field sets;
  - identical complete `index` values.
- The new test is included in `scripts/run-tests.mjs` and therefore in `npm test`.

## 3. Changed files

- `src/localhost-server.mjs`
  - Added the shared top-level health classifier.
  - Replaced the public route's inline classification with a call to it.
  - Replaced the admin route's narrower classification with a call to it.
- `test/health-consistency.test.mjs`
  - Added the permanent real-HTTP regression using a temporary `dataRoot`.
- `scripts/run-tests.mjs`
  - Added the new test to the formal sequential runner.

## 4. Impact list

| Possible effect | Verification | Result |
|---|---|---|
| Public low-coverage semantics might change | Regression fixture creates an established index with `indexed_files=1`, `library_files=3`, `failed=0`; asserts public `health === "degraded"` | PASS; prior public semantics preserved |
| Admin may still disagree with public | Same real server and state are queried through public GET and authenticated admin POST; top-level values compared | PASS; both return `degraded` |
| Public/admin `index` payloads might drift | Complete sorted key sets and complete objects are deep-compared | PASS; identical fields and values |
| Index failure behavior from FIX3 might regress | `node test\index-failure-health.test.mjs` | PASS |
| Existing public low-coverage coverage test might regress | `node test\slice2.test.mjs` | PASS, 22/22 |
| Vector-lane health behavior might regress | Formal full runner includes `vector-lane-health.test.mjs` | PASS, 13/13 |
| New regression might not run formally | Confirmed entry in `scripts/run-tests.mjs`; executed by `npm test` | PASS |
| Change might affect unrelated repository behavior | Full formal `npm test` rerun | PASS, `ALL TEST FILES PASSED` |
| Test could mutate production data | Test uses `fs.mkdtemp(os.tmpdir())`, derives `workspaceRoot` and `dataRoot` under it, and removes it in `finally` | PASS; production data untouched |
| Patch could contain whitespace/syntax errors | `git diff --check`; `node --check` for changed JS files | PASS |

## 5. TDD evidence: red then green

### Red: target defect reproduced before implementation

Command:

```powershell
node test\health-consistency.test.mjs
```

Raw output:

```text
✖ public and admin health agree while an established index is catching up (324.6118ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 329.7219

✖ failing tests:

test at test\health-consistency.test.mjs:14:1
✖ public and admin health agree while an established index is catching up (324.6118ms)
  AssertionError [ERR_ASSERTION]: public and admin health conclusions must agree
  + actual - expected

  + 'healthy'
  - 'degraded'

      at TestContext.<anonymous> (file:///D:/MemoryLib/app/memory-lib/test/health-consistency.test.mjs:84:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1332:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'healthy',
    expected: 'degraded',
    operator: 'strictEqual',
    diff: 'simple'
  }
[exit code: 1]
```

### Green: same test after shared classification

Command:

```powershell
node test\health-consistency.test.mjs
```

Raw output:

```text
[FIX4-HEALTH-CONSISTENCY] {"public":{"health":"degraded","index":{"indexed_files":1,"raw_indexed_files":0,"library_files":3,"pending_changes":2,"last_indexed_at":"2026-10-09T15:39:00.333Z","last_index_ms":null,"failed":0,"lifecycle":{"accepted":true,"stored":true,"indexed":true,"searchable":false,"failed":false,"last_error":null},"skipped_sensitive":0,"skipped_sensitive_paths":[],"interval_minutes":10,"last_status":null,"last_error":null,"last_trigger":null,"last_trigger_at":null,"incremental_failure":null}},"admin":{"health":"degraded","index":{"indexed_files":1,"raw_indexed_files":0,"library_files":3,"pending_changes":2,"last_indexed_at":"2026-10-09T15:39:00.333Z","last_index_ms":null,"failed":0,"lifecycle":{"accepted":true,"stored":true,"indexed":true,"searchable":false,"failed":false,"last_error":null},"skipped_sensitive":0,"skipped_sensitive_paths":[],"interval_minutes":10,"last_status":null,"last_error":null,"last_trigger":null,"last_trigger_at":null,"incremental_failure":null}},"equal":true}
✔ public and admin health agree while an established index is catching up (264.9014ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 268.5699
```

## 6. Focused verification raw output

Command:

```powershell
node --check src\localhost-server.mjs
node --check test\health-consistency.test.mjs
node test\index-failure-health.test.mjs
node test\health-consistency.test.mjs
node test\slice2.test.mjs
```

Raw result summary (syntax checks are silent on success):

```text
[FIX3-INDEX-HEALTH-EVIDENCE] {"capture":{"status":"failed","lifecycle":["accepted","stored","failed"],"indexError":"unable to open database file"},"storedById":200,"adminHealth":{"health":"degraded","index":{"indexed_files":0,"raw_indexed_files":0,"library_files":2,"pending_changes":2,"last_indexed_at":null,"last_index_ms":null,"failed":1,"lifecycle":{"accepted":true,"stored":true,"indexed":false,"searchable":false,"failed":true,"last_error":"unable to open database file"},"skipped_sensitive":0,"skipped_sensitive_paths":[],"interval_minutes":10,"last_status":"failed","last_error":"unable to open database file","last_trigger":"capture","last_trigger_at":"2026-10-09T15:34:43.418Z","incremental_failure":"unable to open database file"}},"publicAdminIndexAgree":true}
✔ authenticated admin health exposes index failure when sqlite path occupied by a directory
ℹ tests 1
ℹ pass 1
ℹ fail 0

[FIX4-HEALTH-CONSISTENCY] ... "public":{"health":"degraded" ... "failed":0 ...},"admin":{"health":"degraded" ... "failed":0 ...},"equal":true
✔ public and admin health agree while an established index is catching up
ℹ tests 1
ℹ pass 1
ℹ fail 0

✔ construction rejects non-loopback host
✔ GET /v1/health works without auth, returns minimal info
✔ GET /v1/health degrades when an established index has low coverage
...
✔ server ops are zero-write on the data root
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

## 7. Formal runner

Final command:

```powershell
npm test
```

Final raw tail:

```text
=== health-consistency.test.mjs ===
[FIX4-HEALTH-CONSISTENCY] {"public":{"health":"degraded","index":{"indexed_files":1,"raw_indexed_files":0,"library_files":3,"pending_changes":2,"last_indexed_at":"2026-10-09T15:38:08.627Z","last_index_ms":null,"failed":0,"lifecycle":{"accepted":true,"stored":true,"indexed":true,"searchable":false,"failed":false,"last_error":null},"skipped_sensitive":0,"skipped_sensitive_paths":[],"interval_minutes":10,"last_status":null,"last_error":null,"last_trigger":null,"last_trigger_at":null,"incremental_failure":null}},"admin":{"health":"degraded","index":{"indexed_files":1,"raw_indexed_files":0,"library_files":3,"pending_changes":2,"last_indexed_at":"2026-10-09T15:38:08.627Z","last_index_ms":null,"failed":0,"lifecycle":{"accepted":true,"stored":true,"indexed":true,"searchable":false,"failed":false,"last_error":null},"skipped_sensitive":0,"skipped_sensitive_paths":[],"interval_minutes":10,"last_status":null,"last_error":null,"last_trigger":null,"last_trigger_at":null,"incremental_failure":null}},"equal":true}
✔ public and admin health agree while an established index is catching up (284.3764ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 289.267

...

=== m1-6-daily-write.test.mjs ===
✔ M1.6 shared and user writes enforce principal scope and become searchable immediately (369.2598ms)
✔ M1.6 invalid visibility and platform escalation are rejected (42.8133ms)
✔ M1.6 three consecutive writes are all indexed by the write response (305.9884ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 734.4892

ALL TEST FILES PASSED
```

The final formal run executed every file listed in `scripts/run-tests.mjs` sequentially and exited successfully.

## 8. Out-of-scope findings (not fixed)

1. During the first full `npm test` run, unrelated `m1-4-http-writer-e2e.test.mjs` had a Windows temporary-directory atomic rename failure:

   ```text
   EPERM: operation not permitted, rename '...progress.md.<pid>.<uuid>.tmp' -> '...progress.md'
   ```

   It was not in the FIX4 diff and was not modified. An immediate isolated rerun passed all 3 tests, and the subsequent full formal rerun also passed. This is recorded as a transient Windows filesystem/test-environment observation, not a FIX4 defect.

2. Existing expected stderr diagnostics from credential-store and zh-summary fallback tests remain present. They are asserted/known behavior and were not changed.

3. Existing code indentation around the admin-health switch case is uneven. It was not opportunistically reformatted because FIX4 required narrow route semantics only.

## 9. Rollback method

FIX4 is isolated in one implementation commit. To roll back without rewriting history:

```powershell
git revert c61df512a6de200428ea13ecffe7712da721ba67
```

If the report-only commit also needs removal, revert that later report commit separately. Product deployment remains a separate product-owned action.

## 10. Environment (raw)

Command:

```powershell
$PSVersionTable.PSVersion.ToString()
node --version
npm --version
git --version
(Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty Caption)
git rev-parse HEAD
git status --short
```

Raw output immediately after the implementation commit:

```text
7.4.13
v24.18.0
11.16.0
git version 2.52.0.windows.1
Microsoft Windows 10 专业版
c61df512a6de200428ea13ecffe7712da721ba67
```

The absent line after the SHA means `git status --short` was clean at that point.

## 11. Commit identity and ordering

Full implementation SHA from `git rev-parse HEAD`:

```text
c61df512a6de200428ea13ecffe7712da721ba67
```

Commit subject:

```text
fix: unify public and admin health classification
```

**Yes, a commit occurs after the report's recorded implementation SHA:** this report itself is added by one report-only commit after `c61df512a6de200428ea13ecffe7712da721ba67`. No source, test, runner, or product-behavior change occurs after that implementation SHA.
