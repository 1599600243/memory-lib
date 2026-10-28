# F3 dry-run / actual reproducible evidence

The server makes the same auto-review decision in `dry-run` and `actual` mode, but only
`actual` changes the candidate. The audit whitelist records the candidate id, decision,
rule, and `dryRun` flag; it never contains candidate text, credentials, or tokens.

## Parity semantics

Candidate ids are random per capture, so a dry-run and an actual run of the same event can
never be paired by `resourceId`. The audit contract carries only decision metadata, so the
parity check that matters is whether the two modes produced the **same multiset of
`(decision, rule)` verdicts** for the same candidate set. `scripts/auto-review-dry-run-compare.mjs`
aggregates by `(decision, rule)` and reports `AUTO_REVIEW_DRY_RUN_MATCH` (exit 0) only when
every `(decision, rule)` pair has equal counts in both modes.

## Reproduction

Drive the real `createAutoReview` router in both modes against the same fixed candidates,
writing each mode's audit lines to its own JSONL file, then compare:

```powershell
node scripts\auto-review-dry-run-compare.mjs --audit <dry-audit.jsonl> --audit <actual-audit.jsonl>
```

The regression seam that pins the comparator behaviour lives in the test suite:

```text
node --test test/review-rate.test.mjs
node --test test/auto-review.test.mjs
```

## Raw output (real run)

Three fixed candidates (a process fragment, an ordinary statement, a long-term conclusion)
were routed through `createAutoReview` in `dry-run` and `actual` mode. Raw audit lines
(`channel: "auto-review"`, decision metadata only):

```text
-- dry-run audit lines --
{"channel":"auto-review","action":"auto-review","scope":null,"resourceId":"cand-proc","allow":true,"denyReason":null,"decision":"reject","rule":"process-fragment-reject","dryRun":true}
{"channel":"auto-review","action":"auto-review","scope":null,"resourceId":"cand-ordinary","allow":true,"denyReason":null,"decision":"leave","rule":null,"dryRun":true}
{"channel":"auto-review","action":"auto-review","scope":null,"resourceId":"cand-valuable","allow":true,"denyReason":null,"decision":"promote","rule":"high-value-promote","dryRun":true}

-- actual audit lines --
{"channel":"auto-review","action":"auto-review","scope":null,"resourceId":"cand-proc","allow":true,"denyReason":null,"decision":"reject","rule":"process-fragment-reject","dryRun":false}
{"channel":"auto-review","action":"auto-review","scope":null,"resourceId":"cand-ordinary","allow":true,"denyReason":null,"decision":"leave","rule":null,"dryRun":false}
{"channel":"auto-review","action":"auto-review","scope":null,"resourceId":"cand-valuable","allow":true,"denyReason":null,"decision":"promote","rule":"high-value-promote","dryRun":false}
```

Comparator output:

```text
{
  "pairs": [
    { "decision": "leave", "rule": null, "dryRun": 1, "actual": 1 },
    { "decision": "promote", "rule": "high-value-promote", "dryRun": 1, "actual": 1 },
    { "decision": "reject", "rule": "process-fragment-reject", "dryRun": 1, "actual": 1 }
  ],
  "mismatches": [],
  "missing": []
}
AUTO_REVIEW_DRY_RUN_MATCH
```

Exit code 0. Every `(decision, rule)` pair has equal dry-run and actual counts, and the
`resourceId` values differ across the two runs without affecting the comparison.

This is evidence for policy parity and audit shape only. It is not a production deployment
and it does not decide the D2 governance question about whether automatic `promote` should
be retained or narrowed to `reject`/`leave`.
